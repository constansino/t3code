#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startRuntimeApiServer } from "./runtimeApiServer";

const DEFAULT_BACKEND_PORT = 4317;
const DEFAULT_WEB_PORT = 4318;
const DEFAULT_CLI_VERSION = "0.1.0";

function parseExplicitPort(value: string, key: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`Invalid value for ${key}: '${value}'. Expected an integer between 1 and 65535.`);
  }

  return parsed;
}

function parseEnvPort(
  value: string | undefined,
  key: string,
  fallback: number,
): { port: number; locked: boolean } {
  if (value === undefined) {
    return { port: fallback, locked: false };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid value for ${key}: expected a non-empty port.`);
  }

  return {
    port: parseExplicitPort(trimmed, key),
    locked: true,
  };
}

function parseExplicitPath(value: string, key: string, cwd: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Invalid value for ${key}: expected a non-empty path.`);
  }

  return path.resolve(cwd, trimmed);
}

function parseBooleanEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

interface CliOptions {
  backendPort: number;
  webPort: number;
  launchCwd: string;
  noOpen: boolean;
  showHelp: boolean;
  showVersion: boolean;
  backendPortLocked: boolean;
  webPortLocked: boolean;
}

interface StartupErrorShape {
  code?: unknown;
  message?: unknown;
}

