import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDemoHost, demoUserInput } from "./host/demoHost.js";
import { createTauriHost, isTauriRuntime } from "./host/tauriHost.js";
import { App } from "./ui/App.js";
import "./ui/styles.css";

// One renderer, two hosts: the Tauri shell in the packaged app, and a browser
// host replaying a recorded session so the UI can be run and reviewed without
// a Rust toolchain.
const host = isTauriRuntime() ? createTauriHost() : createDemoHost();
const placeholder = isTauriRuntime()
  ? "Describe your product idea, however rough…"
  : demoUserInput();

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

createRoot(container).render(
  <StrictMode>
    <App host={host} placeholder={placeholder} />
  </StrictMode>,
);
