import { execFile } from "node:child_process";
import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type CodexHistoryEntry,
  type CodexImportHistoryInput,
  type CodexImportHistoryResult,
  type CodexListHistoryInput,
  type CodexSourceConfig,
  type OrchestrationReadModel,
  type OrchestrationThreadActivityTone,
  type ProviderStartOptions,
  type TurnId,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";
import { buildCodexSourceProjectWorkspaceRoot } from "@t3tools/shared/codexSourceProject";
import { buildCodexSourceThreadId } from "@t3tools/shared/codexSourceThread";

import { CodexAppServerManager, type CodexThreadDetailsSnapshot } from "./codexAppServerManager";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryShape,
} from "./provider/Services/ProviderSessionDirectory";

const execFileAsync = promisify(execFile);
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_IMPORT_LIMIT = 50;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface CodexHistoryServices {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly providerSessionDirectory: ProviderSessionDirectoryShape;
  readonly runPromise: <A>(effect: Effect.Effect<A, any, any>) => Promise<A>;
}

interface ImportedThreadContext {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly sourceFolderLabel?: string;
}

interface SessionTarget {
  sessionId: string;
  title?: string;
  updatedAt?: string;
  createdAt?: string;
  cwd?: string;
}

export async function listCodexHistory(input: CodexListHistoryInput): Promise<CodexHistoryEntry[]> {
  const entries = await readSessionTargetsFromSource(input.source);
  const limit = input.limit ?? DEFAULT_LIST_LIMIT;
  if (limit <= 0) {
    return [];
  }
  return entries.slice(0, limit).map((entry) => ({
    sourceId: input.source.id,
    sessionId: entry.sessionId,
    title: normalizeSourceThreadTitle(entry.title, entry.sessionId),
    updatedAt: toIsoDateTime(entry.updatedAt, new Date().toISOString()),
    createdAt: toIsoDateTime(entry.createdAt ?? entry.updatedAt, new Date().toISOString()),
  }));
}

