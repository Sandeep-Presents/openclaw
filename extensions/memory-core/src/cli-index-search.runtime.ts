import path from "node:path";
import { resolveMemorySearchStaleness } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  defaultRuntime,
  formatErrorMessage,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  withProgressTotals,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { getRuntimeConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDeepDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { resolveForeignMemorySlotOwner } from "./cli-memory-slot.js";
import {
  emitMemoryCoreSidecarNotice,
  formatExtraPaths,
  formatMemoryIndexOutcome,
  resolveMemoryAgent,
  resolveMemoryPluginConfig,
  scanMemoryManagerSources,
  withMemoryCommand,
} from "./cli-runtime-common.js";
import type {
  MemoryCommandOptions,
  MemoryForgetCommandOptions,
  MemorySearchCommandOptions,
} from "./cli.types.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import { captureMemoryRebuildNotice } from "./memory-rebuild-notice.js";
import { formatMemoryVectorDegradedWriteReason } from "./memory/manager-vector-warning.js";
import type { MemoryCoreRuntimeHost } from "./memory/runtime-host.js";
import { recordShortTermRecalls } from "./short-term-promotion.js";
const { accent, heading, info, muted, success, warn } = theme;
function formatSourceLabel(source: string, workspaceDir: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    return "sessions (current transcripts + retained transcript artifacts)";
  }
  return source;
}
export async function runMemoryIndex(
  opts: MemoryCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  setVerbose(Boolean(opts.verbose));
  await withMemoryCommand({
    commandName: "memory index",
    agent: opts.agent,
    allAgents: true,
    purpose: "cli",
    inspectSources: true,
    ...hostOptions,
    run: async ({ manager, agentId }) => {
      try {
        const syncFn = manager.sync ? manager.sync.bind(manager) : undefined;
        if (opts.verbose) {
          const status = manager.status();
          const label = (text: string) => muted(`${text}:`);
          const sourceLabels = (status.sources ?? []).map((source) =>
            formatSourceLabel(source, status.workspaceDir ?? ""),
          );
          const extraPaths = status.workspaceDir
            ? formatExtraPaths(status.workspaceDir, status.extraPaths ?? [])
            : [];
          const requestedProvider = status.requestedProvider ?? status.provider;
          const modelLabel = status.model ?? status.provider;
          const lines = [
            `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
            `${label("Provider")} ${info(status.provider)} ${muted(
              `(requested: ${requestedProvider})`,
            )}`,
            `${label("Model")} ${info(modelLabel)}`,
            sourceLabels.length ? `${label("Sources")} ${info(sourceLabels.join(", "))}` : null,
            extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
          ].filter(Boolean) as string[];
          if (status.fallback) {
            lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
          }
          defaultRuntime.log(lines.join("\n"));
          defaultRuntime.log("");
        }
        const startedAt = Date.now();
        let lastLabel = "Indexing memory…";
        let lastCompleted = 0;
        let lastTotal = 0;
        const formatDuration = (elapsedMs: number) => {
          const seconds = Math.floor(elapsedMs / 1000);
          return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        };
        const buildLabel = () => {
          const elapsedMs = Math.max(1, Date.now() - startedAt);
          const elapsed = formatDuration(elapsedMs);
          if (lastTotal <= 0 || lastCompleted <= 0) {
            return `${lastLabel} · elapsed ${elapsed}`;
          }
          const remainingMs = Math.max(
            0,
            ((lastTotal - lastCompleted) * elapsedMs) / lastCompleted,
          );
          return `${lastLabel} · elapsed ${elapsed} · eta ${formatDuration(remainingMs)}`;
        };
        if (!syncFn) {
          defaultRuntime.log("Memory backend does not support manual reindex.");
          return;
        }
        await withProgressTotals(
          {
            label: "Indexing memory…",
            total: 0,
            fallback: opts.verbose ? "line" : undefined,
          },
          async (update, progress) => {
            const interval = setInterval(() => {
              progress.setLabel(buildLabel());
            }, 1000);
            try {
              await syncFn({
                reason: "cli",
                force: Boolean(opts.force),
                progress: (syncUpdate) => {
                  if (syncUpdate.label) {
                    lastLabel = syncUpdate.label;
                  }
                  lastCompleted = syncUpdate.completed;
                  lastTotal = syncUpdate.total;
                  update({
                    completed: syncUpdate.completed,
                    total: syncUpdate.total,
                    label: buildLabel(),
                  });
                  progress.setLabel(buildLabel());
                },
              });
            } finally {
              clearInterval(interval);
            }
          },
        );
        let postIndexStatus = manager.status();
        const scan = await scanMemoryManagerSources(postIndexStatus);
        const outcome = formatMemoryIndexOutcome(postIndexStatus, scan, agentId);
        let semanticVectorAvailable = postIndexStatus.vector?.semanticAvailable;
        const vectorStoreAvailable =
          postIndexStatus.vector?.storeAvailable ?? postIndexStatus.vector?.available;
        if (
          postIndexStatus.backend === "builtin" &&
          (postIndexStatus.vector?.enabled ?? false) &&
          semanticVectorAvailable === undefined &&
          vectorStoreAvailable !== false &&
          typeof manager.probeVectorAvailability === "function"
        ) {
          semanticVectorAvailable = await manager.probeVectorAvailability();
          postIndexStatus = manager.status();
          semanticVectorAvailable =
            postIndexStatus.vector?.semanticAvailable ?? semanticVectorAvailable;
        }
        const vectorEnabled = postIndexStatus.vector?.enabled ?? false;
        const vectorAvailable =
          semanticVectorAvailable ??
          postIndexStatus.vector?.semanticAvailable ??
          postIndexStatus.vector?.available ??
          postIndexStatus.vector?.storeAvailable;
        const vectorLoadErr = postIndexStatus.vector?.loadError;
        defaultRuntime.log(outcome);
        if (vectorEnabled && vectorAvailable === false) {
          // Indexing still persisted chunks/FTS state; keep the command successful but
          // emit a stderr warning so operators and scripts can detect degraded recall.
          defaultRuntime.error(
            `Memory index WARNING (${agentId}): chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(vectorLoadErr)}. Vector recall degraded.`,
          );
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
        process.exitCode = 1;
      }
    },
  });
}
export async function runMemorySearch(
  query: string,
  opts: MemorySearchCommandOptions,
  hostOptions?: MemoryCoreRuntimeHost,
) {
  await withMemoryCommand({
    commandName: "memory search",
    agent: opts.agent,
    diagnosticsToStderr: Boolean(opts.json),
    onUnavailable: opts.json ? defaultRuntime.writeJson : undefined,
    requiresMemorySlot: true,
    purpose: "cli",
    inspectSources: true,
    ...hostOptions,
    run: async ({ manager, cfg, agentId }) => {
      const memoryPluginConfig = resolveMemoryPluginConfig(cfg);
      const dreamingEnabled = resolveMemoryDreamingConfig({
        pluginConfig: memoryPluginConfig,
        cfg,
      }).enabled;
      const dreaming = resolveMemoryDeepDreamingConfig({
        pluginConfig: memoryPluginConfig,
        cfg,
      });
      const sessionKey = buildAgentSessionKey({
        agentId,
        channel: "cli",
        peer: { kind: "direct", id: "memory-search" },
        dmScope: "per-channel-peer",
      });
      let readRebuildWarning: () => string | undefined = () => undefined;
      let results: Awaited<ReturnType<typeof manager.search>>;
      try {
        readRebuildWarning = captureMemoryRebuildNotice(manager.status());
        results = await manager.search(query, {
          maxResults: opts.maxResults,
          minScore: opts.minScore,
          sessionKey,
        });
      } catch (err) {
        const message = formatErrorMessage(err);
        throw new Error(
          [`Memory search failed: ${message}`, readRebuildWarning()].filter(Boolean).join(" "),
          { cause: err },
        );
      }
      const status = manager.status();
      const staleness = resolveMemorySearchStaleness(status, agentId);
      const warning = [staleness?.warning, readRebuildWarning()]
        .filter((message): message is string => typeof message === "string")
        .join(" ");
      const workspaceDir = status.workspaceDir;
      if (dreamingEnabled) {
        await recordShortTermRecalls({
          workspaceDir,
          query,
          results,
          timezone: dreaming.timezone,
        }).catch(() => {
          // Persistence is best-effort, but the short-lived CLI must await it
          // so process exit cannot discard an in-flight recall write.
        });
      }
      if (opts.json) {
        defaultRuntime.writeJson({ results, ...staleness, ...(warning ? { warning } : {}) });
        return;
      }
      if (warning) {
        defaultRuntime.error([warning, staleness?.action].filter(Boolean).join(" "));
      }
      if (results.length === 0) {
        defaultRuntime.log("No matches.");
        return;
      }
      const lines: string[] = [];
      for (const result of results) {
        lines.push(
          `${success(result.score.toFixed(3))} ${accent(`${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`)}`,
        );
        lines.push(muted(result.snippet));
        lines.push("");
      }
      defaultRuntime.log(lines.join("\n").trim());
    },
  });
}

export async function runMemoryForget(opts: MemoryForgetCommandOptions) {
  try {
    const cfg = getRuntimeConfig({ skipPluginValidation: true });
    const agentId = resolveMemoryAgent(cfg, opts.agent);
    const slotOwner = resolveForeignMemorySlotOwner(cfg);
    if (slotOwner) {
      emitMemoryCoreSidecarNotice(slotOwner, { json: Boolean(opts.json) });
    }
    const report = await forgetMemoryEntries({
      cfg,
      agentId,
      sessionIds: opts.session,
      hookSources: opts.hookSource,
      participants: opts.participant,
      since: opts.since,
      dryRun: Boolean(opts.dryRun),
    });
    if (opts.json) {
      defaultRuntime.writeJson(report);
      return;
    }
    const lines = [
      `${heading(report.dryRun ? "Memory Deletion Preview" : "Memory Deletion")} ${muted(`(${agentId})`)}`,
      `${muted("Source sessions:")} ${report.sessionIds.length}`,
      `${muted("Source transcripts retained:")} ${report.sessionIds.length}`,
      `${muted("Deleted entries:")} ${report.entryKeys.length}`,
      `${muted("Mixed-lineage entries deleted whole:")} ${report.mixedLineageEntryKeys.length}`,
      `${muted("Entries without targetable provenance:")} ${report.untargetableEntryKeys.length}`,
      `${muted("Curated writes retained:")} ${report.curatedWrites.length}`,
      `${muted("Memory artifacts:")} ${report.artifacts.memoryFiles} files, ${report.artifacts.memoryEntries} entries, ${report.artifacts.memoryLines} quoted lines`,
      `${muted("Session corpus:")} ${report.artifacts.sessionCorpusFiles} files, ${report.artifacts.sessionCorpusLines} lines`,
      `${muted("Index artifacts:")} ${report.artifacts.indexChunks} chunks, ${report.artifacts.indexSources} sources, ${report.artifacts.ftsRows} full-text rows, ${report.artifacts.vectorRows} vector rows, ${report.artifacts.embeddingCacheRows} cached embeddings`,
      `${muted("Plugin state:")} ${report.artifacts.shortTermEntries} short-term entries, ${report.artifacts.seenHashScopes} seen-hash scopes, ${report.artifacts.backups} backups`,
      `${muted("Origin rows:")} ${report.artifacts.originRows}`,
    ];
    if (report.sessionIds.length > 0) {
      lines.push(`${muted("Session IDs:")} ${report.sessionIds.join(", ")}`);
    }
    for (const session of report.sessionResolutions) {
      lines.push(`${muted("Session resolution:")} ${session.sessionId} (${session.source})`);
    }
    for (const match of report.participantMatches) {
      lines.push(
        `${muted("Raw participant selector:")} ${match.actorId}: ${match.identities.map((identity) => JSON.stringify(identity)).join(", ") || "no live match"}. Matches select whole sessions across identity namespaces.`,
      );
    }
    if (report.mixedLineageEntryKeys.length > 0) {
      lines.push(
        `${muted("Mixed-lineage entry keys:")} ${report.mixedLineageEntryKeys.join(", ")}`,
      );
    }
    if (report.untargetableEntryKeys.length > 0) {
      lines.push(`${muted("Untargetable entry keys:")} ${report.untargetableEntryKeys.join(", ")}`);
    }
    for (const curatedWrite of report.curatedWrites) {
      lines.push(
        `${muted("Curated write retained:")} ${curatedWrite.relativePath} (${new Date(curatedWrite.observedAt).toISOString()})`,
      );
    }
    for (const refusal of report.refusals) {
      lines.push(warn(`Refused: ${refusal}`));
    }
    if (report.dryRun) {
      lines.push(muted("Dry run: no memory files, index rows, or plugin state were changed."));
    }
    defaultRuntime.log(lines.join("\n"));
  } catch (error) {
    throw new Error(`Memory forget failed: ${formatErrorMessage(error)}`, { cause: error });
  }
}
