import {
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpFailure,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpScheduleTaskResult,
  ScheduledTaskId,
  TrimmedNonEmptyString,
  type AuthMcpClientAccess,
  type OrchestratorMcpScheduledTask,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { readLiveServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  launchModelSelection,
  modelSelectionFlags,
  resolveProject,
  ThreadProjectNotFoundError,
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  ThreadUsageError,
  type ThreadTools,
} from "./thread.ts";

const ScheduleCliError = Schema.Union([
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  ThreadUsageError,
  ThreadProjectNotFoundError,
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

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeScheduleTools = (session: McpToolSession, origin: string): ThreadTools => {
  const unexpected = (tool: string) =>
    new ThreadToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.schedule.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ThreadServerUnreachableError | ThreadToolFailedError> {
      const raw = yield* session
        .call(tool, args)
        .pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ThreadToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};

const withScheduleTools = Effect.fn("cli.schedule.withScheduleTools")(function* <A, E, R>(
  flags: {
    readonly baseDir: Option.Option<string>;
    readonly json: boolean;
    readonly access: AuthMcpClientAccess;
  },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const minimumLogLevel = flags.json ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readLiveServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 schedule cli",
        access: flags.access,
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
    }).pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
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

const readPrompt = Effect.fn("cli.schedule.readPrompt")(function* (argument: string) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ThreadUsageError({ detail: "The prompt is empty." });
  }
  return text;
});

const parseWeekdays = Effect.fn("cli.schedule.parseWeekdays")(function* (raw: string) {
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return yield* new ThreadUsageError({
      detail: "--weekdays must list comma-separated digits from 0 (Sunday) to 6 (Saturday).",
    });
  }
  const days: Array<number> = [];
  for (const part of parts) {
    if (!/^[0-6]$/.test(part)) {
      return yield* new ThreadUsageError({
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
    return yield* new ThreadUsageError({
      detail: "Pass only one of --time, --every-ms, or --once.",
    });
  }
  if (triggers === 0) {
    if (Option.isSome(flags.weekdays)) {
      return yield* new ThreadUsageError({ detail: "--weekdays requires --time <HH:MM>." });
    }
    if (flags.required) {
      return yield* new ThreadUsageError({
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
    return yield* new ThreadUsageError({ detail: "--weekdays requires --time <HH:MM>." });
  }
  if (Option.isSome(flags.everyMs)) {
    return { type: "interval" as const, everyMs: flags.everyMs.value };
  }
  return { type: "once" as const, runAt: Option.getOrThrow(flags.once) };
});

const resolveBooleanToggle = Effect.fn("cli.schedule.resolveBooleanToggle")(function* (
  enableFlag: boolean,
  disableFlag: boolean,
  enableName: string,
  disableName: string,
  createDefault: boolean | undefined,
) {
  if (enableFlag && disableFlag) {
    return yield* new ThreadUsageError({
      detail: `Pass at most one of ${enableName} or ${disableName}.`,
    });
  }
  if (enableFlag) return true;
  if (disableFlag) return false;
  return createDefault;
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
      () => new ThreadUsageError({ detail: `'${value}' is not a scheduled task id.` }),
    ),
  );
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

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
      { ...flags, access: "read-only" },
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
  noFreshSession: Flag.Boolean("no-fresh-session").pipe(
    Flag.withDescription("Disable fresh-session reuse when updating an existing task."),
    Flag.withDefault(false),
  ),
  enabled: Flag.Boolean("enabled").pipe(
    Flag.withDescription("Ensure the task is enabled."),
    Flag.withDefault(false),
  ),
  disabled: Flag.Boolean("disabled").pipe(
    Flag.withDescription("Save the task paused instead of enabled."),
    Flag.withDefault(false),
  ),
  runtimeMode: Flag.Literals("runtime-mode", RUNTIME_MODES).pipe(
    Flag.withDescription(
      "Permission mode saved on a new scheduled task (default: auto). Ignored on updates.",
    ),
    Flag.withDefault("auto"),
  ),
  ...modelSelectionFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Create a scheduled task, or update an existing one with --id."),
  Command.withHandler((flags) =>
    withScheduleTools(
      { ...flags, access: Option.isSome(flags.id) ? "full-access" : flags.runtimeMode },
      Effect.fn("cli.schedule.upsert")(function* (tools) {
        const scheduledTaskId = Option.isSome(flags.id)
          ? yield* decodeScheduledTaskId(flags.id.value)
          : undefined;
        const isUpdate = scheduledTaskId !== undefined;
        const enabled = yield* resolveBooleanToggle(
          flags.enabled,
          flags.disabled,
          "--enabled",
          "--disabled",
          isUpdate ? undefined : true,
        );
        const freshSession = yield* resolveBooleanToggle(
          flags.freshSession,
          flags.noFreshSession,
          "--fresh-session",
          "--no-fresh-session",
          isUpdate ? undefined : false,
        );
        const prompt = yield* readPrompt(flags.prompt);
        const schedule = yield* buildScheduleInput({
          time: flags.time,
          weekdays: flags.weekdays,
          everyMs: flags.everyMs,
          once: flags.once,
          required: !isUpdate,
        });
        const title = Option.isSome(flags.title)
          ? yield* decodeTitle(flags.title.value).pipe(
              Effect.mapError(() => new ThreadUsageError({ detail: "--title cannot be empty." })),
            )
          : undefined;
        const modelSelection = yield* launchModelSelection(flags);
        const project = yield* resolveProject(tools, flags.project);
        if (scheduledTaskId !== undefined) {
          const existing = yield* tools.call(
            "list_scheduled_tasks",
            { scheduledTaskId },
            OrchestratorMcpListScheduledTasksResult,
          );
          const match = existing.tasks[0];
          if (match === undefined) {
            return yield* new ThreadUsageError({
              detail: `No scheduled task '${scheduledTaskId}' was found.`,
            });
          }
          if (match.projectId !== project.id) {
            return yield* new ThreadUsageError({
              detail: `Scheduled task '${scheduledTaskId}' belongs to project '${match.projectId}', not '${project.id}'.`,
            });
          }
        }
        const saved = yield* tools.call(
          "schedule_task",
          {
            ...(scheduledTaskId === undefined ? {} : { scheduledTaskId }),
            projectId: project.id,
            prompt,
            ...(schedule === undefined ? {} : { schedule }),
            ...(title === undefined ? {} : { title }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(freshSession === undefined ? {} : { freshSession }),
            ...(modelSelection === undefined
              ? {}
              : {
                  target: {
                    providerInstanceId: modelSelection.instanceId,
                    model: modelSelection.model,
                    ...(modelSelection.options === undefined
                      ? {}
                      : { options: modelSelection.options }),
                  },
                }),
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
      { ...flags, access: "full-access" },
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
