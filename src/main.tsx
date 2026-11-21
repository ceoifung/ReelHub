import React from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import "./index.css";

async function boot() {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  /* 无 Tauri 宿主时注入样例数据，便于 Web 预览 / 发布页演示播放 UI */
  if (!w.__TAURI_INTERNALS__) {
    const { installBrowserMock } = await import("./dev/browserMock");
    installBrowserMock();
  }

  const [{ default: App }, { AppProvider }, { initPlaybackLog, installPlaybackPageEvents }] =
    await Promise.all([
      import("./App"),
      import("./store"),
      import("./playbackDiagnostics"),
    ]);

  installPlaybackPageEvents();
  void initPlaybackLog();

  function report(kind: string, msg: string) {
    invoke("debug_log", { msg: `[${kind}] ${msg}` }).catch(() => {});
  }
  window.addEventListener("error", (e) => {
    report("error", `${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    report("reject", String((e.reason && (e.reason.stack || e.reason.message)) || e.reason));
  });

  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <AppProvider>
        <App />
      </AppProvider>
    </React.StrictMode>,
  );
}

void boot();
