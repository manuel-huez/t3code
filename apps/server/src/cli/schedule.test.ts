import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, ScheduledTaskId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { scheduleCommand } from "./schedule.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const projectId = ProjectId.make("proj-remote-agents");
const taskId = ScheduledTaskId.make("task-dream-1");

const sampleTask = {
  scheduledTaskId: taskId,
  title: "Nightly Dream",
  prompt: "Read tools/t3-dream/RUNBOOK.md",
  enabled: true,
  projectId,
  boundThreadId: null,
  freshSession: true,
  schedule: { type: "fixed_time" as const, timeOfDay: "03:00" },
  nextRunAt: "2026-11-24T03:00:00.000Z",
  lastRunStatus: "never" as const,
};

const cliTestLayer = (cwd: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    NetService.layer,
    TestConsole.layer,
    Layer.succeed(HostProcess.WorkingDirectory, cwd),
  );

it.effect("list, upsert (fresh-session), and delete dispatch through MCP tools", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-schedule-cli-" })
      .pipe(Effect.flatMap((dir) => fs.realPath(dir)));
    const workspaceRoot = path.join(root, "remote-agents");
    const baseDir = path.join(root, "state");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3_773,
      }),
    });

    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          calls.push({ tool, args });
          switch (tool) {
            case "t3_project_list":
              return Effect.succeed({
                structuredContent: {
                  projects: [{ id: projectId, title: "remote-agents", workspaceRoot }],
                  nextCursor: null,
                },
              });
            case "list_scheduled_tasks":
              return Effect.succeed({ structuredContent: { tasks: [sampleTask] } });
            case "schedule_task":
              return Effect.succeed({ structuredContent: sampleTask });
            case "delete_scheduled_task":
              return Effect.succeed({
                structuredContent: { scheduledTaskId: taskId, deleted: true },
              });
            default:
              return Effect.die(`unexpected ${tool} call`);
          }
        },
      }),
    );

    const run = Command.runWith(scheduleCommand, { version: "0.0.0" });
    yield* run(["list", "--base-dir", baseDir, "--project", workspaceRoot, "--json"]);
    yield* run([
      "upsert",
      "--base-dir",
      baseDir,
      "--title",
      "Nightly Dream",
      "--time",
      "03:00",
      "--fresh-session",
      "--json",
      workspaceRoot,
      "Read tools/t3-dream/RUNBOOK.md",
    ]);
    yield* run(["delete", "--base-dir", baseDir, "--json", taskId]);

    assert.deepEqual(
      calls.filter((c) => c.tool !== "t3_project_list"),
      [
        { tool: "list_scheduled_tasks", args: { projectId } },
        {
          tool: "schedule_task",
          args: {
            projectId,
            prompt: "Read tools/t3-dream/RUNBOOK.md",
            schedule: { type: "fixed_time", timeOfDay: "03:00" },
            title: "Nightly Dream",
            enabled: true,
            freshSession: true,
          },
        },
        { tool: "delete_scheduled_task", args: { scheduledTaskId: taskId } },
      ],
    );
  }).pipe(Effect.provide(cliTestLayer(process.cwd()))),
);