export async function importCodexHistory(
  services: CodexHistoryServices,
  input: CodexImportHistoryInput,
): Promise<CodexImportHistoryResult> {
  const availableTargets = await readSessionTargetsFromSource(input.source);
  const targetSessions = selectTargetSessions(availableTargets, input);
  await cleanupStaleMirrorsForSource(
    services,
    input.source.id,
    new Set(availableTargets.map((target) => target.sessionId)),
  );

  const projectIds = new Set<ProjectId>();
  const threadIds: ThreadId[] = [];
  const skippedSessionIds: string[] = [];
  let sourceFolderLabel: string | undefined;

  for (const target of targetSessions) {
    try {
      const mirrored =
        input.syncContent === true
          ? await syncSingleSession(services, input.source, target)
          : await ensureSingleSessionStub(services, input.source, target);
      projectIds.add(mirrored.projectId);
      threadIds.push(mirrored.threadId);
      sourceFolderLabel ??= mirrored.sourceFolderLabel;
    } catch (error) {
      console.warn("failed to mirror codex session", {
        sourceId: input.source.id,
        sessionId: target.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      skippedSessionIds.push(target.sessionId);
    }
  }

  sourceFolderLabel ??= await resolveSourceFolderLabel(input.source, targetSessions);

  return {
    importedCount: threadIds.length,
    skippedCount: skippedSessionIds.length,
    projectIds: [...projectIds],
    threadIds,
    skippedSessionIds,
    ...(sourceFolderLabel ? { sourceFolderLabel } : {}),
  };
}

function selectTargetSessions(
  availableTargets: readonly SessionTarget[],
  input: CodexImportHistoryInput,
): SessionTarget[] {
  const explicitSessionIds = Array.from(
    new Set(
      (input.sessionIds ?? [])
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (explicitSessionIds.length > 0) {
    const indexedEntriesBySessionId = new Map(
      availableTargets.map((entry) => [entry.sessionId, entry] as const),
    );

    return explicitSessionIds.map((sessionId) => {
      const indexedEntry = indexedEntriesBySessionId.get(sessionId);
      const nextTarget: SessionTarget = {
        sessionId,
      };
      if (indexedEntry?.title) {
        nextTarget.title = indexedEntry.title;
      }
      if (indexedEntry?.updatedAt) {
        nextTarget.updatedAt = indexedEntry.updatedAt;
      }
      if (indexedEntry?.createdAt) {
        nextTarget.createdAt = indexedEntry.createdAt;
      }
      if (indexedEntry?.cwd) {
        nextTarget.cwd = indexedEntry.cwd;
      }
      return nextTarget;
    });
  }

  const limit = input.limit ?? DEFAULT_IMPORT_LIMIT;
  if (limit <= 0) {
    return [];
  }

  return availableTargets.slice(0, limit);
}

async function readSessionTargetsFromSource(source: CodexSourceConfig): Promise<SessionTarget[]> {
  const indexedEntries = await readIndexedSessionTargets(source);
  if (source.kind !== "local") {
    return indexedEntries;
  }

  const indexedBySessionId = new Map(indexedEntries.map((entry) => [entry.sessionId, entry] as const));
  const fileEntries = await readLocalSessionTargets(source, indexedBySessionId);
  if (fileEntries.length === 0) {
    return indexedEntries;
  }

  const mergedBySessionId = new Map<string, SessionTarget>();
  for (const entry of fileEntries) {
    mergedBySessionId.set(entry.sessionId, entry);
  }
  for (const entry of indexedEntries) {
    if (!mergedBySessionId.has(entry.sessionId)) {
      mergedBySessionId.set(entry.sessionId, entry);
    }
  }

  return [...mergedBySessionId.values()].toSorted(compareSessionTargets);
}

async function readIndexedSessionTargets(source: CodexSourceConfig): Promise<SessionTarget[]> {
  try {
    const lines = await readSessionIndexLines(source);
    return parseSessionIndexLines(lines, source.id).map((entry) => ({
      sessionId: entry.sessionId,
      title: entry.title,
      updatedAt: entry.updatedAt,
    }));
  } catch {
    return [];
  }
}

async function ensureSingleSessionStub(
  services: CodexHistoryServices,
  source: CodexSourceConfig,
  target: SessionTarget,
): Promise<ImportedThreadContext> {
  const now = new Date().toISOString();
  const threadCreatedAt = target.createdAt ?? target.updatedAt ?? now;
  const threadUpdatedAt = target.updatedAt ?? now;
  const sourceFolderLabel = deriveSourceFolderLabelFromPath(target.cwd);
  const projectId = await ensureProjectForSource(services, source, threadUpdatedAt);
  const threadId = buildMirrorThreadId(source.id, target.sessionId);
  const threadTitle = normalizeSourceThreadTitle(target.title, target.sessionId);

  await cleanupLegacyMirrorsForSession(services, source.id, target.sessionId, threadId);

  const readModel = await readOrchestrationReadModel(services);
  const existingThread = readModel.threads.find((thread) => thread.id === threadId);

  if (!existingThread || existingThread.deletedAt !== null || existingThread.projectId !== projectId) {
    await resetMirrorThread(services, {
      projectId,
      threadId,
      title: threadTitle,
      createdAt: threadCreatedAt,
    });
  } else if (existingThread.title !== threadTitle) {
    await services.runPromise(
      services.orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: nextCommandId(),
        threadId,
        title: threadTitle,
      }),
    );
  }

  await upsertMirrorBinding(services, {
    source,
    sessionId: target.sessionId,
    threadId,
    ...(target.cwd ? { persistedCwd: target.cwd } : {}),
  });
  await setReadyThreadSession(services, threadId, threadUpdatedAt);

  return sourceFolderLabel ? { projectId, threadId, sourceFolderLabel } : { projectId, threadId };
}

async function syncSingleSession(
  services: CodexHistoryServices,
  source: CodexSourceConfig,
  target: SessionTarget,
): Promise<ImportedThreadContext> {
  const snapshot = await readThreadDetailsFromSource(source, target.sessionId);
  const now = new Date().toISOString();
  const threadCreatedAt = toIsoDateTime(target.createdAt ?? snapshot.createdAt, now);
  const threadUpdatedAt = toIsoDateTime(snapshot.updatedAt ?? target.updatedAt, threadCreatedAt);
  const persistedCwd = resolvePersistedCwd(snapshot, source, target.sessionId, target.cwd);
  const sourceFolderLabel =
    resolveSourceFolderLabelFromSnapshot(snapshot, persistedCwd) ?? deriveSourceFolderLabelFromPath(target.cwd);
  const projectId = await ensureProjectForSource(services, source, threadCreatedAt);
  const threadId = buildMirrorThreadId(source.id, target.sessionId);
  const threadTitle = normalizeSourceThreadTitle(snapshot.name?.trim() ? snapshot.name : target.title, target.sessionId);

  await cleanupLegacyMirrorsForSession(services, source.id, target.sessionId, threadId);

  const readModel = await readOrchestrationReadModel(services);
  const existingThread = readModel.threads.find((thread) => thread.id === threadId);
  if (existingThread?.deletedAt === null && existingThread.session?.status === "running") {
    if (existingThread.title !== threadTitle) {
      await services.runPromise(
        services.orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: nextCommandId(),
          threadId,
          title: threadTitle,
        }),
      );
    }
    await upsertMirrorBinding(services, {
      source,
      sessionId: target.sessionId,
      threadId,
      persistedCwd,
    });
    return sourceFolderLabel ? { projectId, threadId, sourceFolderLabel } : { projectId, threadId };
  }

  await resetMirrorThread(services, {
    projectId,
    threadId,
    title: threadTitle,
    createdAt: threadCreatedAt,
  });

  const timestampCursor = createTimestampCursor(threadCreatedAt);
  for (const turn of snapshot.turns) {
    for (const item of turn.items) {
      const importedMessage = toImportedMessage(item);
      if (importedMessage) {
        const at = timestampCursor.next();
        await services.runPromise(
          services.orchestrationEngine.dispatch({
            type: "thread.message.import",
            commandId: nextCommandId(),
            threadId,
            messageId: MessageId.makeUnsafe(crypto.randomUUID()),
            role: importedMessage.role,
            text: importedMessage.text,
            turnId: turn.id,
            createdAt: at,
            updatedAt: at,
          }),
        );
      }

      const importedActivity = toImportedActivity(item, turn.id);
      if (importedActivity) {
        const activityCreatedAt = timestampCursor.next();
        await services.runPromise(
          services.orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: nextCommandId(),
            threadId,
            activity: {
              id: EventId.makeUnsafe(crypto.randomUUID()),
              tone: importedActivity.tone,
              kind: importedActivity.kind,
              summary: importedActivity.summary,
              payload: importedActivity.payload,
              turnId: importedActivity.turnId,
              createdAt: activityCreatedAt,
            },
            createdAt: activityCreatedAt,
          }),
        );
      }
    }
  }

  await upsertMirrorBinding(services, {
    source,
    sessionId: target.sessionId,
    threadId,
    persistedCwd,
  });
  await setReadyThreadSession(services, threadId, threadUpdatedAt);

  return sourceFolderLabel ? { projectId, threadId, sourceFolderLabel } : { projectId, threadId };
}