function readArgValue(args: string[], index: number, key: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${key}.`);
  }

  return value;
}

export function formatStartupError(error: unknown, options: CliOptions): string {
  const candidate = error as StartupErrorShape;
  const code = typeof candidate?.code === "string" ? candidate.code : undefined;

  if (code === "EADDRINUSE") {
    return `Port already in use. Try --backend-port ${options.backendPort + 1} --web-port ${options.webPort + 1} or stop the conflicting process.`;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return "Failed to start t3 runtime.";
}

function isPortInUseError(error: unknown): boolean {
  const candidate = error as StartupErrorShape;
  return candidate?.code === "EADDRINUSE";
}

export function parseCliOptions(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): CliOptions {
  const parserCwd = path.resolve(cwd);
  const backendPortFromEnv = parseEnvPort(
    env.T3_BACKEND_PORT,
    "T3_BACKEND_PORT",
    DEFAULT_BACKEND_PORT,
  );
  const webPortFromEnv = parseEnvPort(env.T3_WEB_PORT, "T3_WEB_PORT", DEFAULT_WEB_PORT);

  let backendPort = backendPortFromEnv.port;
  let webPort = webPortFromEnv.port;
  let backendPortLocked = backendPortFromEnv.locked;
  let webPortLocked = webPortFromEnv.locked;
  let launchCwd = parserCwd;
  let usedPositionalCwd = false;
  let noOpen = parseBooleanEnvFlag(env.T3_NO_OPEN);
  let showHelp = false;
  let showVersion = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === "--") {
      const positionalArgs = argv.slice(index + 1);
      const [first, ...rest] = positionalArgs;
      if (!first) {
        throw new Error("Missing value for [path].");
      }
      if (usedPositionalCwd) {
        throw new Error(`Unexpected positional argument: ${first}`);
      }
      if (rest.length > 0) {
        throw new Error(`Unexpected positional argument: ${rest[0]}`);
      }
      launchCwd = parseExplicitPath(first, "[path]", parserCwd);
      usedPositionalCwd = true;
      break;
    }

    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--version" || arg === "-v") {
      showVersion = true;
      continue;
    }

    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }

    if (arg.startsWith("--backend-port=")) {
      backendPort = parseExplicitPort(arg.split("=")[1] ?? "", "--backend-port");
      backendPortLocked = true;
      continue;
    }

    if (arg === "--backend-port") {
      backendPort = parseExplicitPort(
        readArgValue(argv, index, "--backend-port"),
        "--backend-port",
      );
      backendPortLocked = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--web-port=")) {
      webPort = parseExplicitPort(arg.split("=")[1] ?? "", "--web-port");
      webPortLocked = true;
      continue;
    }

    if (arg === "--web-port") {
      webPort = parseExplicitPort(readArgValue(argv, index, "--web-port"), "--web-port");
      webPortLocked = true;
      index += 1;
      continue;
    }

    if (arg.startsWith("--cwd=")) {
      launchCwd = parseExplicitPath(arg.split("=")[1] ?? "", "--cwd", parserCwd);
      continue;
    }

    if (arg === "--cwd") {
      launchCwd = parseExplicitPath(readArgValue(argv, index, "--cwd"), "--cwd", parserCwd);
      index += 1;
      continue;
    }

    if (!arg.startsWith("-")) {
      if (usedPositionalCwd) {
        throw new Error(`Unexpected positional argument: ${arg}`);
      }
      launchCwd = parseExplicitPath(arg, "[path]", parserCwd);
      usedPositionalCwd = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    backendPort,
    webPort,
    launchCwd,
    noOpen,
    showHelp,
    showVersion,
    backendPortLocked,
    webPortLocked,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage: t3 [options]",
      "",
      "Options:",
      "  --no-open               Start runtime without opening browser",
      "  --backend-port <port>   Override WebSocket API port (default: 4317)",
      "  --web-port <port>       Override web UI port (default: 4318)",
      "  --cwd <path>            Launch project directory (default: current directory)",
      "  [path]                  Positional shorthand for --cwd <path>",
      "  --                      End options (useful for paths beginning with '-')",
      "  -v, --version           Print CLI version",
      "  -h, --help              Show this help message",
      "",
      "Environment variables:",
      "  T3_NO_OPEN=1|true|yes|on Disable browser auto-open",
      "  T3_BACKEND_PORT=<port>  Default backend port",
      "  T3_WEB_PORT=<port>      Default web UI port",
      "",
    ].join("\n"),
  );
}

function openBrowser(url: string, noOpen: boolean): void {
  if (noOpen) {
    return;
  }

  const command =
    process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Best-effort browser launch; keep runtime alive even when opener is unavailable.
  });
  child.unref();
}

export function readCliVersion(
  packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "package.json",
  ),
  env = process.env,
): string {
  const envVersion = env.npm_package_version;
  if (typeof envVersion === "string" && envVersion.length > 0) {
    return envVersion;
  }

  try {
    const raw = fs.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Ignore read/parse failures and return fallback.
  }

  return DEFAULT_CLI_VERSION;
}

export function validateLaunchDirectory(launchCwd: string): string {
  const resolved = path.resolve(launchCwd);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    throw new Error(`Launch directory does not exist: ${resolved}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Launch path is not a directory: ${resolved}`);
  }

  return resolved;
}

async function runCli(options: CliOptions): Promise<void> {
  const launchCwd = validateLaunchDirectory(options.launchCwd);
  const authToken = randomUUID();
  const runtimeServer = await startRuntimeApiServer({
    port: options.backendPort,
    launchCwd,
    authToken,
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rendererRoot = path.resolve(__dirname, "../../renderer");
  ensureRendererBuild(rendererRoot);

  let staticServer:
    | {
        close: () => Promise<void>;
      }
    | undefined;
  try {
    staticServer = await startStaticWebServer(path.join(rendererRoot, "dist"), options.webPort);
  } catch (error) {
    await runtimeServer.close();
    throw error;
  }

  const wsParam = encodeURIComponent(runtimeServer.wsUrl);
  const appUrl = `http://127.0.0.1:${options.webPort}?ws=${wsParam}`;
  openBrowser(appUrl, options.noOpen);

  process.stdout.write(`CodeThing is running at ${appUrl}\n`);

  let shutdownStarted = false;
  const shutdown = async () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    await Promise.all([staticServer.close(), runtimeServer.close()]);
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

function ensureRendererBuild(rendererRoot: string): void {
  const distPath = path.join(rendererRoot, "dist", "index.html");
  if (fs.existsSync(distPath)) {
    return;
  }

  const bunPath = process.env.BUN_BIN ?? "bun";
  const build = spawnSync(bunPath, ["run", "--cwd", rendererRoot, "build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.bun/bin:${process.env.PATH}`,
    },
  });
  if (build.status !== 0) {
    throw new Error("Failed to build renderer assets.");
  }
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  if (filePath.endsWith(".woff")) return "font/woff";
  return "application/octet-stream";
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveStaticAssetPath(
  requestUrl: string | undefined,
  distRoot: string,
): { kind: "file"; filePath: string } | { kind: "forbidden" } | { kind: "bad_request" } {
  const pathWithoutQuery = requestUrl ? requestUrl.split("?")[0] : "/";
  const rawPath = pathWithoutQuery || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    return { kind: "bad_request" };
  }
  if (decodedPath.includes("\0")) {
    return { kind: "bad_request" };
  }

  const normalizedPath =
    decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  const candidateFilePath = path.resolve(distRoot, normalizedPath);
  if (!isPathInside(distRoot, candidateFilePath)) {
    return { kind: "forbidden" };
  }

  return { kind: "file", filePath: candidateFilePath };
}

function resolveSafeFilePathInDist(
  filePath: string,
  realDistRoot: string,
): { kind: "file"; filePath: string } | { kind: "missing" } | { kind: "forbidden" } {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    return { kind: "missing" };
  }

  if (stats.isDirectory()) {
    return { kind: "missing" };
  }

  if (!stats.isFile() && !stats.isSymbolicLink()) {
    return { kind: "missing" };
  }

  let realFilePath: string;
  try {
    realFilePath = fs.realpathSync(filePath);
  } catch {
    return { kind: "missing" };
  }

  if (!isPathInside(realDistRoot, realFilePath)) {
    return { kind: "forbidden" };
  }

  try {
    if (!fs.statSync(realFilePath).isFile()) {
      return { kind: "missing" };
    }
  } catch {
    return { kind: "missing" };
  }

  return { kind: "file", filePath: realFilePath };
}

