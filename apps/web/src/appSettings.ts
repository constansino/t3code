import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import {
  CodexSourceConfig as CodexSourceConfigSchema,
  type CodexSourceConfig,
  type ProviderKind,
  type ProviderServiceTier,
  type ProviderStartOptions,
} from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
};

const DEFAULT_CODEX_SOURCES: CodexSourceConfig[] = [
  {
    id: "local",
    name: "Local Codex",
    kind: "local",
  },
  {
    id: "192.168.10.99",
    name: "192.168.10.99",
    kind: "remoteSsh",
    sshHost: "mac-codex",
    appServerUrl: "ws://127.0.0.1:14500",
    remoteCodexHome: "~/.codex",
  },
  {
    id: "111.91.18.5",
    name: "111.91.18.5",
    kind: "remoteSsh",
    sshHost: "root@111.91.18.5",
    appServerUrl: "ws://127.0.0.1:14501",
    remoteCodexHome: "~/.codex",
  },
];
const CodexSourceBindingsSchema = Schema.Record(Schema.String, Schema.String);
const CodexSourceFolderLabelsSchema = Schema.Record(Schema.String, Schema.String);

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexSources: Schema.Array(CodexSourceConfigSchema).pipe(
    Schema.withConstructorDefault(() => Option.some(DEFAULT_CODEX_SOURCES)),
  ),
  defaultCodexSourceId: Schema.String.pipe(
    Schema.withConstructorDefault(() => Option.some("local")),
  ),
  threadCodexSourceBindings: CodexSourceBindingsSchema.pipe(
    Schema.withConstructorDefault(() => Option.some({})),
  ),
  projectCodexSourceBindings: CodexSourceBindingsSchema.pipe(
    Schema.withConstructorDefault(() => Option.some({})),
  ),
  codexSourceFolderLabels: CodexSourceFolderLabelsSchema.pipe(
    Schema.withConstructorDefault(() => Option.some({})),
  ),
  bootstrappedCodexSourceIds: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withConstructorDefault(() => Option.some(true))),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(
    Schema.withConstructorDefault(() => Option.some("auto")),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): ProviderServiceTier | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

function dedupeCodexSources(sources: readonly CodexSourceConfig[]): CodexSourceConfig[] {
  const deduped: CodexSourceConfig[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const id = source.id.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(source);
  }
  return deduped;
}

function ensureBuiltInCodexSources(sources: readonly CodexSourceConfig[]): CodexSourceConfig[] {
  const deduped = dedupeCodexSources(sources);
  const dedupedById = new Map(deduped.map((source) => [source.id, source] as const));
  return [
    ...DEFAULT_CODEX_SOURCES.map((source) => dedupedById.get(source.id) ?? source),
    ...deduped.filter((source) => !DEFAULT_CODEX_SOURCES.some((builtin) => builtin.id === source.id)),
  ];
}

export function getDefaultCodexSources(): CodexSourceConfig[] {
  return DEFAULT_CODEX_SOURCES.map((source) => Object.assign({}, source));
}

export function resolveConfiguredCodexSources(settings: Pick<AppSettings, "codexSources">): CodexSourceConfig[] {
  return ensureBuiltInCodexSources(settings.codexSources);
}

export function resolveCodexSourceById(
  settings: AppSettings,
  sourceId: string | null | undefined,
): CodexSourceConfig | null {
  const sources = resolveConfiguredCodexSources(settings);
  const normalizedId = sourceId?.trim();
  if (!normalizedId) {
    return sources[0] ?? null;
  }
  return sources.find((source) => source.id === normalizedId) ?? sources[0] ?? null;
}

export function resolveDefaultCodexSourceId(settings: AppSettings): string {
  return resolveCodexSourceById(settings, settings.defaultCodexSourceId)?.id ?? "local";
}

export function resolveProjectCodexSourceId(
  settings: AppSettings,
  projectId: string | null | undefined,
): string | null {
  const normalizedProjectId = projectId?.trim();
  if (!normalizedProjectId) {
    return null;
  }
  return resolveCodexSourceById(settings, settings.projectCodexSourceBindings[normalizedProjectId])?.id ?? null;
}

export function resolveThreadCodexSourceId(
  settings: AppSettings,
  threadId: string | null | undefined,
  projectId?: string | null | undefined,
): string {
  const normalizedThreadId = threadId?.trim();
  if (normalizedThreadId) {
    const boundThreadSourceId = settings.threadCodexSourceBindings[normalizedThreadId];
    const resolvedThreadSourceId = resolveCodexSourceById(settings, boundThreadSourceId)?.id;
    if (resolvedThreadSourceId) {
      return resolvedThreadSourceId;
    }
  }

  const projectSourceId = resolveProjectCodexSourceId(settings, projectId);
  if (projectSourceId) {
    return projectSourceId;
  }

  return resolveDefaultCodexSourceId(settings);
}

