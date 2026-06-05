/**
 * Plan v3 U6 — React hook：监听 `session_db_changed` + catch-up + 60s watchdog。
 *
 * 责任：
 *   1. Mount 时 `get_topology_mutations_since(sessionId, lastSeen=0)` 全量取
 *      当前 mutation 列表，触发一次 `onChange`。
 *   2. 监听 `session_db_changed` event：
 *      - mutationId === lastSeen + 1 → 直接 +1 应用（同步 fast-path）
 *      - mutationId <= lastSeen → 重复/旧事件，忽略
 *      - 跳号 → catch-up 拉缺失增量
 *   3. 60s watchdog：定时调 catch-up 兜底（防 Tauri emit 丢失 #8177）。
 *   4. unmount 时 unlisten + clearInterval。
 *
 * 并发约定（数据可靠性包）：
 *   - 所有 catch-up 经由单条 promise chain 串行执行 —— 初始全量、跳号、
 *     watchdog 三个触发源不会交错读写 `lastSeenRef`。
 *   - fast-path 保持同步即时；catch-up 应用 `latest` 时取 max，避免
 *     与 fast-path 交错时把游标回退（回退会让后续事件全部跳号、退化为轮询）。
 *   - session 切换时游标归零（mutationId 是全局计数，跨 session 残留会误判）。
 *
 * 调用方提供 `onChange` 触发 React Flow refetch 或自己的 setState。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { listenToSessionDbChanges, type SessionDbChangedPayload } from "../../agent/listen-to-session-db-changes";

const WATCHDOG_INTERVAL_MS = 60_000;

interface MutationRecord {
  sessionId: string;
  domain: string;
  mutationId: number;
  timestampMs: number;
}

interface CatchUpResponse {
  mutations: MutationRecord[];
  latest: number;
  outOfRange: boolean;
}

async function fetchSince(sessionId: string, lastSeen: number): Promise<CatchUpResponse> {
  return invoke<CatchUpResponse>("get_topology_mutations_since", {
    request: { sessionId, lastSeen },
  });
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface UseSessionDbListenerOptions {
  sessionId: string | undefined;
  onChange: (mutations: MutationRecord[]) => void;
}

export function useSessionDbListener({ sessionId, onChange }: UseSessionDbListenerOptions): void {
  const lastSeenRef = useRef<number>(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!isTauriRuntime() || !sessionId) {
      return;
    }
    // mutationId 计数是全局的；切换 session 后必须从 0 重新 catch-up。
    lastSeenRef.current = 0;

    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let watchdog: number | undefined;
    let chain: Promise<void> = Promise.resolve();

    const runCatchUp = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      try {
        const resp = await fetchSince(sessionId, lastSeenRef.current);
        if (cancelled) {
          return;
        }
        if (resp.outOfRange) {
          lastSeenRef.current = Math.max(lastSeenRef.current, resp.latest);
          // 调用方收到空数组 + outOfRange 等同信号；UI 应做全量 refetch。
          onChangeRef.current([]);
          return;
        }
        if (resp.mutations.length > 0) {
          lastSeenRef.current = Math.max(lastSeenRef.current, resp.latest);
          onChangeRef.current(resp.mutations);
        }
      } catch (err) {
        console.warn("get_topology_mutations_since 失败", err);
      }
    };

    const scheduleCatchUp = (): void => {
      chain = chain.then(runCatchUp);
    };

    // 初始全量
    scheduleCatchUp();

    // 监听 wake-up event
    void (async () => {
      const off = await listenToSessionDbChanges((payload: SessionDbChangedPayload) => {
        if (cancelled || payload.sessionId !== sessionId) {
          return;
        }
        if (payload.mutationId === lastSeenRef.current + 1) {
          // 严格连续 → 同步 fast-path 直接应用
          lastSeenRef.current = payload.mutationId;
          onChangeRef.current([{ ...payload, timestampMs: Date.now() }]);
          return;
        }
        if (payload.mutationId <= lastSeenRef.current) {
          // 重复 / 旧事件（catch-up 已覆盖）→ 忽略，不再触发多余 catch-up
          return;
        }
        // 跳号 → catch-up
        scheduleCatchUp();
      });
      if (cancelled) {
        off();
        return;
      }
      unlisten = off;
    })();

    // 60s watchdog
    watchdog = window.setInterval(scheduleCatchUp, WATCHDOG_INTERVAL_MS);

    return () => {
      cancelled = true;
      unlisten?.();
      if (watchdog !== undefined) {
        window.clearInterval(watchdog);
      }
    };
  }, [sessionId]);
}
