/**
 * Desktop host — placeholder for the Tauri shell.
 *
 * The UI lands in a later phase. What exists now is the boundary it has to
 * respect: the shell supplies ports and transport, and every decision about how
 * a task runs stays in `@ytriple/core`. There is deliberately no state machine,
 * no prompt assembly and no team logic in this package, and none may appear in
 * `src-tauri` either.
 */
export type { DesktopBridge, DesktopSession } from "./session.js";
export { createDesktopSession, desktopCapabilities } from "./session.js";
export { DESKTOP_PACKAGE_VERSION } from "./version.js";
