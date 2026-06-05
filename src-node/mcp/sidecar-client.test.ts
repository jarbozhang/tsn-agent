import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSidecar, readSidecarEnv, type SidecarEnv } from "./sidecar-client";

const TEST_ENV: SidecarEnv = {
  url: "http://127.0.0.1:4801",
  token: "test-token",
  sessionId: "session-1",
};

const fetchMock = vi.fn();

describe("readSidecarEnv", () => {
  const KEYS = ["TSN_AGENT_DB_RPC_URL", "TSN_AGENT_DB_RPC_TOKEN", "TSN_AGENT_SESSION_ID"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("throws with the full list of missing variables", () => {
    expect(() => readSidecarEnv()).toThrowError(
      /TSN_AGENT_DB_RPC_URL, TSN_AGENT_DB_RPC_TOKEN, TSN_AGENT_SESSION_ID/,
    );
  });

  it("returns the env tuple when everything is present", () => {
    process.env.TSN_AGENT_DB_RPC_URL = TEST_ENV.url;
    process.env.TSN_AGENT_DB_RPC_TOKEN = TEST_ENV.token;
    process.env.TSN_AGENT_SESSION_ID = TEST_ENV.sessionId;

    expect(readSidecarEnv()).toEqual(TEST_ENV);
  });
});

describe("fetchSidecar", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: string) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `status-${status}`,
      text: async () => body,
    };
  }

  it("injects the session id and bearer token and parses a 2xx body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, '{"ok":true,"summary":{"mutationId":3}}'));

    const result = await fetchSidecar("/db/topology/apply_operations", { operations: [] }, { env: TEST_ENV });

    expect(result).toEqual({ ok: true, status: 200, body: { ok: true, summary: { mutationId: 3 } } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:4801/db/topology/apply_operations");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({ sessionId: "session-1", operations: [] });
  });

  it("maps a structured non-2xx body through code/message/retryable", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, '{"ok":false,"code":"UNKNOWN_NODE","message":"missing endpoint","retryable":false}'),
    );

    const result = await fetchSidecar("/db/topology/apply_operations", {}, { env: TEST_ENV });

    expect(result).toMatchObject({
      ok: false,
      status: 422,
      code: "UNKNOWN_NODE",
      message: "missing endpoint",
      retryable: false,
    });
  });

  it("falls back to HTTP_<status> with retryable inferred from 5xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, "not json"));

    const result = await fetchSidecar("/db/topology/inspect", {}, { env: TEST_ENV });

    expect(result).toMatchObject({ ok: false, code: "HTTP_503", retryable: true });
  });

  it("flags invalid JSON in a 2xx response as INVALID_SIDECAR_RESPONSE", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, "<html>oops</html>"));

    const result = await fetchSidecar("/db/topology/inspect", {}, { env: TEST_ENV });

    expect(result).toMatchObject({ ok: false, code: "INVALID_SIDECAR_RESPONSE", retryable: false });
  });

  it("maps network failures to SIDECAR_UNREACHABLE (not retryable)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const result = await fetchSidecar("/db/topology/inspect", {}, { env: TEST_ENV });

    expect(result).toMatchObject({ ok: false, status: 0, code: "SIDECAR_UNREACHABLE", retryable: false });
  });

  it("maps an abort to SIDECAR_TIMEOUT (retryable)", async () => {
    fetchMock.mockImplementationOnce((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("This operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );

    const result = await fetchSidecar("/db/topology/inspect", {}, { env: TEST_ENV, abortMs: 5 });

    expect(result).toMatchObject({ ok: false, status: 0, code: "SIDECAR_TIMEOUT", retryable: true });
  });
});
