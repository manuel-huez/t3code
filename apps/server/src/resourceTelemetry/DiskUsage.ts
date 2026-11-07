// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DiskUsageEntry, DiskUsageInput, DiskUsageSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { scanDiskUsage } from "./DiskScan.ts";

export class DiskUsageScanError extends Schema.TaggedError<DiskUsageScanError>()(
  "DiskUsageScanError",
  { baseDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to measure T3 disk usage.";
  }
}

// Worktrees are `<repo>/<worktree>` below the home directory, so entries sit three levels down.
const SCAN_DEPTH = 3;
const MAX_ENTRIES = 30;
const RESCAN_AFTER_MS = 10 * 60_000;
const SCAN_TIMEOUT = "10 minutes";
const DATABASE_FILE = /\.sqlite(?:-wal|-shm|-journal)?$/;

type Breakdown = DiskUsageSnapshot["breakdown"];

interface ScanState {
  readonly running: boolean;
  readonly failed: boolean;
  readonly attemptedAt: number | null;
  readonly last: { readonly scannedAt: number; readonly result: ScanResult } | null;
}

interface ScanResult {
  readonly totalBytes: number;
  readonly entries: ReadonlyArray<DiskUsageEntry>;
}

export class DiskUsage extends Context.Service<
  DiskUsage,
  {
    /** Returns immediately: volume figures are live, the breakdown comes from a background scan. */
    readonly read: (input: DiskUsageInput) => Effect.Effect<DiskUsageSnapshot>;
  }
>()("t3/resourceTelemetry/DiskUsage") {}

export function classifyDiskUsage(input: {
  readonly baseDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly cachesDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly totalBytes: number;
  readonly bytesByPath: ReadonlyMap<string, number>;
}): ScanResult {
  const rel = (directory: string) =>
    NodePath.relative(input.baseDir, directory).split(NodePath.sep).join("/");
  const bytesAt = (directory: string) => input.bytesByPath.get(rel(directory)) ?? 0;

  const entries: Array<DiskUsageEntry> = [
    { kind: "attachments", path: rel(input.attachmentsDir), bytes: bytesAt(input.attachmentsDir) },
    { kind: "logs", path: rel(input.logsDir), bytes: bytesAt(input.logsDir) },
    { kind: "caches", path: rel(input.cachesDir), bytes: bytesAt(input.cachesDir) },
  ];

  const statePrefix = `${rel(input.stateDir)}/`;
  const worktreesPrefix = `${rel(input.worktreesDir)}/`;
  let databaseBytes = 0;
  for (const [path, bytes] of input.bytesByPath) {
    if (
      path.startsWith(statePrefix) &&
      path.split("/").length === statePrefix.split("/").length &&
      DATABASE_FILE.test(path)
    ) {
      databaseBytes += bytes;
    } else if (path.startsWith(worktreesPrefix) && path.split("/").length === SCAN_DEPTH) {
      entries.push({ kind: "worktree", path, bytes });
    }
  }
  entries.push({ kind: "database", path: rel(input.stateDir), bytes: databaseBytes });

  const accounted = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  entries.push({ kind: "other", path: ".", bytes: Math.max(0, input.totalBytes - accounted) });

  return {
    totalBytes: input.totalBytes,
    entries: entries.filter((entry) => entry.bytes > 0).toSorted((a, b) => b.bytes - a.bytes),
  };
}

function toBreakdown(state: ScanState): Breakdown {
  const entries = state.last?.result.entries ?? [];
  const omitted = entries.slice(MAX_ENTRIES);
  return {
    status: state.running ? "scanning" : state.failed ? "failed" : "ready",
    scannedAt: state.last?.scannedAt ?? null,
    totalBytes: state.last?.result.totalBytes ?? 0,
    entries: entries.slice(0, MAX_ENTRIES),
    omittedEntries: omitted.length,
    omittedBytes: omitted.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

const make = Effect.fn("makeDiskUsage")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<ScanState>({
    running: false,
    failed: false,
    attemptedAt: null,
    last: null,
  });

  const readVolume = Effect.tryPromise({
    try: () => NodeFSP.statfs(config.baseDir),
    catch: (cause) => new DiskUsageScanError({ baseDir: config.baseDir, cause }),
  }).pipe(
    Effect.map((stats) => ({
      path: config.baseDir,
      totalBytes: stats.blocks * stats.bsize,
      availableBytes: stats.bavail * stats.bsize,
    })),
    Effect.orElseSucceed(() => null),
  );

  const scan = Effect.fn("DiskUsage.scan")(function* () {
    const scanned = yield* Effect.tryPromise({
      try: (signal) => scanDiskUsage(config.baseDir, { depth: SCAN_DEPTH, signal }),
      catch: (cause) => new DiskUsageScanError({ baseDir: config.baseDir, cause }),
    }).pipe(
      Effect.timeout(SCAN_TIMEOUT),
      Effect.map((result) =>
        classifyDiskUsage({
          baseDir: config.baseDir,
          attachmentsDir: config.attachmentsDir,
          logsDir: config.logsDir,
          cachesDir: config.providerStatusCacheDir,
          stateDir: config.stateDir,
          worktreesDir: config.worktreesDir,
          ...result,
        }),
      ),
      Effect.tapError((error) => Effect.logWarning(error.message, { cause: error.cause })),
      Effect.option,
    );
    const scannedAt = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(state, (current) => ({
      ...current,
      running: false,
      failed: scanned._tag === "None",
      last: scanned._tag === "Some" ? { scannedAt, result: scanned.value } : current.last,
    }));
  });

  const read = Effect.fn("DiskUsage.read")(function* (input: DiskUsageInput) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const shouldScan = yield* Ref.modify(state, (current) => {
      // A failed attempt waits out the same interval, so a broken scan cannot retry on every poll.
      const stale =
        current.attemptedAt === null ||
        now - current.attemptedAt > RESCAN_AFTER_MS ||
        current.attemptedAt <= (input.rescanAfter ?? 0);
      return current.running || !stale
        ? ([false, current] as const)
        : ([true, { ...current, running: true, attemptedAt: now }] as const);
    });
    if (shouldScan) yield* scan().pipe(Effect.forkIn(scope), Effect.asVoid);
    return {
      sampledAt: now,
      volume: yield* readVolume,
      breakdown: toBreakdown(yield* Ref.get(state)),
    };
  });

  return DiskUsage.of({ read });
});

export const layer = Layer.effect(DiskUsage, make());
