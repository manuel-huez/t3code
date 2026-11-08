import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { classifyDiskUsage, selectAgentFolders } from "./DiskUsage.ts";

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

  it.effect("gives agent folders one row each, without counting a byte twice", () =>
    Effect.gen(function* () {
      const folders = selectAgentFolders(
        [
          { folder: "/home/u/.codex", label: "Codex" },
          { folder: "/home/u/.codex", label: "Codex Work" },
          { folder: "/home/u/.pi/agent", label: "Pi" },
          { folder: "/home/u/.pi/agent/sessions", label: "Pi" },
          { folder: "/home/u/.t3/userdata/providers/antigravity/a1", label: "Antigravity" },
        ],
        ["/home/u/.t3"],
        yield* Path.Path,
      );

      assert.deepEqual(folders, [
        { folder: "/home/u/.codex", label: "Codex, Codex Work" },
        { folder: "/home/u/.pi/agent", label: "Pi" },
      ]);
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );
});
