import type { DiskUsageSnapshot } from "@t3tools/contracts";

const WARNING_FRACTION = 0.85;
const DANGER_FRACTION = 0.95;

export function diskUsedFraction(volume: NonNullable<DiskUsageSnapshot["volume"]>): number {
  if (volume.totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - volume.availableBytes / volume.totalBytes));
}

export function diskUsageTone(fraction: number): "default" | "warning" | "danger" {
  if (fraction >= DANGER_FRACTION) return "danger";
  if (fraction >= WARNING_FRACTION) return "warning";
  return "default";
}

/** Share of T3's data, with one decimal below 10% so small entries do not all read "0%". */
export function diskUsageShare(bytes: number, totalBytes: number): string {
  if (totalBytes <= 0) return "0%";
  const percent = (bytes / totalBytes) * 100;
  return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}
