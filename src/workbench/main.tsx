import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("工作台入口不存在");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

import "./projects.css";
import "./settings-extra.css";

import "./panel-actions.css";

import "katex/dist/katex.min.css";
import "./workspace-content.css";
import "./radar.css";
import "./radar-reader.css";
import "./library-feedback.css";

import "./editorial.css";
import "./skills.css";
import "./project-support.css";
import "./media.css";
import "./delivery.css";
import "./routines.css";
import "./service-settings.css";
import "./portable.css";
import "./attention.css";

import "./product-shell.css";

import "./work-content.css";

import "./asset-settings.css";

import "./collaboration.css";
