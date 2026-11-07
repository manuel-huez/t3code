import { describe, expect, it } from "vite-plus/test";

import type { DiskUsageSnapshot } from "@t3tools/contracts";

import { diskUsageRows, diskUsageTone, diskUsedFraction } from "./DiskUsageDiagnostics.logic";

const GIB = 1024 ** 3;

const snapshot = (overrides: Partial<DiskUsageSnapshot["breakdown"]> = {}): DiskUsageSnapshot => ({
  sampledAt: 1,
  volume: { path: "/home", totalBytes: 100 * GIB, availableBytes: 40 * GIB },
  breakdown: {
    status: "ready",
    scannedAt: 1,
    totalBytes: 12 * GIB,
    entries: [
      { kind: "worktree", path: "worktrees/repo/feature", bytes: 10 * GIB },
      { kind: "attachments", path: "userdata/attachments", bytes: 2 * GIB },
    ],
    omittedEntries: 0,
    omittedBytes: 0,
    ...overrides,
  },
});

describe("DiskUsageDiagnostics logic", () => {
  it("warns before the disk is full", () => {
    expect(diskUsageTone(0.84)).toBe("default");
    expect(diskUsageTone(0.85)).toBe("warning");
    expect(diskUsageTone(0.95)).toBe("danger");
    expect(diskUsedFraction({ path: "/", totalBytes: 100, availableBytes: 40 })).toBe(0.6);
  });

  it("lists T3 data largest first, then the rest of the disk, and hides rows before the first scan", () => {
    expect(diskUsageRows(snapshot({ scannedAt: null }))).toEqual([]);

    const rows = diskUsageRows(snapshot());
    expect(rows.map((row) => [row.label, row.bytes, row.showBar])).toEqual([
      ["repo/feature", 10 * GIB, true],
      ["Attachments", 2 * GIB, true],
      ["Everything else on this disk", 48 * GIB, false],
    ]);
  });

  it("never shows a negative remainder when the scan overcounts", () => {
    const rows = diskUsageRows(snapshot({ totalBytes: 70 * GIB }));
    expect(rows.some((row) => row.key === "elsewhere")).toBe(false);
  });
});
