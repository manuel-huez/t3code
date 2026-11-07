import type { DiskUsageEntryKind, DiskUsageSnapshot } from "@t3tools/contracts";

export type DiskUsageTone = "default" | "warning" | "danger";

export interface DiskUsageRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string | null;
  readonly bytes: number;
  readonly muted: boolean;
  /** The rest of the disk dwarfs T3's own data, so it is a figure, not a comparable bar. */
  readonly showBar: boolean;
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

/** T3's data largest first, then the rest of the disk. Empty until a scan has finished. */
export function diskUsageRows(snapshot: DiskUsageSnapshot): ReadonlyArray<DiskUsageRow> {
  const { breakdown, volume } = snapshot;
  if (breakdown.scannedAt === null) return [];

  const rows: Array<DiskUsageRow> = breakdown.entries.map((entry) => ({
    key: `${entry.kind}:${entry.path}`,
    label: entry.kind === "worktree" ? entry.path.replace(/^[^/]+\//, "") : KIND_LABELS[entry.kind],
    detail: entry.kind === "worktree" ? "Worktree" : entry.kind === "other" ? null : entry.path,
    bytes: entry.bytes,
    muted: false,
    showBar: true,
  }));
  if (breakdown.omittedEntries > 0) {
    rows.push({
      key: "omitted",
      label: `${breakdown.omittedEntries} smaller items`,
      detail: null,
      bytes: breakdown.omittedBytes,
      muted: true,
      showBar: true,
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
        showBar: false,
      });
    }
  }
  return rows.toSorted((a, b) => Number(!a.showBar) - Number(!b.showBar) || b.bytes - a.bytes);
}
