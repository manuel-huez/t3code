import type { DiskUsageEntry, DiskUsageEntryKind, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  DiagnosticsLastChecked,
  DiagnosticsRefreshButton,
  DiagnosticsTable,
  EmptyRows,
  StatBlock,
  StatsGrid,
} from "./diagnosticsLayout";
import { diskUsageShare, diskUsageTone, diskUsedFraction } from "./DiskUsageDiagnostics.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

const KIND_LABELS: Record<Exclude<DiskUsageEntryKind, "worktree" | "agent">, string> = {
  attachments: "Attachments",
  database: "Database",
  logs: "Logs",
  caches: "T3 caches",
  other: "Other T3 data",
};

function entryLabel(entry: DiskUsageEntry): string {
  if (entry.kind === "worktree") return entry.path.split(/[\\/]/).slice(-2).join("/");
  if (entry.kind === "agent") return `${entry.label ?? "Agent"} data`;
  return KIND_LABELS[entry.kind];
}

export function DiskUsageDiagnostics({ environmentId }: { environmentId: EnvironmentId | null }) {
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
  const volume = snapshot?.volume ?? null;
  const breakdown = snapshot?.breakdown;
  const scanning = breakdown?.status === "scanning";
  const scannedAt = breakdown?.scannedAt ?? null;
  const fraction = volume ? diskUsedFraction(volume) : null;
  const volumeValue = (value: string) => (volume ? value : snapshot ? "Unavailable" : "...");

  return (
    <SettingsSection
      title="Disk Usage"
      headerAction={
        <div className="flex items-center gap-1.5">
          <DiagnosticsLastChecked
            checkedAt={scannedAt === null ? null : DateTime.makeUnsafe(scannedAt)}
          />
          <DiagnosticsRefreshButton
            isPending={scanning || snapshot === null}
            label="Rescan disk usage"
            onClick={() => setRescanAfter(snapshot?.sampledAt)}
          />
        </div>
      }
    >
      <StatsGrid>
        <StatBlock
          label="Disk Used"
          value={volumeValue(`${Math.round((fraction ?? 0) * 100)}%`)}
          tone={fraction === null ? "default" : diskUsageTone(fraction)}
        />
        <StatBlock label="Free" value={volumeValue(formatBytes(volume?.availableBytes ?? 0))} />
        <StatBlock label="Disk Size" value={volumeValue(formatBytes(volume?.totalBytes ?? 0))} />
        <StatBlock
          label="T3 Data"
          value={breakdown && scannedAt !== null ? formatBytes(breakdown.totalBytes) : "..."}
          tooltip="Allocated size of the T3 home directory and any worktree folder outside it, measured by a background scan. Agent data rows are not included."
        />
      </StatsGrid>
      {breakdown?.status === "failed" || query.error ? (
        <div className="flex items-start gap-2 border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5">
          <AlertTriangleIcon className="size-3.5 h-lh shrink-0" />
          <span>{query.error ?? "The last disk scan failed. Rescan to try again."}</span>
        </div>
      ) : null}
      <div className="border-t border-border/60">
        {breakdown && scannedAt !== null ? (
          <DiagnosticsTable
            headers={["Location", "Path", "Of Disk Used", "Size"]}
            columnWidths={["w-[22%]", "w-[46%]", "w-[16%]", "w-[16%]"]}
            minTableWidth="min-w-[480px]"
          >
            {breakdown.entries.map((entry) => (
              <tr key={`${entry.kind}:${entry.path}`} className="hover:bg-muted/20">
                <td className="truncate px-4 py-2 sm:pl-5">{entryLabel(entry)}</td>
                <td className="px-4 py-2 text-muted-foreground">
                  <Tooltip>
                    <TooltipTrigger render={<span className="block truncate">{entry.path}</span>} />
                    <TooltipPopup side="top" variant="code">
                      {entry.path}
                    </TooltipPopup>
                  </Tooltip>
                </td>
                <td className="px-4 py-2 font-mono tabular-nums text-muted-foreground">
                  {volume ? diskUsageShare(entry.bytes, volume) : ""}
                </td>
                <td className="px-4 py-2 font-mono tabular-nums sm:pr-5">
                  {formatBytes(entry.bytes)}
                </td>
              </tr>
            ))}
            {breakdown.omittedEntries > 0 ? (
              <tr className="text-muted-foreground">
                <td className="px-4 py-2 sm:pl-5" colSpan={2}>
                  {breakdown.omittedEntries} smaller items
                </td>
                <td className="px-4 py-2 font-mono tabular-nums">
                  {volume ? diskUsageShare(breakdown.omittedBytes, volume) : ""}
                </td>
                <td className="px-4 py-2 font-mono tabular-nums sm:pr-5">
                  {formatBytes(breakdown.omittedBytes)}
                </td>
              </tr>
            ) : null}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            label={
              breakdown?.status === "unavailable"
                ? "The breakdown needs the resource monitor, which is not running on this server."
                : breakdown?.status === "failed"
                  ? "No breakdown yet."
                  : "Measuring what T3 stores on this disk…"
            }
          />
        )}
      </div>
    </SettingsSection>
  );
}
