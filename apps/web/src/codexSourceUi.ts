const CODEX_SOURCE_FOCUS_STORAGE_KEY = "t3code:focus-codex-source-id";

export function buildCodexSourceSettingsCardId(sourceId: string): string {
  return `codex-source-card-${encodeURIComponent(sourceId.trim())}`;
}

export function setPendingCodexSourceFocus(sourceId: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(CODEX_SOURCE_FOCUS_STORAGE_KEY, sourceId.trim());
}

export function takePendingCodexSourceFocus(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const sourceId = window.sessionStorage.getItem(CODEX_SOURCE_FOCUS_STORAGE_KEY);
  if (!sourceId) {
    return null;
  }
  window.sessionStorage.removeItem(CODEX_SOURCE_FOCUS_STORAGE_KEY);
  return sourceId.trim() || null;
}
