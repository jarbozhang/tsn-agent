import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./app/App.css";

async function bootstrap() {
  // Dev-only Playwright test runtime swap. Production builds tree-shake this
  // entire block out via Vite's `import.meta.env.MODE` compile-time constant.
  if (import.meta.env.MODE === "development") {
    const flag = window.__TSN_TEST_RUNTIME__;
    if (flag) {
      const { installTestRuntime } = await import("./test/playwright-runtime-bridge");
      installTestRuntime();
    }
  }

  const rootElement = document.getElementById("root");
  if (!rootElement) {
    throw new Error("Root element #root is missing.");
  }
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