async function readOrchestrationReadModel(
  services: CodexHistoryServices,
): Promise<OrchestrationReadModel> {
  return (await services.runPromise(services.orchestrationEngine.getReadModel())) as OrchestrationReadModel;
}

async function resetMirrorThread(
  services: CodexHistoryServices,
  input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly title: string;
    readonly createdAt: string;
  },
): Promise<void> {
  const readModel = await readOrchestrationReadModel(services);
  const existingThread = readModel.threads.find((thread) => thread.id === input.threadId);
  if (existingThread?.deletedAt === null) {
    await services.runPromise(
      services.orchestrationEngine.dispatch({
        type: "thread.delete",
        commandId: nextCommandId(),
        threadId: input.threadId,
      }),
    );
  }

  await services.runPromise(
    services.orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: nextCommandId(),
      threadId: input.threadId,
      projectId: input.projectId,
      title: input.title,
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    }),
  );
}

async function setReadyThreadSession(
  services: CodexHistoryServices,
  threadId: ThreadId,
  updatedAt: string,
): Promise<void> {
  await services.runPromise(
    services.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId,
      session: {
        threadId,
        status: "ready",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt,
      },
      createdAt: updatedAt,
    }),
  );
}

async function upsertMirrorBinding(
  services: CodexHistoryServices,
  input: {
    readonly source: CodexSourceConfig;
    readonly sessionId: string;
    readonly threadId: ThreadId;
    readonly persistedCwd?: string;
  },
): Promise<void> {
  await services.runPromise(
    services.providerSessionDirectory.upsert({
      threadId: input.threadId,
      provider: "codex",
      runtimeMode: "full-access",
      status: "stopped",
      resumeCursor: { threadId: input.sessionId },
      runtimePayload: {
        ...(input.persistedCwd ? { cwd: input.persistedCwd } : {}),
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
        providerOptions: toProviderStartOptions(input.source),
        sourceId: input.source.id,
        sourceName: input.source.name,
        sourceKind: input.source.kind,
        sourceSessionId: input.sessionId,
        sourceMirror: true,
        mirroredAt: new Date().toISOString(),
      },
    }),
  );
}

