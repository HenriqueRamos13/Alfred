/**
 * Window controls for Alfred's frameless overlays — the single source of truth
 * for "hide / show / toggle ALL windows". Reused by the top-bar IPC
 * (registerWindowIpc), the global toggle shortcut, the wake-word voice commands
 * (via the orchestrator), and the `system` tool's window ops, so they can never
 * drift apart.
 */
import { BrowserWindow } from 'electron';

export function hideAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) w.hide();
}

export function showAllWindows(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.show();
    w.focus();
  }
}

/** Hide every window if any is visible, otherwise show them all. Returns the new visibility. */
export function toggleAllWindows(): boolean {
  const wins = BrowserWindow.getAllWindows();
  const anyVisible = wins.some((w) => w.isVisible());
  if (anyVisible) hideAllWindows();
  else showAllWindows();
  return !anyVisible;
}
