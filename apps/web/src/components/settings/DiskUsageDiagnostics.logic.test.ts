import { describe, expect, it } from "vite-plus/test";

import { diskUsageTone, diskUsedFraction } from "./DiskUsageDiagnostics.logic";

describe("DiskUsageDiagnostics logic", () => {
  it("warns before the disk is full", () => {
    expect(diskUsageTone(0.84)).toBe("default");
    expect(diskUsageTone(0.85)).toBe("warning");
    expect(diskUsageTone(0.95)).toBe("danger");
    expect(diskUsedFraction({ totalBytes: 100, availableBytes: 40 })).toBe(0.6);
  });
});