async function cleanupLegacyMirrorsForSession(
  services: CodexHistoryServices,
  sourceId: string,
  sessionId: string,
  keepThreadId: ThreadId,
): Promise<void> {
  const readModel = await readOrchestrationReadModel(services);
  const threadIds = (await services.runPromise(
    services.providerSessionDirectory.listThreadIds(),
  )) as ReadonlyArray<ThreadId>;

  for (const threadId of threadIds) {
    if (threadId === keepThreadId) {
      continue;
    }

    const bindingOption = (await services.runPromise(
      services.providerSessionDirectory.getBinding(threadId),
    )) as Option.Option<ProviderRuntimeBinding>;
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      continue;
    }

    const runtimePayload = readRecord(binding.runtimePayload);
    if (!runtimePayload || runtimePayload.sourceId !== sourceId) {
      continue;
    }

    const mirroredSessionId = readResumeCursorThreadId(binding.resumeCursor);
    if (mirroredSessionId !== sessionId) {
      continue;
    }

    const existingThread = readModel.threads.find((thread) => thread.id === threadId);
    if (existingThread?.deletedAt === null) {
      await services.runPromise(
        services.orchestrationEngine.dispatch({
          type: "thread.delete",
          commandId: nextCommandId(),
          threadId,
        }),
      );
    }
    await services.runPromise(services.providerSessionDirectory.remove(threadId));
  }
}

async function cleanupStaleMirrorsForSource(
  services: CodexHistoryServices,
  sourceId: string,
  availableSessionIds: ReadonlySet<string>,
): Promise<void> {
  const readModel = await readOrchestrationReadModel(services);
  const threadIds = (await services.runPromise(
    services.providerSessionDirectory.listThreadIds(),
  )) as ReadonlyArray<ThreadId>;

  for (const threadId of threadIds) {
    const bindingOption = (await services.runPromise(
      services.providerSessionDirectory.getBinding(threadId),
    )) as Option.Option<ProviderRuntimeBinding>;
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      continue;
    }

    const runtimePayload = readRecord(binding.runtimePayload);
    if (!runtimePayload || runtimePayload.sourceId !== sourceId || runtimePayload.sourceMirror !== true) {
      continue;
    }

    const mirroredSessionId = readResumeCursorThreadId(binding.resumeCursor);
    if (!mirroredSessionId || availableSessionIds.has(mirroredSessionId)) {
      continue;
    }

    const existingThread = readModel.threads.find((thread) => thread.id === threadId);
    if (existingThread?.deletedAt === null) {
      await services.runPromise(
        services.orchestrationEngine.dispatch({
          type: "thread.delete",
          commandId: nextCommandId(),
          threadId,
        }),
      );
    }
    await services.runPromise(services.providerSessionDirectory.remove(threadId));
  }
}

