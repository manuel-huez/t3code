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

export function classifyDiskUsage(input: {
  readonly baseDir: string;
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly cachesDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly totalBytes: number;
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly relative: (from: string, to: string) => string;
}): ScanResult {
  const rel = (directory: string) => input.relative(input.baseDir, directory).replaceAll("\\", "/");
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

  const readVolume = monitor.diskSpace(config.baseDir).pipe(
    Effect.map((volume) => (volume === null ? null : { path: config.baseDir, ...volume })),
    Effect.orElseSucceed(() => null),
  );

  const scan = Effect.fn("DiskUsage.scan")(function* () {
    const outcome = yield* monitor.scanDisk({ root: config.baseDir, depth: SCAN_DEPTH }).pipe(
      Effect.filterOrFail(
        (event) => event.error === null,
        (event) => new DiskUsageScanError({ baseDir: config.baseDir, cause: event.error }),
      ),
      Effect.map((event) =>
        classifyDiskUsage({
          baseDir: config.baseDir,
          attachmentsDir: config.attachmentsDir,
          logsDir: config.logsDir,
          cachesDir: config.providerStatusCacheDir,
          stateDir: config.stateDir,
          worktreesDir: config.worktreesDir,
          totalBytes: event.totalBytes,
          bytesByPath: new Map(event.entries.map((entry) => [entry.path, entry.bytes])),
          relative: path.relative,
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
      running: false,
      failure: outcome._tag === "ready" ? null : outcome._tag,
      last: outcome._tag === "ready" ? { scannedAt, result: outcome.result } : current.last,
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
