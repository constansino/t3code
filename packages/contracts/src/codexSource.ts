import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas";

export const CodexSourceId = TrimmedNonEmptyString;
export type CodexSourceId = typeof CodexSourceId.Type;

export const CodexSourceKind = Schema.Literals(["local", "remoteWs", "remoteSsh"]);
export type CodexSourceKind = typeof CodexSourceKind.Type;

const CodexSourceBase = {
  id: CodexSourceId,
  name: TrimmedNonEmptyString,
};

export const CodexLocalSourceConfig = Schema.Struct({
  ...CodexSourceBase,
  kind: Schema.Literal("local"),
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});
export type CodexLocalSourceConfig = typeof CodexLocalSourceConfig.Type;

export const CodexRemoteWsSourceConfig = Schema.Struct({
  ...CodexSourceBase,
  kind: Schema.Literal("remoteWs"),
  appServerUrl: TrimmedNonEmptyString,
});
export type CodexRemoteWsSourceConfig = typeof CodexRemoteWsSourceConfig.Type;

export const CodexRemoteSshSourceConfig = Schema.Struct({
  ...CodexSourceBase,
  kind: Schema.Literal("remoteSsh"),
  sshHost: TrimmedNonEmptyString,
  appServerUrl: TrimmedNonEmptyString,
  remoteCodexHome: Schema.optional(TrimmedNonEmptyString),
});
export type CodexRemoteSshSourceConfig = typeof CodexRemoteSshSourceConfig.Type;

export const CodexSourceConfig = Schema.Union([
  CodexLocalSourceConfig,
  CodexRemoteWsSourceConfig,
  CodexRemoteSshSourceConfig,
]);
export type CodexSourceConfig = typeof CodexSourceConfig.Type;

export const CodexHistoryEntry = Schema.Struct({
  sourceId: CodexSourceId,
  sessionId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  createdAt: Schema.optional(IsoDateTime),
});
export type CodexHistoryEntry = typeof CodexHistoryEntry.Type;

export const CodexListHistoryInput = Schema.Struct({
  source: CodexSourceConfig,
  limit: Schema.optional(NonNegativeInt),
});
export type CodexListHistoryInput = typeof CodexListHistoryInput.Type;

export const CodexImportHistoryInput = Schema.Struct({
  source: CodexSourceConfig,
  sessionIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  limit: Schema.optional(NonNegativeInt),
  syncContent: Schema.optional(Schema.Boolean),
});
export type CodexImportHistoryInput = typeof CodexImportHistoryInput.Type;

export const CodexImportHistoryResult = Schema.Struct({
  importedCount: NonNegativeInt,
  skippedCount: NonNegativeInt,
  projectIds: Schema.Array(ProjectId),
  threadIds: Schema.Array(ThreadId),
  skippedSessionIds: Schema.Array(TrimmedNonEmptyString),
  sourceFolderLabel: Schema.optional(TrimmedNonEmptyString),
});
export type CodexImportHistoryResult = typeof CodexImportHistoryResult.Type;
