import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
  appServerUrl: Schema.optional(TrimmedNonEmptyString),
});
export type CodexProviderStartOptions = typeof CodexProviderStartOptions.Type;

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;
