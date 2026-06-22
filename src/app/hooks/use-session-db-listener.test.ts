import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDbChangedPayload } from "../../agent/listen-to-session-db-changes";
import { useSessionDbListener } from "./use-session-db-listener";

const invokeMock = vi.hoisted(() => vi.fn());
const listenHandlers = vi.hoisted(() => [] as Array<(payload: SessionDbChangedPayload) => void>);
const unlistenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../../agent/listen-to-session-db-changes", () => ({
  listenToSessionDbChanges: vi.fn(async (handler: (payload: SessionDbChangedPayload) => void) => {
    listenHandlers.push(handler);
    return unlistenMock;
  }),
}));

function emit(payload: SessionDbChangedPayload) {
  for (const handler of [...listenHandlers]) {
    handler(payload);
  }
}

function catchUpResponse(
  overrides: Partial<{ mutations: unknown[]; latest: number; outOfRange: boolean }> = {},
) {
  return { mutations: [], latest: 0, outOfRange: false, ...overrides };
}

describe("useSessionDbListener", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    unlistenMock.mockReset();
    listenHandlers.length = 0;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  });

  it("runs an initial catch-up on mount and forwards mutations", async () => {
    const onChange = vi.fn();
    invokeMock.mockResolvedValueOnce(
      catchUpResponse({
        mutations: [{ sessionId: "s1", domain: "topology", mutationId: 2, timestampMs: 1 }],
        latest: 2,
      }),
    );

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    expect(invokeMock).toHaveBeenCalledWith("get_topology_mutations_since", {
      request: { sessionId: "s1", lastSeen: 0 },
    });
  });

  it("applies a strictly consecutive event through the synchronous fast-path", async () => {
    const onChange = vi.fn();
    invokeMock.mockResolvedValueOnce(catchUpResponse({ latest: 0 }));

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await waitFor(() => expect(listenHandlers.length).toBe(1));
    invokeMock.mockClear();

    emit({ sessionId: "s1", domain: "topology", mutationId: 1 });

    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ sessionId: "s1", mutationId: 1 }),
    ]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("ignores duplicate or stale events without extra catch-up calls", async () => {
    const onChange = vi.fn();
    invokeMock.mockResolvedValueOnce(
      catchUpResponse({
        mutations: [{ sessionId: "s1", domain: "topology", mutationId: 3, timestampMs: 1 }],
        latest: 3,
      }),
    );

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    invokeMock.mockClear();
    onChange.mockClear();

    emit({ sessionId: "s1", domain: "topology", mutationId: 2 });
    emit({ sessionId: "s1", domain: "topology", mutationId: 3 });

    expect(onChange).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("falls back to catch-up on a gap and signals a full refetch on outOfRange", async () => {
    const onChange = vi.fn();
    invokeMock
      .mockResolvedValueOnce(catchUpResponse({ latest: 0 }))
      .mockResolvedValueOnce(catchUpResponse({ outOfRange: true, latest: 9 }));

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await waitFor(() => expect(listenHandlers.length).toBe(1));

    emit({ sessionId: "s1", domain: "topology", mutationId: 5 });

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith([]);
    });
    // outOfRange 后游标推进到 latest；下一个连续事件走 fast-path。
    onChange.mockClear();
    emit({ sessionId: "s1", domain: "topology", mutationId: 10 });
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ mutationId: 10 })]);
  });

  it("serializes concurrent catch-up triggers on one chain", async () => {
    const onChange = vi.fn();
    let resolveFirst: (value: unknown) => void = () => {};
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(catchUpResponse({ latest: 7 }));

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await waitFor(() => expect(listenHandlers.length).toBe(1));

    // 初始 catch-up 仍挂起时来一个跳号事件 → 第二个 catch-up 必须排队而非并发。
    emit({ sessionId: "s1", domain: "topology", mutationId: 5 });
    expect(invokeMock).toHaveBeenCalledTimes(1);

    resolveFirst(
      catchUpResponse({
        mutations: [{ sessionId: "s1", domain: "topology", mutationId: 5, timestampMs: 1 }],
        latest: 5,
      }),
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledTimes(2);
    });
  });

  it("re-runs catch-up on the watchdog interval", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    invokeMock.mockResolvedValue(catchUpResponse({ latest: 0 }));

    renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    await vi.advanceTimersByTimeAsync(60_000);
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("resets the cursor when the session changes", async () => {
    const onChange = vi.fn();
    invokeMock.mockResolvedValue(
      catchUpResponse({
        mutations: [{ sessionId: "s1", domain: "topology", mutationId: 8, timestampMs: 1 }],
        latest: 8,
      }),
    );

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) => useSessionDbListener({ sessionId, onChange }),
      { initialProps: { sessionId: "s1" } },
    );
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    invokeMock.mockClear();

    rerender({ sessionId: "s2" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_topology_mutations_since", {
        request: { sessionId: "s2", lastSeen: 0 },
      });
    });
  });

  it("stops the watchdog and unlistens on unmount", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    invokeMock.mockResolvedValue(catchUpResponse({ latest: 0 }));

    const { unmount } = renderHook(() => useSessionDbListener({ sessionId: "s1", onChange }));
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    unmount();
    expect(unlistenMock).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});