export function resolveStaticAssetReadTarget(
  requestUrl: string | undefined,
  distRoot: string,
  resolvedRealDistRoot?: string,
):
  | { kind: "file"; filePath: string }
  | { kind: "forbidden" }
  | { kind: "bad_request" }
  | { kind: "not_found" } {
  const normalizedDistRoot = path.resolve(distRoot);
  const realDistRoot =
    resolvedRealDistRoot ??
    (() => {
      try {
        return fs.realpathSync(normalizedDistRoot);
      } catch {
        return normalizedDistRoot;
      }
    })();

  const requestedPath = resolveStaticAssetPath(requestUrl, normalizedDistRoot);
  if (requestedPath.kind === "bad_request" || requestedPath.kind === "forbidden") {
    return requestedPath;
  }

  const requestedFile = resolveSafeFilePathInDist(requestedPath.filePath, realDistRoot);
  if (requestedFile.kind === "forbidden") {
    return { kind: "forbidden" };
  }
  if (requestedFile.kind === "file") {
    return requestedFile;
  }

  const indexPath = path.join(normalizedDistRoot, "index.html");
  const indexFile = resolveSafeFilePathInDist(indexPath, realDistRoot);
  if (indexFile.kind !== "file") {
    return indexFile.kind === "forbidden" ? { kind: "forbidden" } : { kind: "not_found" };
  }

  return indexFile;
}

function startStaticWebServer(distRoot: string, port: number) {
  const normalizedDistRoot = path.resolve(distRoot);
  const resolvedRealDistRoot = (() => {
    try {
      return fs.realpathSync(normalizedDistRoot);
    } catch {
      return normalizedDistRoot;
    }
  })();

  const server = createServer((request, response) => {
    const resolvedPath = resolveStaticAssetReadTarget(
      request.url,
      normalizedDistRoot,
      resolvedRealDistRoot,
    );
    if (resolvedPath.kind === "bad_request") {
      response.statusCode = 400;
      response.end("Invalid request path");
      return;
    }

    if (resolvedPath.kind === "forbidden") {
      response.statusCode = 403;
      response.end("Forbidden");
      return;
    }
    if (resolvedPath.kind === "not_found") {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    const targetPath = resolvedPath.filePath;
    fs.readFile(targetPath, (error, content) => {
      if (error) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", contentTypeFor(targetPath));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(content);
    });
  });

  return new Promise<{
    close: () => Promise<void>;
  }>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      let closePromise: Promise<void> | null = null;
      resolve({
        close: () => {
          if (closePromise) {
            return closePromise;
          }

          closePromise = new Promise<void>((closeResolve) => {
            server.close(() => closeResolve());
          });

          return closePromise;
        },
      });
    });
  });
}

async function main() {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2), process.env, process.cwd());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Invalid arguments."}\n\n`);
    printHelp();
    process.exit(1);
    return;
  }

  if (options.showHelp) {
    printHelp();
    process.exit(0);
    return;
  }

  if (options.showVersion) {
    process.stdout.write(`${readCliVersion()}\n`);
    process.exit(0);
    return;
  }

  const maxPortRetryAttempts = 10;
  const runWithRetry = async (
    currentOptions: CliOptions,
    attempt: number,
  ): Promise<void> => {
    try {
      await runCli(currentOptions);
      return;
    } catch (error) {
      const canRetryWithNextPorts =
        isPortInUseError(error) &&
        !currentOptions.backendPortLocked &&
        !currentOptions.webPortLocked &&
        attempt < maxPortRetryAttempts - 1;
      if (canRetryWithNextPorts) {
        const nextBackendPort = currentOptions.backendPort + 1;
        const nextWebPort = currentOptions.webPort + 1;
        process.stderr.write(
          `Ports ${currentOptions.backendPort}/${currentOptions.webPort} busy; retrying with ${nextBackendPort}/${nextWebPort}.\n`,
        );
        return runWithRetry(
          {
            ...currentOptions,
            backendPort: nextBackendPort,
            webPort: nextWebPort,
          },
          attempt + 1,
        );
      }

      const wrappedError = new Error("CLI startup failed.");
      (wrappedError as Error & { cause?: unknown }).cause = {
        originalError: error,
        options: currentOptions,
      };
      throw wrappedError;
    }
  };

  try {
    await runWithRetry(options, 0);
  } catch (error) {
    const wrappedCause = (error as Error & { cause?: unknown }).cause as
      | {
          originalError?: unknown;
          options?: CliOptions;
        }
      | undefined;
    const wrapped = wrappedCause ?? {
      originalError: error,
      options,
    };
    const failedOptions = wrapped.options ?? options;
    process.stderr.write(
      `${formatStartupError(wrapped.originalError ?? error, failedOptions)}\n`,
    );
    process.exit(1);
  }
}

const entrypoint = process.argv[1];
const currentFilePath = fileURLToPath(import.meta.url);
if (entrypoint && path.resolve(entrypoint) === currentFilePath) {
  void main();
}
