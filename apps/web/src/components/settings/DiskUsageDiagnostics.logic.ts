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

/** Share of the disk's used space, precise enough that small entries do not all read "0%". */
export function diskUsageShare(
  bytes: number,
  volume: NonNullable<DiskUsageSnapshot["volume"]>,
): string {
  const usedBytes = volume.totalBytes - volume.availableBytes;
  if (usedBytes <= 0) return "0%";
  const percent = (bytes / usedBytes) * 100;
  if (percent >= 10) return `${Math.round(percent)}%`;
  if (percent >= 1) return `${percent.toFixed(1)}%`;
  if (percent >= 0.01) return `${percent.toFixed(2)}%`;
  return percent > 0 ? "<0.01%" : "0%";
}
