import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CodexHistoryEntry,
  type CodexImportHistoryResult,
  type CodexSourceConfig,
  type CodexSourceKind,
} from "@t3tools/contracts";

import {
  bindCodexSourceFolderLabel,
  bindProjectCodexSourceIds,
  bindThreadCodexSourceIds,
  markCodexSourcesBootstrapped,
  resolveConfiguredCodexSources,
  resolveDefaultCodexSourceId,
  useAppSettings,
} from "../appSettings";
import { buildCodexSourceSettingsCardId, takePendingCodexSourceFocus } from "../codexSourceUi";
import { ensureNativeApi } from "../nativeApi";
import { useStore } from "../store";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";

const HISTORY_LIST_LIMIT = 1000;
const HISTORY_IMPORT_LIMIT = 1000;

const SOURCE_KIND_OPTIONS: ReadonlyArray<{ label: string; value: CodexSourceKind }> = [
  { label: "Local", value: "local" },
  { label: "Remote WS", value: "remoteWs" },
  { label: "Remote SSH", value: "remoteSsh" },
];

const SOURCE_KIND_LABEL: Record<CodexSourceKind, string> = {
  local: "Local",
  remoteWs: "Remote WS",
  remoteSsh: "Remote SSH",
};

interface CodexSourceDraft {
  kind: CodexSourceKind;
  id: string;
  name: string;
  binaryPath: string;
  homePath: string;
  appServerUrl: string;
  sshHost: string;
  remoteCodexHome: string;
}

const DEFAULT_CODEX_SOURCE_DRAFT: CodexSourceDraft = {
  kind: "remoteSsh",
  id: "",
  name: "",
  binaryPath: "",
  homePath: "",
  appServerUrl: "ws://127.0.0.1:14500",
  sshHost: "mac-codex",
  remoteCodexHome: "~/.codex",
};

function parseSessionIds(value: string): string[] {
  const sessionIds: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value.split(/[\s,]+/)) {
    const normalized = candidate.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    sessionIds.push(normalized);
  }
  return sessionIds;
}

function buildCodexSourceFromDraft(
  draft: CodexSourceDraft,
): { source: CodexSourceConfig } | { error: string } {
  const id = draft.id.trim();
  const name = draft.name.trim();
  if (!id) {
    return { error: "Source ID is required." };
  }
  if (!name) {
    return { error: "Source name is required." };
  }

  switch (draft.kind) {
    case "local":
      return {
        source: {
          id,
          name,
          kind: "local",
          ...(draft.binaryPath.trim() ? { binaryPath: draft.binaryPath.trim() } : {}),
          ...(draft.homePath.trim() ? { homePath: draft.homePath.trim() } : {}),
        },
      };
    case "remoteWs": {
      const appServerUrl = draft.appServerUrl.trim();
      if (!appServerUrl) {
        return { error: "App server URL is required for a remote WS source." };
      }
      return {
        source: {
          id,
          name,
          kind: "remoteWs",
          appServerUrl,
        },
      };
    }
    case "remoteSsh": {
      const sshHost = draft.sshHost.trim();
      const appServerUrl = draft.appServerUrl.trim();
      if (!sshHost) {
        return { error: "SSH host is required for a remote SSH source." };
      }
      if (!appServerUrl) {
        return { error: "App server URL is required for a remote SSH source." };
      }
      return {
        source: {
          id,
          name,
          kind: "remoteSsh",
          sshHost,
          appServerUrl,
          ...(draft.remoteCodexHome.trim()
            ? { remoteCodexHome: draft.remoteCodexHome.trim() }
            : {}),
        },
      };
    }
  }
}

function formatImportSummary(result: CodexImportHistoryResult): string {
  const summary = [`Mirrored ${result.importedCount}`];
  if (result.skippedCount > 0) {
    summary.push(`skipped ${result.skippedCount}`);
  }
  return `${summary.join(", ")} session${result.importedCount === 1 ? "" : "s"}.`;
}

