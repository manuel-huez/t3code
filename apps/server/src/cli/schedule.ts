import {
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  ProjectId,
  ScheduledTaskId,
  TrimmedNonEmptyString,
  type OrchestratorMcpScheduledTask,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { expandHomePath } from "../os-jank.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

class ScheduleServerNotRunningError extends Schema.TaggedError<ScheduleServerNotRunningError>()(
  "ScheduleServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running T3 Code server uses ${this.baseDir}. Start T3 Code, then retry.`;
  }
}

class ScheduleServerUnreachableError extends Schema.TaggedError<ScheduleServerUnreachableError>()(
  "ScheduleServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the T3 Code server at ${this.origin}.${reason}`;
  }
}

class ScheduleToolFailedError extends Schema.TaggedError<ScheduleToolFailedError>()(
  "ScheduleToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

class ScheduleUsageError extends Schema.TaggedError<ScheduleUsageError>()("ScheduleUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

class ScheduleProjectNotFoundError extends Schema.TaggedError<ScheduleProjectNotFoundError>()(
  "ScheduleProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No T3 Code project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

const ScheduleCliError = Schema.Union([
  ScheduleServerNotRunningError,
  ScheduleServerUnreachableError,
  ScheduleToolFailedError,
  ScheduleUsageError,
  ScheduleProjectNotFoundError,
]);
const isScheduleCliError = Schema.is(ScheduleCliError);

const reportScheduleErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isScheduleCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const printJson = (value: unknown) => Console.log(encodeJson(value));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeScheduleTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new ScheduleToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.schedule.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ScheduleServerUnreachableError | ScheduleToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new ScheduleServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ScheduleToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
type ScheduleTools = ReturnType<typeof makeScheduleTools>;

const withScheduleTools = Effect.fn("cli.schedule.withScheduleTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (tools: ScheduleTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const minimumLogLevel = flags.json ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ScheduleServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 schedule cli",
        access: "full-access",
        peerLink: false,
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-schedule-cli",
    }).pipe(Effect.mapError((cause) => new ScheduleServerUnreachableError({ origin, cause })));
    return yield* run(makeScheduleTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const listAllProjects = Effect.fn("cli.schedule.listAllProjects")(function* (tools: ScheduleTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "t3_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

const resolveProject = Effect.fn("cli.schedule.resolveProject")(function* (
  tools: ScheduleTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const matching = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    })
    .toSorted((left, right) => right.root.length - left.root.length);
  const best = matching[0];
  if (best !== undefined) return best.project;
  return yield* new ScheduleProjectNotFoundError({ identifier });
});

const readPrompt = Effect.fn("cli.schedule.readPrompt")(function* (argument: string) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ScheduleUsageError({ detail: "The prompt is empty." });
  }
  return text;
});

const parseWeekdays = Effect.fn("cli.schedule.parseWeekdays")(function* (raw: string) {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return yield* new ScheduleUsageError({
      detail: "--weekdays must list comma-separated digits from 0 (Sunday) to 6 (Saturday).",
    });
  }
  const days: Array<number> = [];
  for (const part of parts) {
    if (!/^[0-6]$/.test(part)) {
      return yield* new ScheduleUsageError({
        detail: `Invalid weekday '${part}'. Use 0 (Sunday) through 6 (Saturday).`,
      });
    }
    const day = Number(part);
    if (!days.includes(day)) days.push(day);
  }
  return days;
});

const buildScheduleInput = Effect.fn("cli.schedule.buildScheduleInput")(function* (flags: {
  readonly time: Option.Option<string>;
  readonly weekdays: Option.Option<string>;
  readonly everyMs: Option.Option<number>;
  readonly once: Option.Option<string>;
  readonly required: boolean;
}) {
  const triggers =
    Number(Option.isSome(flags.time)) +
    Number(Option.isSome(flags.everyMs)) +
    Number(Option.isSome(flags.once));
  if (triggers > 1) {
    return yield* new ScheduleUsageError({
      detail: "Pass only one of --time, --every-ms, or --once.",
    });
  }
  if (triggers === 0) {
    if (Option.isSome(flags.weekdays)) {
      return yield* new ScheduleUsageError({ detail: "--weekdays requires --time <HH:MM>." });
    }
    if (flags.required) {
      return yield* new ScheduleUsageError({
        detail: "Pass one trigger: --time <HH:MM>, --every-ms <ms>, or --once <iso>.",
      });
    }
    return undefined;
  }
  if (Option.isSome(flags.time)) {
    const weekdays = Option.isSome(flags.weekdays)
      ? yield* parseWeekdays(flags.weekdays.value)
      : undefined;
    return {
      type: "fixed_time" as const,
      timeOfDay: flags.time.value,
      ...(weekdays === undefined ? {} : { weekdays }),
    };
  }
  if (Option.isSome(flags.weekdays)) {
    return yield* new ScheduleUsageError({ detail: "--weekdays requires --time <HH:MM>." });
  }
  if (Option.isSome(flags.everyMs)) {
    return { type: "interval" as const, everyMs: flags.everyMs.value };
  }
  return { type: "once" as const, runAt: Option.getOrThrow(flags.once) };
});

