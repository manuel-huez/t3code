// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import type { DiskUsageEntry, DiskUsageInput, DiskUsageSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

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
const DATABASE_FILE = /\.sqlite(?:-wal|-shm|-journal)?$/;

type Breakdown = DiskUsageSnapshot["breakdown"];

interface ScanState {
  readonly running: boolean;
  /** "unavailable" means the resource monitor is not running, so retrying cannot help yet. */
  readonly failure: "failed" | "unavailable" | null;
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

/** Directories are paths relative to the scanned root, with `/` separators. */
export function classifyDiskUsage(input: {
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly cachesDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly totalBytes: number;
  readonly bytesByPath: ReadonlyMap<string, number>;
}): ScanResult {
  const owned = (kind: DiskUsageEntry["kind"], path: string): DiskUsageEntry => ({
    kind,
    path,
    bytes: input.bytesByPath.get(path) ?? 0,
  });
  const entries: Array<DiskUsageEntry> = [
    owned("attachments", input.attachmentsDir),
    owned("logs", input.logsDir),
    owned("caches", input.cachesDir),
  ];

  const statePrefix = `${input.stateDir}/`;
  const worktreesPrefix = `${input.worktreesDir}/`;
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
  entries.push({ kind: "database", path: input.stateDir, bytes: databaseBytes });

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
    status: state.running ? "scanning" : (state.failure ?? "ready"),
    scannedAt: state.last?.scannedAt ?? null,
    totalBytes: state.last?.result.totalBytes ?? 0,
    entries: entries.slice(0, MAX_ENTRIES),
    omittedEntries: omitted.length,
    omittedBytes: omitted.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

const make = Effect.fn("makeDiskUsage")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const monitor = yield* NativeTelemetryClient.NativeTelemetryClient;
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<ScanState>({
    running: false,
    failure: null,
    attemptedAt: null,
    last: null,
  });

  // A volume the server cannot read shows as unavailable, not as an RPC failure.
  const readVolume = Effect.promise(() =>
    NodeFSP.statfs(config.baseDir).then(
      (stats) => ({
        totalBytes: stats.blocks * stats.bsize,
        availableBytes: stats.bavail * stats.bsize,
      }),
      () => null,
    ),
  );
  const relative = (directory: string) =>
    path.relative(config.baseDir, directory).replaceAll("\\", "/");

  const scan = Effect.fn("DiskUsage.scan")(function* () {
    const outcome = yield* monitor.scanDisk({ root: config.baseDir, depth: SCAN_DEPTH }).pipe(
      Effect.filterOrFail(
        (event) => event.error === null,
        (event) => new DiskUsageScanError({ baseDir: config.baseDir, cause: event.error }),
      ),
      Effect.map((event) =>
        classifyDiskUsage({
          attachmentsDir: relative(config.attachmentsDir),
          logsDir: relative(config.logsDir),
          cachesDir: relative(config.providerStatusCacheDir),
          stateDir: relative(config.stateDir),
          worktreesDir: relative(config.worktreesDir),
          totalBytes: event.totalBytes,
          bytesByPath: new Map(event.entries.map((entry) => [entry.path, entry.bytes])),
        }),
      ),
      Effect.tapError((error) => Effect.logWarning(error.message)),
      Effect.match({
        onSuccess: (result) => ({ _tag: "ready" as const, result }),
        onFailure: (error) => ({
          _tag:
            error._tag === "NativeTelemetryUnavailable"
              ? ("unavailable" as const)
              : ("failed" as const),
        }),
      }),
    );
    const scannedAt = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(state, (current) => ({
      ...current,
      failure: outcome._tag === "ready" ? null : outcome._tag,
      last: outcome._tag === "ready" ? { scannedAt, result: outcome.result } : current.last,
    }));
  });
  // A defect or interruption must not leave the card stuck on "scanning".
  const runScan = scan().pipe(
    Effect.ensuring(Ref.update(state, (current) => ({ ...current, running: false }))),
  );

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
    if (shouldScan) yield* runScan.pipe(Effect.forkIn(scope), Effect.asVoid);
    return {
      sampledAt: now,
      volume: yield* readVolume,
      breakdown: toBreakdown(yield* Ref.get(state)),
    };
  });

  return DiskUsage.of({ read });
});

export const layer = Layer.effect(DiskUsage, make());
