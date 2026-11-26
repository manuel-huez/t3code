import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  ProjectId,
  ScheduledTaskId,
  type AuthMcpClientAccess,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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

const issuedAccessLevels: Array<AuthMcpClientAccess> = [];

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: (input) => {
        issuedAccessLevels.push(input.access);
        return Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        }));
      },
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const projectId = ProjectId.make("proj-remote-agents");
const otherProjectId = ProjectId.make("proj-other");
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

it.effect("list, upsert, update preservation, ownership guard, and delete work over MCP", () =>
  Effect.gen(function* () {
    issuedAccessLevels.length = 0;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-schedule-cli-" })
      .pipe(Effect.flatMap((dir) => fs.realPath(dir)));
    const workspaceRoot = path.join(root, "remote-agents");
    const otherRoot = path.join(root, "other-repo");
    const baseDir = path.join(root, "state");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    yield* fs.makeDirectory(otherRoot, { recursive: true });
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
                  projects: [
                    { id: projectId, title: "remote-agents", workspaceRoot },
                    { id: otherProjectId, title: "other-repo", workspaceRoot: otherRoot },
                  ],
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
    const afterListLines = yield* TestConsole.logLines;
    assert.deepEqual(JSON.parse(String(afterListLines[0])), [sampleTask]);

    yield* run([
      "upsert",
      "--base-dir",
      baseDir,
      "--title",
      "Nightly Dream",
      "--time",
      "03:00",
      "--fresh-session",
      "--runtime-mode",
      "full-access",
      "--json",
      workspaceRoot,
      "Read tools/t3-dream/RUNBOOK.md",
    ]);

    // Prompt-only update omits enabled and freshSession so paused/fresh settings stay untouched.
    yield* run([
      "upsert",
      "--base-dir",
      baseDir,
      "--id",
      taskId,
      "--json",
      workspaceRoot,
      "Updated prompt only",
    ]);

    // Updating a task id under the wrong project fails before calling schedule_task.
    const mismatch = yield* Effect.exit(
      run([
        "upsert",
        "--base-dir",
        baseDir,
        "--id",
        taskId,
        "--json",
        otherRoot,
        "Wrong project prompt",
      ]),
    );
    assert.isTrue(Exit.isFailure(mismatch));

    yield* run(["delete", "--base-dir", baseDir, "--json", taskId]);

    assert.deepEqual(issuedAccessLevels, [
      "read-only",
      "full-access",
      "full-access",
      "full-access",
      "full-access",
    ]);
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
        { tool: "list_scheduled_tasks", args: { scheduledTaskId: taskId } },
        {
          tool: "schedule_task",
          args: {
            scheduledTaskId: taskId,
            projectId,
            prompt: "Updated prompt only",
          },
        },
        { tool: "list_scheduled_tasks", args: { scheduledTaskId: taskId } },
        { tool: "delete_scheduled_task", args: { scheduledTaskId: taskId } },
      ],
    );
  }).pipe(Effect.provide(cliTestLayer(process.cwd()))),
);
