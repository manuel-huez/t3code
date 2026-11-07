import type { EnvironmentId } from "@t3tools/contracts";
import { AlertTriangleIcon, HardDriveIcon } from "lucide-react";
import { useState } from "react";

import { useRelativeTimeState } from "../../hooks/useRelativeTimeState";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { diskUsageRows, diskUsageTone, diskUsedFraction } from "./DiskUsageDiagnostics.logic";
import { SettingsSection } from "./settingsLayout";

function ScanLabel({ scannedAt, scanning }: { scannedAt: number | null; scanning: boolean }) {
  const relative = useRelativeTimeState(
    scannedAt === null ? null : new Date(scannedAt).toISOString(),
  );
  if (scanning) return <span className="text-2xs text-muted-foreground/60">Scanning…</span>;
  if (relative.status !== "relative") return null;
  return (
    <span className="text-2xs text-muted-foreground/60">
      Scanned <span className="font-mono tabular-nums">{relative.value}</span>
      {relative.suffix ? ` ${relative.suffix}` : ""}
    </span>
  );
}

export function DiskUsageDiagnostics({ environmentId }: { environmentId: EnvironmentId | null }) {
  // A rescan request names the server timestamp of the snapshot the user saw, so a client clock
  // that differs from the server's cannot keep triggering scans.
  const [rescanAfter, setRescanAfter] = useState<number | undefined>(undefined);
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.diskUsage({
          environmentId,
          input: rescanAfter === undefined ? {} : { rescanAfter },
        }),
  );
  const snapshot = query.data;
  const scanning = snapshot?.breakdown.status === "scanning";
  const rows = snapshot ? diskUsageRows(snapshot) : [];
  const largestBytes = rows.find((row) => row.showBar)?.bytes ?? 0;
  const fraction = snapshot?.volume ? diskUsedFraction(snapshot.volume) : null;
  const tone = fraction === null ? "default" : diskUsageTone(fraction);

  return (
    <SettingsSection
      title="Disk usage"
      icon={<HardDriveIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-2">
          <ScanLabel scannedAt={snapshot?.breakdown.scannedAt ?? null} scanning={scanning} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-micro"
                  variant="ghost"
                  disabled={scanning || snapshot === null}
                  onClick={() => setRescanAfter(snapshot?.sampledAt)}
                  aria-label="Rescan disk usage"
                >
                  <RefreshIcon size="xs" refreshing={scanning} />
                </Button>
              }
            />
            <TooltipPopup side="top">Rescan disk usage</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      <div className="overflow-hidden rounded-[inherit]">
        <div className="px-4 py-4 sm:px-5">
          <div className="text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
            Data volume
          </div>
          <div className="mt-2.5 flex items-baseline justify-between gap-3">
            <div
              className={cn(
                "font-mono text-2xl font-semibold tracking-tighter tabular-nums text-foreground",
                tone === "warning" && "text-warning-foreground",
                tone === "danger" && "text-destructive",
              )}
            >
              {fraction === null ? "..." : `${Math.round(fraction * 100)}%`}
              <span className="ml-1.5 font-sans text-xs font-normal tracking-normal text-muted-foreground">
                used
              </span>
            </div>
            {snapshot?.volume ? (
              <div className="truncate text-3xs text-muted-foreground/60">
                {formatBytes(snapshot.volume.availableBytes)} free of{" "}
                {formatBytes(snapshot.volume.totalBytes)}
              </div>
            ) : null}
          </div>
          {fraction !== null ? (
            <div
              role="progressbar"
              aria-label="Disk used"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn(
                  "h-full rounded-full bg-success/80",
                  tone === "warning" && "bg-warning/80",
                  tone === "danger" && "bg-destructive/80",
                )}
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
          ) : null}
          {snapshot && snapshot.volume === null ? (
            <p className="mt-2 text-xs text-muted-foreground">
              This server cannot report the free space of its data volume.
            </p>
          ) : null}
        </div>
        {rows.length > 0 ? (
          <ul className="divide-y divide-border/55 border-t border-border/60">
            {rows.map((row) => (
              <li key={row.key} className="px-4 py-2.5 sm:px-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span
                      className={cn(
                        "truncate text-xs",
                        row.muted ? "text-muted-foreground" : "text-foreground",
                      )}
                    >
                      {row.label}
                    </span>
                    {row.detail ? (
                      <span className="truncate text-3xs text-muted-foreground/60">
                        {row.detail}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                    {formatBytes(row.bytes)}
                  </span>
                </div>
                {row.showBar ? (
                  <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn(
                        "h-full rounded-full",
                        row.muted ? "bg-muted-foreground/35" : "bg-info/80",
                      )}
                      style={{
                        width: `${largestBytes > 0 ? (row.bytes / largestBytes) * 100 : 0}%`,
                      }}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        ) : snapshot ? (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {scanning
              ? "Measuring what T3 stores on this disk…"
              : snapshot.breakdown.status === "unavailable"
                ? "The folder breakdown needs the resource monitor, which is not running on this server."
                : "No breakdown yet."}
          </p>
        ) : null}
        {snapshot?.breakdown.status === "failed" || query.error ? (
          <div className="flex items-start gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive sm:px-5">
            <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
            <span>{query.error ?? "The last disk scan failed. Rescan to try again."}</span>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}
