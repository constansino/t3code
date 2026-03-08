import { isNonEmpty } from "effect/String";

const CODEX_SOURCE_THREAD_PREFIX = "codex-source-thread://";

export function buildCodexSourceThreadId(sourceId: string, sessionId: string): string {
  const normalizedSourceId = sourceId.trim();
  const normalizedSessionId = sessionId.trim();
  if (!isNonEmpty(normalizedSourceId)) {
    throw new Error("Codex source ID is required to build a source thread ID.");
  }
  if (!isNonEmpty(normalizedSessionId)) {
    throw new Error("Codex session ID is required to build a source thread ID.");
  }
  return `${CODEX_SOURCE_THREAD_PREFIX}${encodeURIComponent(normalizedSourceId)}/${encodeURIComponent(normalizedSessionId)}`;
}

export function parseCodexSourceThreadId(
  threadId: string | null | undefined,
): { sourceId: string; sessionId: string } | null {
  if (typeof threadId !== "string") {
    return null;
  }
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId.startsWith(CODEX_SOURCE_THREAD_PREFIX)) {
    return null;
  }

  const encoded = normalizedThreadId.slice(CODEX_SOURCE_THREAD_PREFIX.length);
  const separatorIndex = encoded.indexOf("/");
  if (separatorIndex < 1 || separatorIndex >= encoded.length - 1) {
    return null;
  }

  try {
    const sourceId = decodeURIComponent(encoded.slice(0, separatorIndex)).trim();
    const sessionId = decodeURIComponent(encoded.slice(separatorIndex + 1)).trim();
    if (!isNonEmpty(sourceId) || !isNonEmpty(sessionId)) {
      return null;
    }
    return { sourceId, sessionId };
  } catch {
    return null;
  }
}

export function isCodexSourceThreadId(threadId: string | null | undefined): boolean {
  return parseCodexSourceThreadId(threadId) !== null;
}
