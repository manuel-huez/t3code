import type { DiskUsageEntryKind, DiskUsageSnapshot } from "@t3tools/contracts";

export type DiskUsageTone = "default" | "warning" | "danger";

export interface DiskUsageRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly bytes: number;
  readonly muted: boolean;
}

const WARNING_FRACTION = 0.85;
const DANGER_FRACTION = 0.95;

const KIND_LABELS: Record<Exclude<DiskUsageEntryKind, "worktree">, string> = {
  attachments: "Attachments",
  database: "Database",
  logs: "Logs",
  caches: "Caches",
  other: "Other T3 data",
};

export function diskUsedFraction(volume: NonNullable<DiskUsageSnapshot["volume"]>): number {
  if (volume.totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - volume.availableBytes / volume.totalBytes));
}

export function diskUsageTone(fraction: number): DiskUsageTone {
  if (fraction >= DANGER_FRACTION) return "danger";
  if (fraction >= WARNING_FRACTION) return "warning";
  return "default";
}

/** Largest first. Worth showing only once a scan has finished, or "everything else" would be all of it. */
export function diskUsageRows(snapshot: DiskUsageSnapshot): ReadonlyArray<DiskUsageRow> {
  const { breakdown, volume } = snapshot;
  if (breakdown.scannedAt === null) return [];

  const rows: Array<DiskUsageRow> = breakdown.entries.map((entry) => ({
    key: `${entry.kind}:${entry.path}`,
    label: entry.kind === "worktree" ? entry.path.replace(/^[^/]+\//, "") : KIND_LABELS[entry.kind],
    detail: entry.kind === "worktree" ? "Worktree" : entry.path,
    bytes: entry.bytes,
    muted: false,
  }));
  if (breakdown.omittedEntries > 0) {
    rows.push({
      key: "omitted",
      label: `${breakdown.omittedEntries} smaller items`,
      detail: null,
      bytes: breakdown.omittedBytes,
      muted: true,
    });
  }
  if (volume !== null) {
    const usedBytes = volume.totalBytes - volume.availableBytes;
    // Clones and hardlinks make the scan overcount, so never show a negative remainder.
    const elsewhere = Math.max(0, usedBytes - breakdown.totalBytes);
    if (elsewhere > 0) {
      rows.push({
        key: "elsewhere",
        label: "Everything else on this disk",
        detail: "Not stored by T3",
        bytes: elsewhere,
        muted: true,
      });
    }
  }
  return rows.toSorted((a, b) => b.bytes - a.bytes);
}
