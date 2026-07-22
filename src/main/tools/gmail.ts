import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { gmail as gmailApi, auth } from '@googleapis/gmail';
import type { gmail_v1 } from '@googleapis/gmail';
import type { Tool, ToolCtx } from './types.ts';

type OAuth2Client = InstanceType<typeof auth.OAuth2>;

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function oauthConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET are not set (see README).');
  return { clientId, clientSecret };
}

function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {
    /* best-effort; user can also copy the URL from the log */
  });
}

/** Full loopback OAuth consent flow. Resolves with tokens + the account email. */
function oauthConnect(clientId: string, clientSecret: string): Promise<{ tokens: unknown; email: string }> {
  return new Promise((resolve, reject) => {
    let oauth2: OAuth2Client;
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const code = u.searchParams.get('code');
      const err = u.searchParams.get('error');
      if (!code && !err) {
        res.end();
        return;
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<h2>Alfred</h2><p>Gmail connected. You can close this tab and return to Alfred.</p>');
      server.close();
      try {
        if (err || !code) throw new Error(err ?? 'No authorization code returned');
        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);
        const gmail = gmailApi({ version: 'v1', auth: oauth2 });
        const profile = await gmail.users.getProfile({ userId: 'me' });
        const email = profile.data.emailAddress;
        if (!email) throw new Error('Could not read account email address');
        resolve({ tokens, email });
      } catch (e) {
        reject(e as Error);
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      oauth2 = new auth.OAuth2(clientId, clientSecret, `http://127.0.0.1:${port}`);
      const authUrl = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SCOPE] });
      openUrl(authUrl);
    });
  });
}

function resolveAccount(ctx: ToolCtx, email?: string): string | null {
  if (email) return email;
  const row = ctx.db
    .prepare('SELECT email FROM accounts WHERE provider = ? ORDER BY connected_at DESC LIMIT 1')
    .get('gmail') as { email: string } | undefined;
  return row?.email ?? null;
}

async function gmailFor(ctx: ToolCtx, email: string): Promise<gmail_v1.Gmail> {
  const raw = await ctx.secrets.get(`gmail:${email}`);
  if (!raw) throw new Error(`No stored token for ${email} — run gmail connect first`);
  const { clientId, clientSecret } = oauthConfig();
  const oauth2 = new auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials(JSON.parse(raw));
  return gmailApi({ version: 'v1', auth: oauth2 });
}

function header(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  return headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  for (const child of part.parts ?? []) {
    const text = decodeBody(child);
    if (text) return text;
  }
  if (part.mimeType === 'text/html' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8');
  return '';
}

type Op = 'connect' | 'list' | 'read' | 'search';
interface Args {
  op: Op;
  account?: string;
  query?: string;
  id?: string;
  maxResults?: number;
}

export const gmail: Tool<Args> = {
  name: 'gmail',
  description:
    'Read-only Gmail access. connect: authorise an account (opens Google consent in the browser). ' +
    'list: recent messages. search: messages matching a Gmail query. read: full message by id. ' +
    'Alfred only ever reads mail; it cannot send or modify.',
  inputSchema: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['connect', 'list', 'read', 'search'] },
      account: { type: 'string', description: 'Email address; defaults to the most recently connected account.' },
      query: { type: 'string', description: 'op=list/search: Gmail search query (e.g. "from:boss is:unread").' },
      id: { type: 'string', description: 'op=read: message id.' },
      maxResults: { type: 'number', description: 'op=list/search: max messages (default 10).' },
    },
    required: ['op'],
  },

  risk: (a) => (a.op === 'connect' ? 'T2' : 'T0'),

  async execute(a, ctx) {
    try {
      if (a.op === 'connect') {
        const { clientId, clientSecret } = oauthConfig();
        const approval = await ctx.governance.requestApproval({
          sessionId: ctx.sessionId,
          toolName: this.name,
          args: { op: 'connect' },
          tier: 'T2',
          reason: 'Connect a Gmail account (read-only) via Google consent',
        });
        if (approval.decision !== 'approve')
          return { ok: false, error: approval.timedOut ? 'Approval timed out — denied' : 'Denied by user' };

        const { tokens, email } = await oauthConnect(clientId, clientSecret);
        await ctx.secrets.set(`gmail:${email}`, JSON.stringify(tokens));
        ctx.db
          .prepare(
            'INSERT OR REPLACE INTO accounts (id, provider, email, secret_ref, connected_at) VALUES (?,?,?,?,?)',
          )
          .run(randomUUID(), 'gmail', email, `gmail:${email}`, Date.now());
        return { ok: true, result: { email } };
      }

      const email = resolveAccount(ctx, a.account);
      if (!email) return { ok: false, error: 'No connected Gmail account — run gmail connect first' };

      // Reading mail = private + untrusted content entering the session.
      ctx.governance.markTrifecta({ readUntrusted: true, hasPrivate: true });
      const client = await gmailFor(ctx, email);

      if (a.op === 'list' || a.op === 'search') {
        const list = await client.users.messages.list({
          userId: 'me',
          q: a.query,
          maxResults: a.maxResults && a.maxResults > 0 ? a.maxResults : 10,
        });
        const ids = list.data.messages ?? [];
        const messages = await Promise.all(
          ids.map(async (m) => {
            const meta = await client.users.messages.get({
              userId: 'me',
              id: m.id!,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date'],
            });
            const h = meta.data.payload?.headers;
            return {
              id: m.id,
              subject: header(h, 'Subject'),
              from: header(h, 'From'),
              date: header(h, 'Date'),
              snippet: meta.data.snippet ?? '',
            };
          }),
        );
        return { ok: true, result: { account: email, messages } };
      }

      if (a.op === 'read') {
        if (!a.id) return { ok: false, error: 'id is required for read' };
        const msg = await client.users.messages.get({ userId: 'me', id: a.id, format: 'full' });
        const h = msg.data.payload?.headers;
        return {
          ok: true,
          result: {
            account: email,
            id: a.id,
            subject: header(h, 'Subject'),
            from: header(h, 'From'),
            to: header(h, 'To'),
            date: header(h, 'Date'),
            snippet: msg.data.snippet ?? '',
            body: decodeBody(msg.data.payload ?? undefined),
          },
        };
      }

      return { ok: false, error: `Unknown op: ${(a as Args).op}` };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
