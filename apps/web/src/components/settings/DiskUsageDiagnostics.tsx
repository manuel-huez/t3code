import type { DiskUsageEntry, DiskUsageEntryKind, EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AlertTriangleIcon, ChartPieIcon, InfoIcon } from "lucide-react";
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
  "agent-temp": "Agent temp files",
  "tool-cache": "Tool caches",
};

const KIND_DESCRIPTIONS: Partial<Record<DiskUsageEntryKind, string>> = {
  "agent-temp":
    "Scratch files that agents and their commands write while they work, in the folder set by TMPDIR. Other programs on this machine can also write here.",
  "tool-cache":
    "Caches of build tools, package managers and linters that agents run, such as Go, npm and pip. Other programs on this machine share this folder.",
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
  // Without a first answer, a failed request ends the wait; an older server never answers.
  const loading = snapshot === null && query.error === null;
  const fraction = volume ? diskUsedFraction(volume) : null;
  const volumeValue = (value: string) => (volume ? value : loading ? "..." : "Unavailable");

  return (
    <SettingsSection
      title="Disk usage"
      icon={<ChartPieIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-1.5">
          {snapshot === null && !loading ? null : (
            <DiagnosticsLastChecked
              checkedAt={scannedAt === null ? null : DateTime.makeUnsafe(scannedAt)}
            />
          )}
          <DiagnosticsRefreshButton
            isPending={scanning || loading}
            label="Rescan disk usage"
            onClick={() => (snapshot ? setRescanAfter(snapshot.sampledAt) : query.refresh())}
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
          value={
            breakdown && scannedAt !== null
              ? formatBytes(breakdown.totalBytes)
              : loading || scanning
                ? "..."
                : "Unavailable"
          }
          tooltip="Allocated size of the T3 home directory and any worktree folder outside it, measured by a background scan. Agent data, agent temp file and tool cache rows are not included."
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
                <td className="px-4 py-2 sm:pl-5">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="min-w-0 truncate">{entryLabel(entry)}</span>
                    {KIND_DESCRIPTIONS[entry.kind] ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground"
                              aria-label={`${entryLabel(entry)} details`}
                            >
                              <InfoIcon className="size-3" />
                            </button>
                          }
                        />
                        <TooltipPopup side="top">
                          <span className="block max-w-72">{KIND_DESCRIPTIONS[entry.kind]}</span>
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                </td>
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
                : breakdown?.status === "failed" || query.error
                  ? "No breakdown yet."
                  : "Measuring what T3 stores on this disk…"
            }
          />
        )}
      </div>
    </SettingsSection>
  );
}
