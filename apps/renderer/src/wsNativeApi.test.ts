import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  static failSend = false;

  readyState = 0;
  binaryType = "blob";
  sentMessages: string[] = [];
  private listeners: Record<string, Listener[]> = {};

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = MockWebSocket.OPEN;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener) {
    const next = this.listeners[type] ?? [];
    next.push(listener);
    this.listeners[type] = next;
  }

  send(data: string) {
    if (MockWebSocket.failSend) {
      throw new Error("mock send failure");
    }

    this.sentMessages.push(String(data));
  }

  close() {
    this.readyState = 3;
    this.emit("close", { code: 1000 });
  }

  emitMessage(data: unknown) {
    this.emit("message", { data });
  }

  private emit(type: string, event: unknown) {
    const listeners = this.listeners[type] ?? [];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function setWindowSearch(search: string) {
  vi.stubGlobal("window", {
    location: {
      search,
    },
  });
}

function waitForCondition(check: () => boolean, timeoutMs = 1_000) {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (check()) {
        clearInterval(timer);
        resolve();
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for test condition."));
      }
    }, 10);
  });
}

describe("wsNativeApi", () => {
  beforeEach(() => {
    vi.resetModules();
    MockWebSocket.instances = [];
    MockWebSocket.failSend = false;
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket);
  });

  it("connects using ws query parameter and resolves responses", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4400%3Ftoken%3Dabc");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();

    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4400?token=abc");
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      type: string;
      id: string;
      method: string;
    };
    expect(requestEnvelope.type).toBe("request");
    expect(requestEnvelope.method).toBe("todos.list");

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects immediately when websocket send throws", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4401");
    MockWebSocket.failSend = true;
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    await expect(api.todos.list()).rejects.toThrow(
      "Failed to send runtime request 'todos.list': mock send failure",
    );
  });

  it("falls back to default local runtime URL when ws query is missing", async () => {
    setWindowSearch("");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    expect(socket?.url).toBe("ws://127.0.0.1:4317");

    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };
    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: true,
        result: [],
      }),
    );

    await expect(request).resolves.toEqual([]);
  });

  it("rejects request when runtime responds with structured error", async () => {
    setWindowSearch("?ws=ws%3A%2F%2F127.0.0.1%3A4402");
    const { getOrCreateWsNativeApi } = await import("./wsNativeApi");
    const api = getOrCreateWsNativeApi();

    const request = api.todos.list();
    const socket = MockWebSocket.instances[0];
    await waitForCondition(() => (socket?.sentMessages.length ?? 0) > 0);
    const requestEnvelope = JSON.parse(socket?.sentMessages[0] ?? "{}") as {
      id: string;
    };

    socket?.emitMessage(
      JSON.stringify({
        type: "response",
        id: requestEnvelope.id,
        ok: false,
        error: {
          code: "request_failed",
          message: "boom",
        },
      }),
    );

    await expect(request).rejects.toThrow("boom");
  });
});
