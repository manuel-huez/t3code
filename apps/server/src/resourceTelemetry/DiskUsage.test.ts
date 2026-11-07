import { assert, describe, it } from "@effect/vitest";

import { classifyDiskUsage } from "./DiskUsage.ts";

const MIB = 1024 * 1024;

const paths = {
  attachmentsDir: "userdata/attachments",
  logsDir: "userdata/logs",
  cachesDir: "caches",
  stateDir: "userdata",
  worktreesDir: "worktrees",
};

describe("classifyDiskUsage", () => {
  it("attributes T3 data to its owners, largest first, and keeps the remainder", () => {
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
    });

    assert.deepEqual(
      result.entries.map((entry) => [entry.kind, entry.path, entry.bytes]),
      [
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
});
