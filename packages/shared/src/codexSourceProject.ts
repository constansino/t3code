import { isNonEmpty } from "effect/String";

const CODEX_SOURCE_PROJECT_WORKSPACE_PREFIX = "codex-source://";

export function buildCodexSourceProjectWorkspaceRoot(sourceId: string): string {
  const normalizedSourceId = sourceId.trim();
  if (!isNonEmpty(normalizedSourceId)) {
    throw new Error("Codex source ID is required to build a source project workspace root.");
  }
  return `${CODEX_SOURCE_PROJECT_WORKSPACE_PREFIX}${encodeURIComponent(normalizedSourceId)}`;
}

export function parseCodexSourceProjectWorkspaceRoot(
  workspaceRoot: string | null | undefined,
): string | null {
  if (typeof workspaceRoot !== "string") {
    return null;
  }
  const normalizedWorkspaceRoot = workspaceRoot.trim();
  if (!normalizedWorkspaceRoot.startsWith(CODEX_SOURCE_PROJECT_WORKSPACE_PREFIX)) {
    return null;
  }
  const encodedSourceId = normalizedWorkspaceRoot.slice(CODEX_SOURCE_PROJECT_WORKSPACE_PREFIX.length);
  if (!isNonEmpty(encodedSourceId)) {
    return null;
  }
  try {
    const decodedSourceId = decodeURIComponent(encodedSourceId).trim();
    return isNonEmpty(decodedSourceId) ? decodedSourceId : null;
  } catch {
    return null;
  }
}

export function isCodexSourceProjectWorkspaceRoot(
  workspaceRoot: string | null | undefined,
): boolean {
  return parseCodexSourceProjectWorkspaceRoot(workspaceRoot) !== null;
}