function getCodexSourceDetails(source: CodexSourceConfig): Array<{ label: string; value: string }> {
  switch (source.kind) {
    case "local":
      return [
        {
          label: "Binary",
          value: source.binaryPath ?? "Inherited from app settings",
        },
        {
          label: "Codex home",
          value: source.homePath ?? "Inherited from app settings",
        },
      ];
    case "remoteWs":
      return [
        {
          label: "App server",
          value: source.appServerUrl,
        },
      ];
    case "remoteSsh":
      return [
        {
          label: "SSH host",
          value: source.sshHost,
        },
        {
          label: "App server",
          value: source.appServerUrl,
        },
        {
          label: "Remote Codex home",
          value: source.remoteCodexHome ?? "~/.codex",
        },
      ];
  }
}

export default function CodexSourcesSettingsSection() {
  const { settings, defaults, updateSettings } = useAppSettings();
  const syncServerReadModel = useStore((store) => store.syncServerReadModel);
  const codexSources = useMemo(() => resolveConfiguredCodexSources(settings), [settings]);
  const defaultCodexSourceId = useMemo(() => resolveDefaultCodexSourceId(settings), [settings]);
  const defaultSources = useMemo(() => resolveConfiguredCodexSources(defaults), [defaults]);
  const defaultDefaultCodexSourceId = useMemo(
    () => resolveDefaultCodexSourceId(defaults),
    [defaults],
  );
  const sourcesDirty = useMemo(
    () =>
      JSON.stringify(codexSources) !== JSON.stringify(defaultSources) ||
      defaultCodexSourceId !== defaultDefaultCodexSourceId,
    [codexSources, defaultCodexSourceId, defaultDefaultCodexSourceId, defaultSources],
  );

  const [sourceDraft, setSourceDraft] = useState<CodexSourceDraft>(DEFAULT_CODEX_SOURCE_DRAFT);
  const [sourceDraftError, setSourceDraftError] = useState<string | null>(null);
  const [historyEntriesBySourceId, setHistoryEntriesBySourceId] = useState<
    Record<string, CodexHistoryEntry[]>
  >({});
  const [selectedHistoryIdsBySourceId, setSelectedHistoryIdsBySourceId] = useState<
    Record<string, string[]>
  >({});
  const [manualHistoryIdsBySourceId, setManualHistoryIdsBySourceId] = useState<
    Record<string, string>
  >({});
  const [historyInfoBySourceId, setHistoryInfoBySourceId] = useState<Record<string, string | null>>({});
  const [historyErrorBySourceId, setHistoryErrorBySourceId] = useState<
    Record<string, string | null>
  >({});
  const [loadingHistoryBySourceId, setLoadingHistoryBySourceId] = useState<Record<string, boolean>>(
    {},
  );
  const [importingHistoryBySourceId, setImportingHistoryBySourceId] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    const pendingSourceId = takePendingCodexSourceFocus();
    if (!pendingSourceId) {
      return;
    }
    window.setTimeout(() => {
      document
        .getElementById(buildCodexSourceSettingsCardId(pendingSourceId))
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 0);
  }, []);

  const addSource = useCallback(() => {
    const builtSource = buildCodexSourceFromDraft(sourceDraft);
    if ("error" in builtSource) {
      setSourceDraftError(builtSource.error);
      return;
    }
    if (codexSources.some((source) => source.id === builtSource.source.id)) {
      setSourceDraftError(`A source with ID "${builtSource.source.id}" already exists.`);
      return;
    }

    updateSettings({
      codexSources: [...codexSources, builtSource.source],
    });
    setSourceDraft(DEFAULT_CODEX_SOURCE_DRAFT);
    setSourceDraftError(null);
  }, [codexSources, sourceDraft, updateSettings]);

  const removeSource = useCallback(
    (sourceId: string) => {
      if (sourceId === "local") {
        return;
      }
      updateSettings({
        codexSources: codexSources.filter((source) => source.id !== sourceId),
        defaultCodexSourceId:
          defaultCodexSourceId === sourceId ? defaultDefaultCodexSourceId : defaultCodexSourceId,
        threadCodexSourceBindings: Object.fromEntries(
          Object.entries(settings.threadCodexSourceBindings).filter(
            ([, boundSourceId]) => boundSourceId !== sourceId,
          ),
        ),
        projectCodexSourceBindings: Object.fromEntries(
          Object.entries(settings.projectCodexSourceBindings).filter(
            ([, boundSourceId]) => boundSourceId !== sourceId,
          ),
        ),
        bootstrappedCodexSourceIds: settings.bootstrappedCodexSourceIds.filter(
          (existingSourceId) => existingSourceId !== sourceId,
        ),
      });
      setHistoryEntriesBySourceId((existing) => {
        const next = { ...existing };
        delete next[sourceId];
        return next;
      });
      setSelectedHistoryIdsBySourceId((existing) => {
        const next = { ...existing };
        delete next[sourceId];
        return next;
      });
      setManualHistoryIdsBySourceId((existing) => {
        const next = { ...existing };
        delete next[sourceId];
        return next;
      });
      setHistoryInfoBySourceId((existing) => {
        const next = { ...existing };
        delete next[sourceId];
        return next;
      });
      setHistoryErrorBySourceId((existing) => {
        const next = { ...existing };
        delete next[sourceId];
        return next;
      });
    },
    [codexSources, defaultCodexSourceId, defaultDefaultCodexSourceId, settings, updateSettings],
  );

  const restoreDefaultSources = useCallback(() => {
    updateSettings({
      codexSources: defaultSources,
      defaultCodexSourceId: defaultDefaultCodexSourceId,
      threadCodexSourceBindings: Object.fromEntries(
        Object.entries(settings.threadCodexSourceBindings).filter(([, sourceId]) =>
          defaultSources.some((source) => source.id === sourceId),
        ),
      ),
      projectCodexSourceBindings: Object.fromEntries(
        Object.entries(settings.projectCodexSourceBindings).filter(([, sourceId]) =>
          defaultSources.some((source) => source.id === sourceId),
        ),
      ),
      bootstrappedCodexSourceIds: settings.bootstrappedCodexSourceIds.filter((sourceId) =>
        defaultSources.some((source) => source.id === sourceId),
      ),
    });
  }, [
    defaultDefaultCodexSourceId,
    defaultSources,
    settings.bootstrappedCodexSourceIds,
    settings.projectCodexSourceBindings,
    settings.threadCodexSourceBindings,
    updateSettings,
  ]);

  const toggleHistorySelection = useCallback(
    (sourceId: string, sessionId: string, checked: boolean) => {
      setSelectedHistoryIdsBySourceId((existing) => {
        const nextSelection = new Set(existing[sourceId] ?? []);
        if (checked) {
          nextSelection.add(sessionId);
        } else {
          nextSelection.delete(sessionId);
        }
        return {
          ...existing,
          [sourceId]: [...nextSelection],
        };
      });
    },
    [],
  );

  const selectVisibleHistory = useCallback((sourceId: string) => {
    setSelectedHistoryIdsBySourceId((existing) => ({
      ...existing,
      [sourceId]: (historyEntriesBySourceId[sourceId] ?? []).map((entry) => entry.sessionId),
    }));
  }, [historyEntriesBySourceId]);

  const clearSelectedHistory = useCallback((sourceId: string) => {
    setSelectedHistoryIdsBySourceId((existing) => ({
      ...existing,
      [sourceId]: [],
    }));
  }, []);

  const loadHistory = useCallback(async (source: CodexSourceConfig) => {
    setLoadingHistoryBySourceId((existing) => ({
      ...existing,
      [source.id]: true,
    }));
    setHistoryErrorBySourceId((existing) => ({
      ...existing,
      [source.id]: null,
    }));
    setHistoryInfoBySourceId((existing) => ({
      ...existing,
      [source.id]: null,
    }));

    try {
      const api = ensureNativeApi();
      const entries = await api.server.listCodexHistory({
        source,
        limit: HISTORY_LIST_LIMIT,
      });
      setHistoryEntriesBySourceId((existing) => ({
        ...existing,
        [source.id]: entries,
      }));
      setSelectedHistoryIdsBySourceId((existing) => ({
        ...existing,
        [source.id]: (existing[source.id] ?? []).filter((sessionId) =>
          entries.some((entry) => entry.sessionId === sessionId),
        ),
      }));
      setHistoryInfoBySourceId((existing) => ({
        ...existing,
        [source.id]: `Loaded ${entries.length} session${entries.length === 1 ? "" : "s"}.`,
      }));
    } catch (error) {
      setHistoryErrorBySourceId((existing) => ({
        ...existing,
        [source.id]: error instanceof Error ? error.message : "Failed to load Codex history.",
      }));
    } finally {
      setLoadingHistoryBySourceId((existing) => ({
        ...existing,
        [source.id]: false,
      }));
    }
  }, []);

  const importHistory = useCallback(
    async (source: CodexSourceConfig, mode: "recent" | "selected") => {
      const manualSessionIds = parseSessionIds(manualHistoryIdsBySourceId[source.id] ?? "");
      const selectedSessionIds = selectedHistoryIdsBySourceId[source.id] ?? [];
      const sessionIds = [...new Set([...manualSessionIds, ...selectedSessionIds])];

        if (mode === "selected" && sessionIds.length === 0) {
          setHistoryErrorBySourceId((existing) => ({
            ...existing,
            [source.id]: "Select one or more sessions, or paste session IDs to mirror.",
          }));
          return;
        }

      setImportingHistoryBySourceId((existing) => ({
        ...existing,
        [source.id]: true,
      }));
      setHistoryErrorBySourceId((existing) => ({
        ...existing,
        [source.id]: null,
      }));
      setHistoryInfoBySourceId((existing) => ({
        ...existing,
        [source.id]: null,
      }));

      try {
        const api = ensureNativeApi();
        const result = await api.server.importCodexHistory(
          mode === "selected"
            ? {
                source,
                sessionIds,
                syncContent: true,
              }
            : {
                source,
                limit: HISTORY_IMPORT_LIMIT,
                syncContent: true,
              },
        );
        const snapshot = await api.orchestration.getSnapshot();
        syncServerReadModel(snapshot);
        updateSettings({
          threadCodexSourceBindings: bindThreadCodexSourceIds(settings, result.threadIds, source.id),
          projectCodexSourceBindings: bindProjectCodexSourceIds(settings, result.projectIds, source.id),
          ...(result.sourceFolderLabel
            ? {
                codexSourceFolderLabels: bindCodexSourceFolderLabel(
                  settings,
                  source.id,
                  result.sourceFolderLabel,
                ),
              }
            : {}),
          bootstrappedCodexSourceIds: markCodexSourcesBootstrapped(settings, [source.id]),
        });
        setHistoryInfoBySourceId((existing) => ({
          ...existing,
          [source.id]: formatImportSummary(result),
        }));
      } catch (error) {
        setHistoryErrorBySourceId((existing) => ({
          ...existing,
          [source.id]: error instanceof Error ? error.message : "Failed to mirror Codex history.",
        }));
      } finally {
        setImportingHistoryBySourceId((existing) => ({
          ...existing,
          [source.id]: false,
        }));
      }
    },
    [manualHistoryIdsBySourceId, selectedHistoryIdsBySourceId, settings, syncServerReadModel, updateSettings],
  );

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-foreground">Codex Sources</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Manage local and remote Codex app-server targets, then mirror historical sessions into
            the thread list.
          </p>
        </div>

        {sourcesDirty ? (
          <Button size="xs" variant="outline" onClick={restoreDefaultSources}>
            Restore defaults
          </Button>
        ) : null}
      </div>

      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-background p-4">
          <div className="mb-2">
            <p className="text-sm font-medium text-foreground">Default source</p>
            <p className="mt-1 text-xs text-muted-foreground">
              New threads use this source until you pin a specific one on the chat screen.
            </p>
          </div>

          <Select
            items={codexSources.map((source) => ({ label: source.name, value: source.id }))}
            value={defaultCodexSourceId}
            onValueChange={(value) => {
              if (!value) return;
              updateSettings({ defaultCodexSourceId: value });
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {codexSources.map((source) => (
                <SelectItem key={source.id} value={source.id}>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{source.name}</span>
                    <span className="text-[11px] text-muted-foreground uppercase tracking-[0.08em]">
                      {SOURCE_KIND_LABEL[source.kind]}
                    </span>
                  </div>
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        <div className="space-y-3">
          {codexSources.map((source) => {
            const historyEntries = historyEntriesBySourceId[source.id] ?? [];
            const selectedSessionIds = new Set(selectedHistoryIdsBySourceId[source.id] ?? []);
            const manualSessionIds = manualHistoryIdsBySourceId[source.id] ?? "";
            const selectedSessionCount =
              parseSessionIds(manualSessionIds).length + selectedSessionIds.size;
            const isLoadingHistory = loadingHistoryBySourceId[source.id] === true;
            const isImportingHistory = importingHistoryBySourceId[source.id] === true;
            const hasLoadedHistory = Object.prototype.hasOwnProperty.call(
              historyEntriesBySourceId,
              source.id,
            );

            return (
              <div
                key={source.id}
                id={buildCodexSourceSettingsCardId(source.id)}
                className="rounded-xl border border-border bg-background p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{source.name}</h3>
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
                        {SOURCE_KIND_LABEL[source.kind]}
                      </span>
                      {defaultCodexSourceId === source.id ? (
                        <span className="rounded-full border border-primary/40 bg-primary/8 px-2 py-0.5 text-[10px] uppercase tracking-[0.08em] text-primary">
                          Default
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {source.id}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isLoadingHistory || isImportingHistory}
                      onClick={() => void loadHistory(source)}
                    >
                      {isLoadingHistory ? "Loading..." : "Load history"}
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isImportingHistory || isLoadingHistory}
                      onClick={() => void importHistory(source, "recent")}
                    >
                      {isImportingHistory ? "Mirroring..." : `Mirror recent ${HISTORY_IMPORT_LIMIT}`}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={source.id === "local" || isImportingHistory || isLoadingHistory}
                      onClick={() => removeSource(source.id)}
                    >
                      Remove
                    </Button>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {getCodexSourceDetails(source).map((detail) => (
                    <div
                      key={`${source.id}:${detail.label}`}
                      className="rounded-lg border border-border bg-card px-3 py-2"
                    >
                      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                        {detail.label}
                      </p>
                      <p className="mt-1 break-all font-mono text-[11px] text-foreground">
                        {detail.value}
                      </p>
                    </div>
                  ))}
                </div>

                <div className="mt-4 space-y-2">
                  <div>
                    <p className="text-xs font-medium text-foreground">Manual session IDs</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Paste one or more session IDs when a source can mirror history but cannot list
                      it directly.
                    </p>
                  </div>
                  <Textarea
                    size="sm"
                    value={manualSessionIds}
                    onChange={(event) =>
                      setManualHistoryIdsBySourceId((existing) => ({
                        ...existing,
                        [source.id]: event.target.value,
                      }))
                    }
                    placeholder="Optional: paste session IDs, one per line or comma-separated"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Remote SSH sources can usually load history. Remote WS sources often need pasted
                      session IDs.
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isImportingHistory || isLoadingHistory || selectedSessionCount === 0}
                      onClick={() => void importHistory(source, "selected")}
                    >
                      {isImportingHistory ? "Mirroring..." : "Mirror selected / IDs"}
                    </Button>
                  </div>
                </div>

                {historyInfoBySourceId[source.id] ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {historyInfoBySourceId[source.id]}
                  </p>
                ) : null}
                {historyErrorBySourceId[source.id] ? (
                  <p className="mt-3 text-xs text-destructive">{historyErrorBySourceId[source.id]}</p>
                ) : null}

                {hasLoadedHistory ? (
                  historyEntries.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-xs font-medium text-foreground">Visible history</p>
                        <div className="flex items-center gap-2">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => selectVisibleHistory(source.id)}
                          >
                            Select visible
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => clearSelectedHistory(source.id)}
                          >
                            Clear
                          </Button>
                        </div>
                      </div>
                      <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                        {historyEntries.map((entry) => (
                          <label
                            key={`${source.id}:${entry.sessionId}`}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 hover:bg-accent"
                          >
                            <Checkbox
                              checked={selectedSessionIds.has(entry.sessionId)}
                              onCheckedChange={(checked) =>
                                toggleHistorySelection(source.id, entry.sessionId, Boolean(checked))
                              }
                              aria-label={`Select ${entry.title}`}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm text-foreground">{entry.title}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                                <span className="break-all font-mono">{entry.sessionId}</span>
                                <span>{new Date(entry.createdAt ?? entry.updatedAt).toLocaleString()}</span>
                              </div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 rounded-lg border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground">
                      No history entries found for this source.
                    </div>
                  )
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="rounded-xl border border-dashed border-border bg-background p-4">
          <div className="mb-3">
            <h3 className="text-sm font-medium text-foreground">Add source</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Create reusable Codex targets for local Windows, tunneled app-server URLs, or SSH-backed
              Macs.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Source type</p>
              <Select
                items={SOURCE_KIND_OPTIONS.map((option) => ({
                  label: option.label,
                  value: option.value,
                }))}
                value={sourceDraft.kind}
                onValueChange={(value) => {
                  if (!value) return;
                  setSourceDraft((existing) => ({
                    ...existing,
                    kind: value as CodexSourceKind,
                  }));
                  setSourceDraftError(null);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {SOURCE_KIND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-foreground">Source ID</p>
              <Input
                value={sourceDraft.id}
                onChange={(event) => {
                  setSourceDraft((existing) => ({
                    ...existing,
                    id: event.target.value,
                  }));
                  setSourceDraftError(null);
                }}
                placeholder="mac-codex"
              />
            </div>

            <div className="space-y-1.5 sm:col-span-2">
              <p className="text-xs font-medium text-foreground">Display name</p>
              <Input
                value={sourceDraft.name}
                onChange={(event) => {
                  setSourceDraft((existing) => ({
                    ...existing,
                    name: event.target.value,
                  }));
                  setSourceDraftError(null);
                }}
                placeholder="MacBook Codex"
              />
            </div>

            {sourceDraft.kind === "local" ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Binary path</p>
                  <Input
                    value={sourceDraft.binaryPath}
                    onChange={(event) =>
                      setSourceDraft((existing) => ({
                        ...existing,
                        binaryPath: event.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Codex home path</p>
                  <Input
                    value={sourceDraft.homePath}
                    onChange={(event) =>
                      setSourceDraft((existing) => ({
                        ...existing,
                        homePath: event.target.value,
                      }))
                    }
                    placeholder="Optional"
                  />
                </div>
              </>
            ) : null}

            {sourceDraft.kind === "remoteWs" ? (
              <div className="space-y-1.5 sm:col-span-2">
                <p className="text-xs font-medium text-foreground">App server URL</p>
                <Input
                  value={sourceDraft.appServerUrl}
                  onChange={(event) =>
                    setSourceDraft((existing) => ({
                      ...existing,
                      appServerUrl: event.target.value,
                    }))
                  }
                  placeholder="ws://127.0.0.1:14500"
                />
              </div>
            ) : null}

            {sourceDraft.kind === "remoteSsh" ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">SSH host</p>
                  <Input
                    value={sourceDraft.sshHost}
                    onChange={(event) =>
                      setSourceDraft((existing) => ({
                        ...existing,
                        sshHost: event.target.value,
                      }))
                    }
                    placeholder="mac-codex"
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-foreground">Remote Codex home</p>
                  <Input
                    value={sourceDraft.remoteCodexHome}
                    onChange={(event) =>
                      setSourceDraft((existing) => ({
                        ...existing,
                        remoteCodexHome: event.target.value,
                      }))
                    }
                    placeholder="~/.codex"
                  />
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <p className="text-xs font-medium text-foreground">App server URL</p>
                  <Input
                    value={sourceDraft.appServerUrl}
                    onChange={(event) =>
                      setSourceDraft((existing) => ({
                        ...existing,
                        appServerUrl: event.target.value,
                      }))
                    }
                    placeholder="ws://127.0.0.1:14500"
                  />
                </div>
              </>
            ) : null}
          </div>

          {sourceDraftError ? (
            <p className="mt-3 text-xs text-destructive">{sourceDraftError}</p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Tip: for your LAN Mac setup, use a `remoteSsh` source with `sshHost` set to your SSH
              alias and `appServerUrl` set to the forwarded WebSocket endpoint on Windows.
            </p>
            <Button onClick={addSource}>Add source</Button>
          </div>
        </div>
      </div>
    </section>
  );
}