async function ensureProjectForSource(
  services: CodexHistoryServices,
  source: CodexSourceConfig,
  createdAt: string,
): Promise<ProjectId> {
  const readModel = await readOrchestrationReadModel(services);
  const workspaceRoot = buildCodexSourceProjectWorkspaceRoot(source.id);
  const existingProject = readModel.projects.find(
    (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
  );
  if (existingProject) {
    return existingProject.id;
  }

  const projectId = ProjectId.makeUnsafe(crypto.randomUUID());
  await services.runPromise(
    services.orchestrationEngine.dispatch({
      type: "project.create",
      commandId: nextCommandId(),
      projectId,
      title: source.name,
      workspaceRoot,
      defaultModel: DEFAULT_MODEL_BY_PROVIDER.codex,
      createdAt,
    }),
  );
  return projectId;
}

function buildMirrorThreadId(sourceId: string, sessionId: string): ThreadId {
  return ThreadId.makeUnsafe(buildCodexSourceThreadId(sourceId, sessionId));
}

async function readThreadDetailsFromSource(
  source: CodexSourceConfig,
  sessionId: string,
): Promise<CodexThreadDetailsSnapshot> {
  const manager = new CodexAppServerManager();
  const tempThreadId = ThreadId.makeUnsafe(`import:${crypto.randomUUID()}`);

  try {
    await manager.startSession({
      threadId: tempThreadId,
      runtimeMode: "full-access",
      resumeCursor: { threadId: sessionId },
      providerOptions: toProviderStartOptions(source),
    });
    return await manager.readThreadDetails(tempThreadId);
  } finally {
    try {
      manager.stopSession(tempThreadId);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function toProviderStartOptions(source: CodexSourceConfig): ProviderStartOptions | undefined {
  switch (source.kind) {
    case "local": {
      const codex = {
        ...(source.binaryPath ? { binaryPath: source.binaryPath } : {}),
        ...(source.homePath ? { homePath: source.homePath } : {}),
      };
      return Object.keys(codex).length > 0 ? { codex } : undefined;
    }
    case "remoteWs":
    case "remoteSsh":
      return {
        codex: {
          appServerUrl: source.appServerUrl,
        },
      };
  }
}

async function readSessionIndexLines(source: CodexSourceConfig): Promise<string[]> {
  switch (source.kind) {
    case "local": {
      const codexHome = resolveLocalCodexHome(source.homePath);
      const indexPath = path.join(codexHome, "session_index.jsonl");
      const text = await fs.readFile(indexPath, "utf8").catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
          return "";
        }
        throw error;
      });
      return text.split(/\r?\n/).filter((line) => line.trim().length > 0);
    }
    case "remoteSsh": {
      const remoteHome = toRemoteHomeExpression(source.remoteCodexHome);
      const script = [
        "set -e",
        `CODEX_HOME=${remoteHome}`,
        'INDEX="${CODEX_HOME%/}/session_index.jsonl"',
        'if [ -f "$INDEX" ]; then cat "$INDEX"; fi',
      ].join("; ");
      const result = await execFileAsync("ssh", [source.sshHost, "sh", "-lc", script], {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
    }
    case "remoteWs":
      throw new Error(
        "Listing history for remote WebSocket sources is not supported yet. Add the same host as a Remote SSH source to mirror past Codex sessions automatically.",
      );
  }
}

async function readLocalSessionTargets(
  source: Extract<CodexSourceConfig, { kind: "local" }>,
  indexedBySessionId: ReadonlyMap<string, SessionTarget>,
): Promise<SessionTarget[]> {
  const codexHome = resolveLocalCodexHome(source.homePath);
  const sessionsRoot = path.join(codexHome, "sessions");
  const sessionFiles = await collectSessionFiles(sessionsRoot);
  if (sessionFiles.length === 0) {
    return [];
  }

  const parsedEntries = await Promise.all(
    sessionFiles.map((filePath) => readLocalSessionTargetFile(filePath, indexedBySessionId)),
  );
  return parsedEntries.filter((entry): entry is SessionTarget => entry !== null).toSorted(compareSessionTargets);
}

async function collectSessionFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw error;
  });

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readLocalSessionTargetFile(
  filePath: string,
  indexedBySessionId: ReadonlyMap<string, SessionTarget>,
): Promise<SessionTarget | null> {
  const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) {
    return null;
  }

  let sessionId = readSessionIdFromFilename(filePath);
  let createdAt = new Date(stat.mtimeMs).toISOString();
  let updatedAt = createdAt;
  let cwd = "";
  let title: string | undefined;
  let sessionSource = "";
  let sessionOriginator = "";

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const record = readRecord(parsed);
    if (!record) {
      continue;
    }

    const topLevelTimestamp = parseDateValue(record.timestamp);
    if (topLevelTimestamp && topLevelTimestamp.localeCompare(updatedAt) > 0) {
      updatedAt = topLevelTimestamp;
    }

    const payload = readRecord(record.payload);
    const payloadTimestamp = parseDateValue(payload?.timestamp);
    if (payloadTimestamp && payloadTimestamp.localeCompare(updatedAt) > 0) {
      updatedAt = payloadTimestamp;
    }

    if (record.type === "session_meta" && payload) {
      if (!sessionId && typeof payload.id === "string" && payload.id.trim().length > 0) {
        sessionId = payload.id.trim();
      }
      const metaCreatedAt = parseDateValue(payload.timestamp) ?? topLevelTimestamp;
      if (metaCreatedAt) {
        createdAt = metaCreatedAt;
      }
      if (typeof payload.cwd === "string" && payload.cwd.trim().length > 0) {
        cwd = payload.cwd.trim();
      }
      if (typeof payload.source === "string" && payload.source.trim().length > 0) {
        sessionSource = payload.source.trim();
      }
      if (typeof payload.originator === "string" && payload.originator.trim().length > 0) {
        sessionOriginator = payload.originator.trim();
      }
      continue;
    }

    if (!title) {
      title = readSessionTitleCandidate(record);
    }
  }

  if (!sessionId) {
    return null;
  }
  if (!shouldIncludeSessionInHistory(sessionSource, sessionOriginator)) {
    return null;
  }

  const indexedEntry = indexedBySessionId.get(sessionId);
  return {
    sessionId,
    title: normalizeSourceThreadTitle(title ?? indexedEntry?.title, sessionId),
    updatedAt: indexedEntry?.updatedAt && indexedEntry.updatedAt.localeCompare(updatedAt) > 0
      ? indexedEntry.updatedAt
      : updatedAt,
    createdAt,
    ...(cwd ? { cwd } : {}),
  };
}

