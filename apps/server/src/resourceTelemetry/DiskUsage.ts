// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no statfs.
import * as NodeFSP from "node:fs/promises";
import type { DiskUsageEntry, DiskUsageInput, DiskUsageSnapshot } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { managedWorktreesDirectories } from "../worktreesDirectory.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";

export class DiskUsageScanError extends Schema.TaggedError<DiskUsageScanError>()(
  "DiskUsageScanError",
  { root: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to measure T3 disk usage.";
  }
}

// Worktrees are `worktrees/<repo>/<worktree>` below the home directory, so entries sit three
// levels down; a worktree folder outside the home holds `<repo>/<worktree>`, two levels down.
const SCAN_DEPTH = 3;
const EXTERNAL_WORKTREES_DEPTH = 2;
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

/**
 * Directories are paths relative to the T3 home, with `/` separators. Worktrees in a configured
 * folder outside the home arrive already measured, with absolute paths.
 */
export function classifyDiskUsage(input: {
  readonly attachmentsDir: string;
  readonly logsDir: string;
  readonly cachesDir: string;
  readonly stateDir: string;
  readonly worktreesDir: string;
  readonly totalBytes: number;
  readonly bytesByPath: ReadonlyMap<string, number>;
  readonly externalWorktrees: ReadonlyArray<{ readonly path: string; readonly bytes: number }>;
  readonly externalBytes: number;
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
  for (const worktree of input.externalWorktrees) entries.push({ kind: "worktree", ...worktree });

  return {
    totalBytes: input.totalBytes + input.externalBytes,
    entries: entries.filter((entry) => entry.bytes > 0).toSorted((a, b) => b.bytes - a.bytes),
  };
}

/**
 * Instances that share a folder share a row, and a folder inside another one, or inside a root
 * T3 already measured, is dropped so no byte is counted twice.
 */
export function selectAgentFolders(
  reported: ReadonlyArray<{ readonly folder: string; readonly label: string }>,
  measuredRoots: ReadonlyArray<string>,
  path: Pick<Path.Path, "relative" | "isAbsolute">,
): ReadonlyArray<{ readonly folder: string; readonly label: string }> {
  const isInside = (child: string, parent: string) => {
    const fromParent = path.relative(parent, child);
    return !fromParent.startsWith("..") && !path.isAbsolute(fromParent);
  };
  const labels = new Map<string, Set<string>>();
  for (const { folder, label } of reported) {
    labels.set(folder, (labels.get(folder) ?? new Set()).add(label));
  }
  const folders = [...labels.keys()];
  return [...labels]
    .filter(
      ([folder]) =>
        !measuredRoots.some((root) => isInside(folder, root)) &&
        !folders.some((other) => other !== folder && isInside(folder, other)),
    )
    .map(([folder, names]) => ({ folder, label: [...names].join(", ") }));
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
  const settings = yield* ServerSettings.ServerSettingsService;
  const providers = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
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

  const scanRoot = (root: string, depth: number) =>
    monitor.scanDisk({ root, depth }).pipe(
      Effect.filterOrFail(
        (event) => event.error === null,
        (event) => new DiskUsageScanError({ root, cause: event.error }),
      ),
    );

  // The configured and previous worktree folders, when they live outside the T3 home.
  const externalWorktreeRoots = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (current._tag === "None") return [];
    const home = yield* HostProcess.HomeDirectory;
    return managedWorktreesDirectories(current.value, config.worktreesDir, path, home).filter(
      (directory) => {
        const fromHome = path.relative(config.baseDir, directory);
        return fromHome.startsWith("..") || path.isAbsolute(fromHome);
      },
    );
  });

  const agentDataFolders = Effect.fn("DiskUsage.agentDataFolders")(function* (
    measuredRoots: ReadonlyArray<string>,
  ) {
    const reported: Array<{ readonly folder: string; readonly label: string }> = [];
    for (const instance of yield* providers.listInstances) {
      if (!instance.dataDirectories) continue;
      const label = (yield* instance.snapshot.getSnapshot).displayName ?? instance.driverKind;
      for (const directory of yield* instance.dataDirectories) {
        reported.push({ folder: path.resolve(directory), label });
      }
    }
    return selectAgentFolders(reported, measuredRoots, path);
  });

  const measure = Effect.gen(function* () {
    const base = yield* scanRoot(config.baseDir, SCAN_DEPTH);
    const externalRoots = yield* externalWorktreeRoots;
    const external = yield* Effect.forEach(externalRoots, (root) =>
      // A configured folder that does not exist yet holds no worktrees.
      scanRoot(root, EXTERNAL_WORKTREES_DEPTH).pipe(
        Effect.map((event) => ({ root, event })),
        Effect.option,
      ),
    );
    const scanned = external.flatMap((result) => (result._tag === "Some" ? [result.value] : []));
    const result = classifyDiskUsage({
      attachmentsDir: relative(config.attachmentsDir),
      logsDir: relative(config.logsDir),
      cachesDir: relative(config.providerStatusCacheDir),
      stateDir: relative(config.stateDir),
      worktreesDir: relative(config.worktreesDir),
      totalBytes: base.totalBytes,
      bytesByPath: new Map(base.entries.map((entry) => [entry.path, entry.bytes])),
      externalWorktrees: scanned.flatMap(({ root, event }) =>
        event.entries
          .filter((entry) => entry.path.split("/").length === EXTERNAL_WORKTREES_DEPTH)
          .map((entry) => ({ path: path.join(root, entry.path), bytes: entry.bytes })),
      ),
      externalBytes: scanned.reduce((sum, { event }) => sum + event.totalBytes, 0),
    });
    const home = yield* HostProcess.HomeDirectory;
    const shown = (absolute: string) =>
      absolute.startsWith(home + path.sep) ? `~${absolute.slice(home.length)}` : absolute;
    const absolutePath = (entry: DiskUsageEntry) => {
      if (entry.kind === "database") return path.join(config.stateDir, "*.sqlite");
      if (entry.kind === "other") return config.baseDir;
      return path.isAbsolute(entry.path) ? entry.path : path.join(config.baseDir, entry.path);
    };
    // Agent folders are not T3 data, so they get rows but stay out of T3's total.
    const agentEntries = yield* Effect.forEach(
      yield* agentDataFolders([config.baseDir, ...externalRoots]),
      ({ folder, label }) =>
        scanRoot(folder, 1).pipe(
          Effect.map((event): DiskUsageEntry => ({
            kind: "agent",
            label,
            path: shown(folder),
            bytes: event.totalBytes,
          })),
          Effect.option,
        ),
    );
    return {
      ...result,
      entries: [
        ...result.entries.map((entry) => ({ ...entry, path: shown(absolutePath(entry)) })),
        ...agentEntries.flatMap((entry) => (entry._tag === "Some" ? [entry.value] : [])),
      ]
        .filter((entry) => entry.bytes > 0)
        .toSorted((a, b) => b.bytes - a.bytes),
    };
  });

  const scan = Effect.fn("DiskUsage.scan")(function* () {
    const outcome = yield* measure.pipe(
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
