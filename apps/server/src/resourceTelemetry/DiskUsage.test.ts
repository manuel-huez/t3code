import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { scanDiskUsage } from "./DiskScan.ts";
import { classifyDiskUsage } from "./DiskUsage.ts";

const MIB = 1024 * 1024;

describe("DiskUsage", () => {
  it.effect("attributes T3 data to its owners and counts hardlinks once", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-disk-usage-" });
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const write = Effect.fn(function* (file: string, bytes: number) {
        yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
        yield* fileSystem.writeFile(file, new Uint8Array(bytes).fill(1));
      });

      yield* write(path.join(paths.attachmentsDir, "photo.png"), MIB);
      yield* write(path.join(paths.logsDir, "server.log"), MIB / 2);
      yield* write(paths.dbPath, MIB);
      yield* write(`${paths.dbPath}-wal`, MIB / 4);
      yield* write(path.join(paths.worktreesDir, "repo", "feature", "big.bin"), 2 * MIB);
      yield* fileSystem.link(
        path.join(paths.worktreesDir, "repo", "feature", "big.bin"),
        path.join(paths.worktreesDir, "repo", "feature", "same-file.bin"),
      );
      yield* write(path.join(paths.worktreesDir, "repo", "other", "small.bin"), MIB / 4);
      // A symlink to a large directory must not be followed.
      yield* fileSystem.symlink(
        paths.attachmentsDir,
        path.join(paths.worktreesDir, "repo", "other", "attachments-link"),
      );

      const scan = yield* Effect.promise((signal) => scanDiskUsage(baseDir, { depth: 3, signal }));
      const result = classifyDiskUsage({
        baseDir,
        attachmentsDir: paths.attachmentsDir,
        logsDir: paths.logsDir,
        cachesDir: paths.providerStatusCacheDir,
        stateDir: paths.stateDir,
        worktreesDir: paths.worktreesDir,
        ...scan,
      });

      const bytes = (kind: string, entryPath?: string) =>
        result.entries.find(
          (entry) => entry.kind === kind && (entryPath === undefined || entry.path === entryPath),
        )?.bytes ?? 0;
      // Directory blocks and filesystem rounding add a little to every figure.
      const near = (actual: number, expected: number) => {
        assert.isAtLeast(actual, expected);
        assert.isAtMost(actual, expected + 128 * 1024);
      };

      near(bytes("attachments"), MIB);
      near(bytes("logs"), MIB / 2);
      near(bytes("database"), MIB + MIB / 4);
      near(bytes("worktree", "worktrees/repo/feature"), 2 * MIB);
      near(bytes("worktree", "worktrees/repo/other"), MIB / 4);
      assert.isAtMost(scan.totalBytes, 5 * MIB + 512 * 1024);
      assert.deepEqual(
        result.entries.map((entry) => entry.bytes),
        result.entries.map((entry) => entry.bytes).toSorted((a, b) => b - a),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("stops when aborted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-disk-usage-abort-" });
      const outcome = yield* Effect.promise(() =>
        scanDiskUsage(root, { depth: 3, signal: AbortSignal.abort() }).then(
          () => "completed",
          () => "aborted",
        ),
      );
      assert.equal(outcome, "aborted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