function readSessionIdFromFilename(filePath: string): string {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
    filePath,
  );
  return match?.[1]?.trim() ?? "";
}

function readSessionTitleCandidate(record: Readonly<Record<string, unknown>>): string | undefined {
  if (record.type !== "response_item") {
    return undefined;
  }

  const payload = readRecord(record.payload);
  if (!payload || payload.role !== "user") {
    return undefined;
  }

  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const item of content) {
    const contentRecord = readRecord(item);
    const text = typeof contentRecord?.text === "string" ? contentRecord.text : "";
    const normalized = normalizeSessionTitleCandidate(text);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeSessionTitleCandidate(text: string): string | null {
  const trimmed = text.replace(/\r/g, "").trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.startsWith("# AGENTS.md instructions") ||
    trimmed.startsWith("<turn_aborted>") ||
    trimmed.includes("<environment_context>") ||
    trimmed.includes("<permissions instructions>")
  ) {
    return null;
  }

  const firstMeaningfulLine = trimmed
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 0 &&
        !line.startsWith("<environment_context>") &&
        !line.startsWith("<permissions instructions>") &&
        !line.startsWith("# AGENTS.md instructions"),
    );
  if (!firstMeaningfulLine) {
    return null;
  }

  return firstMeaningfulLine.length > 120
    ? firstMeaningfulLine.slice(0, 117).trimEnd() + "..."
    : firstMeaningfulLine;
}

function compareSessionTargets(left: SessionTarget, right: SessionTarget): number {
  const leftCreatedAt = toIsoDateTime(left.createdAt ?? left.updatedAt, "1970-01-01T00:00:00.000Z");
  const rightCreatedAt = toIsoDateTime(right.createdAt ?? right.updatedAt, "1970-01-01T00:00:00.000Z");
  const byCreatedAt = rightCreatedAt.localeCompare(leftCreatedAt);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  const leftUpdatedAt = toIsoDateTime(left.updatedAt ?? left.createdAt, "1970-01-01T00:00:00.000Z");
  const rightUpdatedAt = toIsoDateTime(right.updatedAt ?? right.createdAt, "1970-01-01T00:00:00.000Z");
  const byUpdatedAt = rightUpdatedAt.localeCompare(leftUpdatedAt);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return right.sessionId.localeCompare(left.sessionId);
}