const formatTaskLine = (task: OrchestratorMcpScheduledTask) => {
  const state = task.enabled ? "enabled" : "paused ";
  const mode = task.freshSession ? "fresh" : task.boundThreadId !== null ? "bound" : "new  ";
  return `${task.scheduledTaskId}  ${state}  ${mode}  ${task.title}`;
};

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);

const decodeScheduledTaskIdValue = Schema.decodeUnknownEffect(ScheduledTaskId);
const decodeScheduledTaskId = (value: string) =>
  decodeScheduledTaskIdValue(value.trim()).pipe(
    Effect.mapError(
      () => new ScheduleUsageError({ detail: `'${value}' is not a scheduled task id.` }),
    ),
  );
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);

const scheduleListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Filter to one project id or path inside the project."),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List scheduled tasks."),
  Command.withHandler((flags) =>
    withScheduleTools(
      flags,
      Effect.fn("cli.schedule.list")(function* (tools) {
        const project = Option.isSome(flags.project)
          ? yield* resolveProject(tools, flags.project.value)
          : undefined;
        const result = yield* tools.call(
          "list_scheduled_tasks",
          project === undefined ? {} : { projectId: project.id },
          OrchestratorMcpListScheduledTasksResult,
        );
        if (flags.json) {
          return yield* printJson(result.tasks);
        }
        for (const task of result.tasks) {
          yield* Console.log(formatTaskLine(task));
        }
      }),
    ).pipe(reportScheduleErrors),
  ),
);

const scheduleUpsertCommand = Command.make("upsert", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  prompt: Argument.String("prompt").pipe(
    Argument.withDescription("Prompt to run, or - to read it from stdin."),
  ),
  id: Flag.String("id").pipe(
    Flag.withDescription("Existing scheduled task id to update in place."),
    Flag.optional,
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Task title."), Flag.optional),
  time: Flag.String("time").pipe(
    Flag.withDescription("Run daily at local HH:MM (24-hour)."),
    Flag.optional,
  ),
  weekdays: Flag.String("weekdays").pipe(
    Flag.withDescription("Comma-separated weekdays for --time (0=Sun..6=Sat)."),
    Flag.optional,
  ),
  everyMs: Flag.Int("every-ms").pipe(
    Flag.withDescription("Run on a fixed interval in milliseconds."),
    Flag.optional,
  ),
  once: Flag.String("once").pipe(
    Flag.withDescription("Run once at an ISO-8601 timestamp with offset."),
    Flag.optional,
  ),
  freshSession: Flag.Boolean("fresh-session").pipe(
    Flag.withDescription("Reuse one thread across runs, starting a fresh session each run."),
    Flag.withDefault(false),
  ),
  disabled: Flag.Boolean("disabled").pipe(
    Flag.withDescription("Save the task paused instead of enabled."),
    Flag.withDefault(false),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a scheduled task, or update an existing one with --id."),
  Command.withHandler((flags) =>
    withScheduleTools(
      flags,
      Effect.fn("cli.schedule.upsert")(function* (tools) {
        const scheduledTaskId = Option.isSome(flags.id)
          ? yield* decodeScheduledTaskId(flags.id.value)
          : undefined;
        const prompt = yield* readPrompt(flags.prompt);
        const schedule = yield* buildScheduleInput({
          time: flags.time,
          weekdays: flags.weekdays,
          everyMs: flags.everyMs,
          once: flags.once,
          required: scheduledTaskId === undefined,
        });
        const title = Option.isSome(flags.title)
          ? yield* decodeTitle(flags.title.value).pipe(
              Effect.mapError(() => new ScheduleUsageError({ detail: "--title cannot be empty." })),
            )
          : undefined;
        const project = yield* resolveProject(tools, flags.project);
        const saved = yield* tools.call(
          "schedule_task",
          {
            ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
            projectId: project.id,
            prompt,
            ...(schedule === undefined ? {} : { schedule }),
            ...(title === undefined ? {} : { title }),
            enabled: !flags.disabled,
            freshSession: flags.freshSession,
          },
          OrchestratorMcpScheduleTaskResult,
        );
        if (flags.json) {
          return yield* printJson(saved);
        }
        yield* Console.log(formatTaskLine(saved));
      }),
    ).pipe(reportScheduleErrors),
  ),
);

const scheduleDeleteCommand = Command.make("delete", {
  ...projectLocationFlags,
  id: Argument.String("scheduled-task-id").pipe(
    Argument.withDescription("Scheduled task id, from `t3 schedule list`."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Delete a scheduled task."),
  Command.withHandler((flags) =>
    withScheduleTools(
      flags,
      Effect.fn("cli.schedule.delete")(function* (tools) {
        const scheduledTaskId = yield* decodeScheduledTaskId(flags.id);
        const result = yield* tools.call(
          "delete_scheduled_task",
          { scheduledTaskId },
          OrchestratorMcpDeleteScheduledTaskResult,
        );
        if (flags.json) {
          return yield* printJson(result);
        }
        yield* Console.log(
          result.deleted
            ? `Deleted ${result.scheduledTaskId}.`
            : `No scheduled task ${result.scheduledTaskId}.`,
        );
      }),
    ).pipe(reportScheduleErrors),
  ),
);

export const scheduleCommand = Command.make("schedule").pipe(
  Command.withDescription(
    "List, create, update, and delete scheduled tasks on the running server.",
  ),
  Command.withSubcommands([scheduleListCommand, scheduleUpsertCommand, scheduleDeleteCommand]),
);
