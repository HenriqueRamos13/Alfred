import path from 'node:path';
import type { Page } from 'playwright';
import { assertUrlSafe } from '../core/url-safety.ts';
import type { Tool, ToolCtx, BrowserHandle } from './types.ts';

/**
 * Lazy singleton persistent browser context (keeps cookies/sessions across runs).
 * Built here, wired into ToolCtx.browser by the integration layer.
 */
export function createBrowserHandle(userDataDir: string): BrowserHandle {
  let ctxPromise: Promise<import('playwright').BrowserContext> | null = null;
  let page: Page | null = null;

  async function ensure(): Promise<Page> {
    if (!ctxPromise) {
      // Imported lazily so non-browser sessions never pay Playwright's startup cost.
      const { chromium } = await import('playwright');
      ctxPromise = chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: null,
      });
    }
    const context = await ctxPromise;
    if (!page || page.isClosed()) {
      page = context.pages()[0] ?? (await context.newPage());
    }
    return page;
  }

  return {
    page: ensure,
    async close() {
      if (ctxPromise) {
        const context = await ctxPromise;
        await context.close();
        ctxPromise = null;
        page = null;
      }
    },
  };
}

/** URL/DOM heuristic for "you must log in" walls. */
async function detectLoginWall(page: Page): Promise<boolean> {
  const url = page.url();
  if (/(accounts\.google\.com\/(signin|v\d)|\/login\b|\/signin\b|\/sign-in\b|\/auth\b|\/oauth\b)/i.test(url))
    return true;
  try {
    return (await page.$('input[type="password"]')) !== null;
  } catch {
    return false;
  }
}

type Op = 'goto' | 'readText' | 'click' | 'type' | 'screenshot';
interface Args {
  op: Op;
  url?: string;
  selector?: string;
  text?: string;
  path?: string;
}

/** If a login wall is up, ask the human to sign in manually, then re-check. */
async function handleLoginWall(page: Page, ctx: ToolCtx, toolName: string): Promise<string | null> {
  if (!(await detectLoginWall(page))) return null;
  const res = await ctx.governance.requestApproval({
    sessionId: ctx.sessionId,
    toolName,
    args: { url: page.url() },
    tier: 'T2',
    reason: `Login required at ${page.url()}. Sign in manually in the browser window, then approve.`,
  });
  if (res.decision !== 'approve')
    return res.timedOut ? 'Login approval timed out — denied' : 'Login declined by user';
  return null;
}

export const browser: Tool<Args> = {
  name: 'browser',
  description:
    'Drive a real (non-headless) Chromium window that persists cookies/sessions. ' +
    'Ops: goto (navigate), readText (visible text), click, type, screenshot. ' +
    'On a login wall, Alfred pauses and asks you to sign in manually — it never enters passwords.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['goto', 'readText', 'click', 'type', 'screenshot'] },
      url: { type: 'string', description: 'op=goto: URL to open.' },
      selector: { type: 'string', description: 'op=click/type: CSS selector.' },
      text: { type: 'string', description: 'op=type: text to enter.' },
      path: { type: 'string', description: 'op=screenshot: output file path.' },
    },
    required: ['op'],
  },

  // Navigation/reading is autopilot; interaction can mutate remote state → reversible tier.
  risk: (a) => (a.op === 'goto' || a.op === 'readText' || a.op === 'screenshot' ? 'T0' : 'T1'),

  async execute(a, ctx) {
    try {
      const page = await ctx.browser.page();
      switch (a.op) {
        case 'goto': {
          if (!a.url) return { ok: false, error: 'url is required for goto' };
          // SSRF guard: classify + resolve-and-check the target IP before Playwright
          // connects (DNS-rebinding aware). Throws on a blocked/internal address.
          await assertUrlSafe(a.url);
          await page.goto(a.url, { waitUntil: 'domcontentloaded' });
          const wall = await handleLoginWall(page, ctx, this.name);
          if (wall) return { ok: false, error: wall };
          return { ok: true, result: { url: page.url(), title: await page.title() } };
        }
        case 'readText': {
          const wall = await handleLoginWall(page, ctx, this.name);
          if (wall) return { ok: false, error: wall };
          // Reading web content = untrusted input entering the session.
          ctx.governance.markTrifecta({ readUntrusted: true });
          const text = (await page.evaluate(() => document.body?.innerText ?? '')) as string;
          return { ok: true, result: { url: page.url(), text } };
        }
        case 'click': {
          if (!a.selector) return { ok: false, error: 'selector is required for click' };
          await page.click(a.selector, { timeout: 15_000 });
          const wall = await handleLoginWall(page, ctx, this.name);
          if (wall) return { ok: false, error: wall };
          return { ok: true, result: { url: page.url() } };
        }
        case 'type': {
          if (!a.selector) return { ok: false, error: 'selector is required for type' };
          await page.fill(a.selector, a.text ?? '', { timeout: 15_000 });
          return { ok: true, result: { url: page.url() } };
        }
        case 'screenshot': {
          const out = a.path
            ? path.isAbsolute(a.path)
              ? a.path
              : path.resolve(ctx.workspace, a.path)
            : path.resolve(ctx.workspace, `screenshot-${Date.now()}.png`);
          await page.screenshot({ path: out, fullPage: true });
          return { ok: true, result: { path: out } };
        }
        default:
          return { ok: false, error: `Unknown op: ${(a as Args).op}` };
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