function parseSessionIndexLines(lines: string[], sourceId: string): CodexHistoryEntry[] {
  const entries: CodexHistoryEntry[] = [];
  const seenSessionIds = new Set<string>();
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = readRecord<{
      readonly id?: unknown;
      readonly thread_name?: unknown;
      readonly updated_at?: unknown;
    }>(parsed);
    if (!row) {
      continue;
    }
    const id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id || seenSessionIds.has(id)) {
      continue;
    }
    seenSessionIds.add(id);
    const title =
      typeof row.thread_name === "string" && row.thread_name.trim().length > 0
        ? row.thread_name.trim()
        : "Session " + id.slice(0, 8);
    entries.push({
      sourceId,
      sessionId: id,
      title,
      updatedAt: toIsoDateTime(row.updated_at, new Date().toISOString()),
    });
  }

  return entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function resolveLocalCodexHome(homePath: string | undefined): string {
  const trimmed = homePath?.trim();
  if (!trimmed) {
    return path.join(os.homedir(), ".codex");
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function toRemoteHomeExpression(input: string | undefined): string {
  const trimmed = input?.trim() || "~/.codex";
  if (trimmed === "~") {
    return "$HOME";
  }
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return "$HOME/" + trimmed.slice(2).replace(/\\/g, "/");
  }
  return quotePosix(trimmed.replace(/\\/g, "/"));
}

function quotePosix(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

function normalizeSourceThreadTitle(name: string | undefined, sessionId: string): string {
  const trimmed = name?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "Session " + sessionId.slice(0, 8);
}

function shouldIncludeSessionInHistory(
  sessionSource: string | undefined,
  sessionOriginator: string | undefined,
): boolean {
  const normalizedSource = sessionSource?.trim().toLowerCase() ?? "";
  const normalizedOriginator = sessionOriginator?.trim().toLowerCase() ?? "";
  return normalizedSource !== "exec" && normalizedOriginator !== "codex_exec";
}

function resolvePersistedCwd(
  snapshot: CodexThreadDetailsSnapshot,
  source: CodexSourceConfig,
  sessionId: string,
  fallbackCwd?: string,
): string {
  const cwd = typeof snapshot.cwd === "string" ? snapshot.cwd.trim() : "";
  if (cwd) {
    return cwd;
  }
  const pathValue = typeof snapshot.path === "string" ? snapshot.path.trim() : "";
  if (pathValue) {
    return pathValue;
  }
  const normalizedFallbackCwd = typeof fallbackCwd === "string" ? fallbackCwd.trim() : "";
  if (normalizedFallbackCwd) {
    return normalizedFallbackCwd;
  }
  return source.kind === "local"
    ? path.join(os.homedir(), ".codex", "mirrored", sessionId)
    : `${source.id} :: ${sessionId}`;
}

function resolveSourceFolderLabelFromSnapshot(
  snapshot: CodexThreadDetailsSnapshot,
  persistedCwd?: string,
): string | null {
  return (
    deriveSourceFolderLabelFromPath(snapshot.cwd) ??
    deriveSourceFolderLabelFromPath(snapshot.path) ??
    deriveSourceFolderLabelFromPath(persistedCwd)
  );
}

async function resolveSourceFolderLabel(
  source: CodexSourceConfig,
  targets: readonly SessionTarget[],
): Promise<string | undefined> {
  for (const target of targets.slice(0, 3)) {
    try {
      const snapshot = await readThreadDetailsFromSource(source, target.sessionId);
      const label = resolveSourceFolderLabelFromSnapshot(snapshot);
      if (label) {
        return label;
      }
    } catch {
      // Best-effort enrichment only.
    }
  }

  return fallbackSourceFolderLabel(source) ?? undefined;
}

function fallbackSourceFolderLabel(source: CodexSourceConfig): string | null {
  switch (source.kind) {
    case "local":
      return (
        deriveSourceFolderLabelFromPath(path.dirname(resolveLocalCodexHome(source.homePath))) ??
        deriveSourceFolderLabelFromPath(os.homedir())
      );
    case "remoteSsh": {
      const sshUser = parseSshUser(source.sshHost);
      if (sshUser) {
        return sshUser;
      }

      return (
        (deriveSourceFolderLabelFromPath(parentRemotePath(source.remoteCodexHome)) ?? source.id.trim()) ||
        null
      );
    }
    case "remoteWs":
      return source.id.trim() || null;
  }
}

function deriveSourceFolderLabelFromPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedValue = value.trim().replace(/[\\/]+$/g, "");
  if (!normalizedValue) {
    return null;
  }

  const segments = normalizedValue.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return null;
  }

  const first = segments[0];
  const second = segments[1];
  const third = segments[2];
  if (!first) {
    return null;
  }
  if (/^[A-Za-z]:$/.test(first)) {
    if (typeof second === "string" && second.toLowerCase() === "users" && third) {
      return third;
    }
    return segments.at(-1) ?? null;
  }

  if (first === "Users" || first === "home") {
    return second ?? first;
  }
  if (first === "root") {
    return "root";
  }
  if (first === "~" || first === "$HOME") {
    return second ?? null;
  }

  return segments.at(-1) ?? null;
}

function parseSshUser(sshHost: string): string | null {
  const trimmed = sshHost.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0) {
    return null;
  }

  const user = trimmed.slice(0, atIndex).trim();
  return user.length > 0 && !user.includes(" ") ? user : null;
}

function parentRemotePath(input: string | undefined): string {
  const trimmed = input?.trim() || "~/.codex";
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!normalized || normalized === "~" || normalized === "$HOME") {
    return normalized || "~";
  }

  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex < 0) {
    return normalized;
  }
  if (separatorIndex === 0) {
    return "/";
  }
  return normalized.slice(0, separatorIndex);
}

function nextCommandId(): CommandId {
  return CommandId.makeUnsafe(crypto.randomUUID());
}

function toIsoDateTime(value: unknown, fallback: string): string {
  return parseDateValue(value) ?? fallback;
}

function parseDateValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const timestamp = Date.parse(trimmed);
    return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = value > 1_000_000_000_000 ? value : value * 1_000;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

function createTimestampCursor(startAt: string) {
  let current = Date.parse(startAt);
  if (Number.isNaN(current)) {
    current = Date.now();
  }
  return {
    current: (): string => new Date(current).toISOString(),
    next: (): string => {
      current += 1;
      return new Date(current).toISOString();
    },
  };
}

