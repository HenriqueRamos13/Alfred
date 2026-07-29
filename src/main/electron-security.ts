import { shell, type BrowserWindow, type Event } from 'electron';
import { isSafeExternalUrl, isTrustedPageUrl } from './core/electron-security-pure.ts';

function openExternal(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  void shell.openExternal(url).catch((err) => {
    console.error('[alfred] could not open external URL:', err instanceof Error ? err.message : err);
  });
}

/** Keep the privileged renderer on its exact entry page and deny child windows. */
export function hardenWindowNavigation(win: BrowserWindow, trustedUrl: string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  const guardNavigation = (event: Event, url: string): void => {
    if (isTrustedPageUrl(url, trustedUrl)) return;
    event.preventDefault();
    openExternal(url);
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
}
