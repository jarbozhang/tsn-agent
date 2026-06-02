/// <reference types="vite/client" />
import type { TsnAgentRequest, TsnAgentResult } from "./agent/agent-adapter";

declare module "*.md?raw" {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** Set by Playwright `page.addInitScript` to opt into the test-only agent runtime. */
    __TSN_TEST_RUNTIME__?: boolean;
    /** Installed by src/test/playwright-runtime-bridge.ts; agent-adapter routes here when set. */
    __TSN_TEST_DISPATCHER__?: (request: TsnAgentRequest | string) => Promise<TsnAgentResult>;
  }
}

export {};
