import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { classifyDiskUsage, selectExternalFolders, sharedAgentFolders } from "./DiskUsage.ts";

const MIB = 1024 * 1024;

const paths = {
  attachmentsDir: "userdata/attachments",
  logsDir: "userdata/logs",
  cachesDir: "caches",
  stateDir: "userdata",
  worktreesDir: "worktrees",
};

describe("classifyDiskUsage", () => {
  it("attributes T3 data to its owners, including outside worktree folders, largest first", () => {
    const result = classifyDiskUsage({
      ...paths,
      totalBytes: 10 * MIB,
      bytesByPath: new Map([
        ["userdata", 3 * MIB],
        ["userdata/attachments", MIB],
        ["userdata/logs", MIB / 2],
        ["userdata/statev2.sqlite", MIB],
        ["userdata/statev2.sqlite-wal", MIB / 4],
        ["caches", MIB / 4],
        ["worktrees", 6 * MIB],
        ["worktrees/repo", 6 * MIB],
        ["worktrees/repo/feature", 5 * MIB],
        ["worktrees/repo/other", MIB],
      ]),
      externalWorktrees: [{ path: "/srv/worktrees/repo/big", bytes: 7 * MIB }],
      externalBytes: 8 * MIB,
    });

    assert.equal(result.totalBytes, 18 * MIB);

    assert.deepEqual(
      result.entries.map((entry) => [entry.kind, entry.path, entry.bytes]),
      [
        ["worktree", "/srv/worktrees/repo/big", 7 * MIB],
        ["worktree", "worktrees/repo/feature", 5 * MIB],
        ["database", "userdata", MIB + MIB / 4],
        ["attachments", "userdata/attachments", MIB],
        ["worktree", "worktrees/repo/other", MIB],
        ["other", ".", MIB],
        ["logs", "userdata/logs", MIB / 2],
        ["caches", "caches", MIB / 4],
      ],
    );
  });

  it.effect("gives outside folders one row each, without counting a byte twice", () =>
    Effect.gen(function* () {
      const folders = selectExternalFolders(
        [
          { folder: "/home/u/.codex", kind: "agent", label: "Codex" },
          { folder: "/home/u/.codex", kind: "agent", label: "Codex Work" },
          { folder: "/home/u/.pi/agent", kind: "agent", label: "Pi" },
          { folder: "/home/u/.pi/agent/sessions", kind: "agent", label: "Pi" },
          {
            folder: "/home/u/.t3/userdata/providers/antigravity/a1",
            kind: "agent",
            label: "Antigravity",
          },
          { folder: "/var/tmp/agents", kind: "agent-temp" },
          { folder: "/home/u/.cache", kind: "tool-cache" },
        ],
        ["/home/u/.t3"],
        yield* Path.Path,
      );

      assert.deepEqual(folders, [
        { folder: "/home/u/.codex", kind: "agent", label: "Codex, Codex Work" },
        { folder: "/home/u/.pi/agent", kind: "agent", label: "Pi" },
        { folder: "/var/tmp/agents", kind: "agent-temp" },
        { folder: "/home/u/.cache", kind: "tool-cache" },
      ]);
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );

  it.effect("finds the temp and tool cache folders agents inherit", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolve = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) =>
        sharedAgentFolders({ env, platform, home: "/home/u", path }).map((row) => row.folder);

      assert.deepEqual(
        resolve({ TMPDIR: "/var/tmp/agents", XDG_CACHE_HOME: "/data/cache" }, "linux"),
        ["/var/tmp/agents", "/data/cache"],
      );
      // A relative XDG_CACHE_HOME is invalid under the XDG spec, so the default applies.
      assert.deepEqual(resolve({ XDG_CACHE_HOME: "cache" }, "linux"), ["/tmp", "/home/u/.cache"]);
      assert.deepEqual(resolve({ TMPDIR: "/var/folders/x/T", XDG_CACHE_HOME: "/x" }, "darwin"), [
        "/var/folders/x/T",
        "/home/u/Library/Caches",
      ]);
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );
});