export function resolveCodexProviderOptionsForSource(
  settings: AppSettings,
  source: CodexSourceConfig | null | undefined,
): ProviderStartOptions | undefined {
  if (!source) {
    return undefined;
  }
  switch (source.kind) {
    case "local": {
      const binaryPath = source.binaryPath?.trim() || settings.codexBinaryPath.trim() || undefined;
      const homePath = source.homePath?.trim() || settings.codexHomePath.trim() || undefined;
      const codex = {
        ...(binaryPath ? { binaryPath } : {}),
        ...(homePath ? { homePath } : {}),
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

export function bindThreadCodexSourceIds(
  settings: AppSettings,
  threadIds: readonly (string | null | undefined)[],
  sourceId: string | null | undefined,
): Record<string, string> {
  const resolvedSourceId =
    resolveCodexSourceById(settings, sourceId)?.id ?? resolveDefaultCodexSourceId(settings);
  const next = { ...settings.threadCodexSourceBindings };
  for (const threadId of threadIds) {
    const normalizedThreadId = threadId?.trim();
    if (!normalizedThreadId) {
      continue;
    }
    next[normalizedThreadId] = resolvedSourceId;
  }
  return next;
}

export function bindProjectCodexSourceIds(
  settings: AppSettings,
  projectIds: readonly (string | null | undefined)[],
  sourceId: string | null | undefined,
): Record<string, string> {
  const resolvedSourceId =
    resolveCodexSourceById(settings, sourceId)?.id ?? resolveDefaultCodexSourceId(settings);
  const next = { ...settings.projectCodexSourceBindings };
  for (const projectId of projectIds) {
    const normalizedProjectId = projectId?.trim();
    if (!normalizedProjectId) {
      continue;
    }
    next[normalizedProjectId] = resolvedSourceId;
  }
  return next;
}

export function bindCodexSourceFolderLabel(
  settings: AppSettings,
  sourceId: string | null | undefined,
  folderLabel: string | null | undefined,
): Record<string, string> {
  const resolvedSourceId = resolveCodexSourceById(settings, sourceId)?.id;
  const next = { ...settings.codexSourceFolderLabels };
  if (!resolvedSourceId) {
    return next;
  }

  const normalizedFolderLabel = folderLabel?.trim() ?? "";
  if (!normalizedFolderLabel) {
    delete next[resolvedSourceId];
    return next;
  }

  next[resolvedSourceId] = normalizedFolderLabel;
  return next;
}

export function resolveCodexSourceFolderLabel(
  settings: AppSettings,
  sourceId: string | null | undefined,
): string | null {
  const resolvedSourceId = resolveCodexSourceById(settings, sourceId)?.id;
  if (!resolvedSourceId) {
    return null;
  }

  const label = settings.codexSourceFolderLabels[resolvedSourceId]?.trim();
  return label && label.length > 0 ? label : null;
}

export function markCodexSourcesBootstrapped(
  settings: AppSettings,
  sourceIds: readonly (string | null | undefined)[],
): string[] {
  const validSourceIds = new Set(resolveConfiguredCodexSources(settings).map((source) => source.id));
  const next = new Set(settings.bootstrappedCodexSourceIds.filter((sourceId) => validSourceIds.has(sourceId)));
  for (const sourceId of sourceIds) {
    const normalizedSourceId = sourceId?.trim();
    if (!normalizedSourceId || !validSourceIds.has(normalizedSourceId)) {
      continue;
    }
    next.add(normalizedSourceId);
  }
  return [...next];
}

const DEFAULT_APP_SETTINGS = normalizeAppSettings(AppSettingsSchema.makeUnsafe({}));

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeSourceBindings(
  bindings: Record<string, string>,
  sources: readonly CodexSourceConfig[],
): Record<string, string> {
  const validSourceIds = new Set(sources.map((source) => source.id));
  return Object.fromEntries(
    Object.entries(bindings).filter(
      ([entityId, sourceId]) => entityId.trim().length > 0 && validSourceIds.has(sourceId),
    ),
  );
}

function normalizeBootstrappedSourceIds(
  sourceIds: readonly string[],
  sources: readonly CodexSourceConfig[],
): string[] {
  const validSourceIds = new Set(sources.map((source) => source.id));
  return [...new Set(sourceIds.map((sourceId) => sourceId.trim()).filter((sourceId) => validSourceIds.has(sourceId)))];
}

function normalizeSourceFolderLabels(
  labels: Record<string, string>,
  sources: readonly CodexSourceConfig[],
): Record<string, string> {
  const validSourceIds = new Set(sources.map((source) => source.id));
  return Object.fromEntries(
    Object.entries(labels)
      .map(([sourceId, label]) => [sourceId.trim(), label.trim()] as const)
      .filter(([sourceId, label]) => sourceId.length > 0 && label.length > 0 && validSourceIds.has(sourceId)),
  );
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const codexSources = ensureBuiltInCodexSources(settings.codexSources);
  const normalizedSettings = { ...settings, codexSources };
  const defaultCodexSourceId =
    resolveCodexSourceById(normalizedSettings, settings.defaultCodexSourceId)?.id ?? "local";
  return {
    ...settings,
    codexSources,
    defaultCodexSourceId,
    threadCodexSourceBindings: normalizeSourceBindings(settings.threadCodexSourceBindings, codexSources),
    projectCodexSourceBindings: normalizeSourceBindings(settings.projectCodexSourceBindings, codexSources),
    codexSourceFolderLabels: normalizeSourceFolderLabels(
      settings.codexSourceFolderLabels,
      codexSources,
    ),
    bootstrappedCodexSourceIds: normalizeBootstrappedSourceIds(
      settings.bootstrappedCodexSourceIds,
      codexSources,
    ),
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const raw = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

export function updateAppSettings(
  patch: Partial<AppSettings> | ((settings: AppSettings) => Partial<AppSettings> | AppSettings),
): AppSettings {
  const current = getAppSettingsSnapshot();
  const nextPatch = typeof patch === "function" ? patch(current) : patch;
  const next = normalizeAppSettings(
    Schema.decodeSync(AppSettingsSchema)({
      ...current,
      ...nextPatch,
    }),
  );
  persistSettings(next);
  emitChange();
  return next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    updateAppSettings(patch);
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}