function toImportedMessage(item: unknown):
  | {
      readonly role: "user" | "assistant";
      readonly text: string;
    }
  | null {
  const record = readRecord(item);
  if (!record) {
    return null;
  }
  const itemType = typeof record.type === "string" ? record.type : "";
  if (itemType === "userMessage") {
    const text = readUserMessageText(record);
    return text ? { role: "user", text } : null;
  }
  if (itemType === "agentMessage") {
    const text = readAgentMessageText(record);
    return text ? { role: "assistant", text } : null;
  }
  return null;
}

function toImportedActivity(
  item: unknown,
  turnId: TurnId,
):
  | {
      readonly tone: OrchestrationThreadActivityTone;
      readonly kind: string;
      readonly summary: string;
      readonly payload: unknown;
      readonly turnId: TurnId;
    }
  | null {
  const record = readRecord(item);
  if (!record) {
    return null;
  }
  const itemType = typeof record.type === "string" ? record.type.trim() : "";
  if (!itemType || itemType === "userMessage" || itemType === "agentMessage") {
    return null;
  }

  if (itemType === "reasoning") {
    const reasoningText = readReasoningSummary(record);
    if (!reasoningText) {
      return null;
    }
    return {
      tone: "info",
      kind: "codex.reasoning",
      summary: truncateSummary(`Reasoning: ${reasoningText}`),
      payload: { text: reasoningText, raw: item },
      turnId,
    };
  }

  const summary = readGenericActivitySummary(record);
  if (!summary) {
    return null;
  }
  return {
    tone: classifyActivityTone(itemType),
    kind: `codex.${itemType}`,
    summary: truncateSummary(summary),
    payload: item,
    turnId,
  };
}

function truncateSummary(value: string, maxLength = 240): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength - 1).trimEnd() + "...";
}

function classifyActivityTone(itemType: string): OrchestrationThreadActivityTone {
  const normalized = itemType.toLowerCase();
  if (normalized.includes("error") || normalized.includes("failed")) {
    return "error";
  }
  if (
    normalized.includes("tool") ||
    normalized.includes("command") ||
    normalized.includes("file")
  ) {
    return "tool";
  }
  if (normalized.includes("approval")) {
    return "approval";
  }
  return "info";
}

function readUserMessageText(record: Record<string, unknown>): string | null {
  const content = Array.isArray(record.content) ? record.content : [];
  const fragments = content
    .map((entry) => {
      const item = readRecord<{ readonly text?: unknown }>(entry);
      return typeof item?.text === "string" ? item.text.trim() : "";
    })
    .filter((entry) => entry.length > 0);
  if (fragments.length > 0) {
    return fragments.join("\n\n");
  }
  return typeof record.text === "string" && record.text.trim().length > 0
    ? record.text.trim()
    : null;
}

function readAgentMessageText(record: Record<string, unknown>): string | null {
  if (typeof record.text === "string" && record.text.trim().length > 0) {
    return record.text.trim();
  }
  const content = Array.isArray(record.content) ? record.content : [];
  const fragments = content
    .map((entry) => {
      const item = readRecord<{ readonly text?: unknown }>(entry);
      return typeof item?.text === "string" ? item.text.trim() : "";
    })
    .filter((entry) => entry.length > 0);
  return fragments.length > 0 ? fragments.join("\n\n") : null;
}

function readReasoningSummary(record: Record<string, unknown>): string | null {
  const summary = Array.isArray(record.summary) ? record.summary : [];
  const fragments = summary
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      const item = readRecord<{ readonly text?: unknown }>(entry);
      return typeof item?.text === "string" ? item.text.trim() : "";
    })
    .filter((entry) => entry.length > 0);
  if (fragments.length > 0) {
    return fragments.join(" ");
  }
  return typeof record.text === "string" && record.text.trim().length > 0
    ? record.text.trim()
    : null;
}

function readGenericActivitySummary(record: Record<string, unknown>): string | null {
  const candidate = [
    typeof record.summary === "string" ? record.summary : null,
    typeof record.text === "string" ? record.text : null,
    typeof record.title === "string" ? record.title : null,
    typeof record.command === "string" ? record.command : null,
    typeof record.message === "string" ? record.message : null,
    typeof record.status === "string" && typeof record.type === "string"
      ? record.type + ": " + record.status
      : null,
    typeof record.type === "string" ? record.type : null,
  ].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return candidate?.trim() ?? null;
}

function readResumeCursorThreadId(resumeCursor: unknown): string | null {
  const record = readRecord<{ readonly threadId?: unknown }>(resumeCursor);
  return typeof record?.threadId === "string" && record.threadId.trim().length > 0
    ? record.threadId.trim()
    : null;
}

function readRecord<T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}







