// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem has no lstat, and the scan must not follow symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export interface DiskScanResult {
  readonly totalBytes: number;
  /** Allocated bytes per relative path ("a", "a/b"), for every file and directory up to `depth`. */
  readonly bytesByPath: ReadonlyMap<string, number>;
}

// Each lstat takes a libuv thread-pool slot that the rest of the server shares.
const MAX_IN_FLIGHT_DIRECTORIES = 8;
const STAT_BATCH_SIZE = 64;

/**
 * Sums allocated bytes under `root`, as `du` does, without blocking the event loop.
 *
 * Counts blocks rather than apparent size, counts hardlinked files once, never follows
 * symlinks, and stays on the root's filesystem. Unreadable entries are skipped. APFS clones
 * share blocks but report them per file, so totals on macOS can overcount.
 */
export async function scanDiskUsage(
  root: string,
  options: { readonly depth: number; readonly signal: AbortSignal },
): Promise<DiskScanResult> {
  const { depth, signal } = options;
  const bytesByPath = new Map<string, number>();
  const seenLinks = new Set<string>();
  let totalBytes = 0;

  const rootStat = await NodeFSP.lstat(root);
  const rootDevice = rootStat.dev;

  const add = (keys: ReadonlyArray<string>, bytes: number) => {
    totalBytes += bytes;
    for (const key of keys) bytesByPath.set(key, (bytesByPath.get(key) ?? 0) + bytes);
  };

  // Windows reports no block count, so fall back to apparent size there.
  const allocated = (stat: { blocks?: number; size: number }) =>
    stat.blocks === undefined ? stat.size : stat.blocks * 512;

  const childKeys = (keys: ReadonlyArray<string>, name: string) => {
    if (keys.length >= depth) return keys;
    const parent = keys.at(-1);
    return [...keys, parent === undefined ? name : `${parent}/${name}`];
  };

  const pending: Array<{ path: string; keys: ReadonlyArray<string> }> = [{ path: root, keys: [] }];
  add([], allocated(rootStat));

  const visit = async (directory: { path: string; keys: ReadonlyArray<string> }) => {
    const entries = await NodeFSP.readdir(directory.path, { withFileTypes: true }).catch(() => []);
    const measure = async (entry: (typeof entries)[number]) => {
      if (signal.aborted) return;
      const path = NodePath.join(directory.path, entry.name);
      const keys = childKeys(directory.keys, entry.name);
      const stat = await NodeFSP.lstat(path).catch(() => null);
      if (stat === null) return;
      if (stat.isDirectory()) {
        if (stat.dev !== rootDevice) return;
        add(keys, allocated(stat));
        pending.push({ path, keys });
        return;
      }
      if (stat.nlink > 1) {
        const identity = `${stat.dev}:${stat.ino}`;
        if (seenLinks.has(identity)) return;
        seenLinks.add(identity);
      }
      add(keys, allocated(stat));
    };
    for (let index = 0; index < entries.length; index += STAT_BATCH_SIZE) {
      await Promise.all(entries.slice(index, index + STAT_BATCH_SIZE).map(measure));
    }
  };

  const worker = async () => {
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      if (signal.aborted) return;
      await visit(next);
    }
  };

  // A worker exits when the stack is momentarily empty while a sibling is still expanding a
  // directory, so keep spawning rounds until nothing is left.
  while (pending.length > 0 && !signal.aborted) {
    await Promise.all(Array.from({ length: MAX_IN_FLIGHT_DIRECTORIES }, worker));
  }
  signal.throwIfAborted();

  return { totalBytes, bytesByPath };
}
