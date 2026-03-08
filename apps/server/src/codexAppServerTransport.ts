import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import readline from "node:readline";

import WebSocket from "ws";

export interface CodexAppServerTransportCloseEvent {
  readonly message: string;
  readonly clean: boolean;
}

export interface CodexAppServerTransport {
  readonly kind: "stdio" | "websocket";
  isWritable(): boolean;
  send(message: string): void;
  close(): void;
  onMessage(listener: (message: string) => void): void;
  onStderr(listener: (line: string) => void): void;
  onError(listener: (error: Error) => void): void;
  onClose(listener: (event: CodexAppServerTransportCloseEvent) => void): void;
}

export interface CreateCodexAppServerTransportInput {
  readonly cwd: string;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly appServerUrl?: string;
}

const DEFAULT_REMOTE_CONNECT_TIMEOUT_MS = 10_000;

class StdioCodexAppServerTransport implements CodexAppServerTransport {
  readonly kind = "stdio" as const;

  private readonly stdout: readline.Interface;
  private readonly stderr: readline.Interface;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    this.stdout = readline.createInterface({ input: child.stdout });
    this.stderr = readline.createInterface({ input: child.stderr });
  }

  isWritable(): boolean {
    return this.child.stdin.writable;
  }

  send(message: string): void {
    if (!this.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    this.child.stdin.write(`${message}\n`);
  }

  close(): void {
    this.stdout.close();
    this.stderr.close();

    if (!this.child.killed) {
      killChildTree(this.child);
    }
  }

  onMessage(listener: (message: string) => void): void {
    this.stdout.on("line", listener);
  }

  onStderr(listener: (line: string) => void): void {
    this.stderr.on("line", listener);
  }

  onError(listener: (error: Error) => void): void {
    this.child.on("error", listener);
  }

  onClose(listener: (event: CodexAppServerTransportCloseEvent) => void): void {
    this.child.on("exit", (code, signal) => {
      listener({
        message: `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        clean: code === 0,
      });
    });
  }
}

class WebSocketCodexAppServerTransport implements CodexAppServerTransport {
  readonly kind = "websocket" as const;

  constructor(
    private readonly socket: WebSocket,
    private readonly url: string,
  ) {}

  isWritable(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(message: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Cannot write to remote codex app-server WebSocket.");
    }

    this.socket.send(message);
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close();
    }
  }

  onMessage(listener: (message: string) => void): void {
    this.socket.on("message", (data) => {
      if (typeof data === "string") {
        listener(data);
        return;
      }

      if (Array.isArray(data)) {
        listener(Buffer.concat(data).toString("utf8"));
        return;
      }

      if (data instanceof ArrayBuffer) {
        listener(Buffer.from(new Uint8Array(data)).toString("utf8"));
        return;
      }

      listener(Buffer.from(data).toString("utf8"));
    });
  }

  onStderr(_listener: (line: string) => void): void {}

  onError(listener: (error: Error) => void): void {
    this.socket.on("error", (error) => {
      listener(
        new Error(`Remote codex app-server error at ${this.url}: ${error.message}`, {
          cause: error,
        }),
      );
    });
  }

  onClose(listener: (event: CodexAppServerTransportCloseEvent) => void): void {
    this.socket.on("close", (code, reason) => {
      const reasonText = reason.toString("utf8").trim();
      const reasonSuffix = reasonText.length > 0 ? `, reason=${reasonText}` : "";
      listener({
        message: `remote codex app-server disconnected (code=${code}${reasonSuffix}).`,
        clean: code === 1000,
      });
    });
  }
}

export async function createCodexAppServerTransport(
  input: CreateCodexAppServerTransportInput,
): Promise<CodexAppServerTransport> {
  if (input.appServerUrl) {
    return connectRemoteCodexAppServerTransport(input.appServerUrl);
  }

  return spawnLocalCodexAppServerTransport({
    cwd: input.cwd,
    binaryPath: input.binaryPath,
    ...(input.homePath ? { homePath: input.homePath } : {}),
  });
}

function spawnLocalCodexAppServerTransport(input: {
  readonly cwd: string;
  readonly binaryPath: string;
  readonly homePath?: string;
}): CodexAppServerTransport {
  const child = spawn(input.binaryPath, ["app-server"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  return new StdioCodexAppServerTransport(child);
}

async function connectRemoteCodexAppServerTransport(url: string): Promise<CodexAppServerTransport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
      socket.off("close", handleClose);
      socket.off("unexpected-response", handleUnexpectedResponse);
      callback();
    };

    const handleOpen = () => {
      finish(() => resolve(new WebSocketCodexAppServerTransport(socket, url)));
    };
    const handleError = (error: Error) => {
      finish(() => reject(new Error(`Failed to connect to remote codex app-server at ${url}: ${error.message}`, { cause: error })));
    };
    const handleClose = (code: number, reason: Buffer) => {
      const reasonText = reason.toString("utf8").trim();
      const reasonSuffix = reasonText.length > 0 ? `, reason=${reasonText}` : "";
      finish(() => reject(new Error(`Remote codex app-server closed before ready at ${url} (code=${code}${reasonSuffix}).`)));
    };
    const handleUnexpectedResponse = (_request: unknown, response: { statusCode?: number; statusMessage?: string }) => {
      const statusCode = response.statusCode ?? "unknown";
      const statusMessage = response.statusMessage ? ` ${response.statusMessage}` : "";
      finish(() => reject(new Error(`Remote codex app-server rejected the WebSocket upgrade at ${url} with HTTP ${statusCode}${statusMessage}.`)));
    };
    const timeout = setTimeout(() => {
      finish(() => {
        socket.terminate();
        reject(new Error(`Timed out connecting to remote codex app-server at ${url}.`));
      });
    }, DEFAULT_REMOTE_CONNECT_TIMEOUT_MS);

    socket.on("open", handleOpen);
    socket.on("error", handleError);
    socket.on("close", handleClose);
    socket.on("unexpected-response", handleUnexpectedResponse);
  });
}

function killChildTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      child.kill();
      return;
    }
  }

  child.kill();
}
