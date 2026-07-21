/** Typed handle onto the preload bridge exposed as `window.alfred`. */
import type { AlfredApi } from '../../preload/index.ts';

declare global {
  interface Window {
    alfred: AlfredApi;
  }
}

export const alfred = window.alfred;
