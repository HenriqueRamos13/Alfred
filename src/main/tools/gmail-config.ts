/**
 * OAuth config validation, shared by the gmail tool (guard before the browser
 * flow), the preload "connect Gmail" hint, and the logic tests. Kept dependency
 * free on purpose so the preload bundle never pulls in @googleapis/gmail.
 */

export const GMAIL_NOT_CONFIGURED =
  'Gmail não configurado. Cria um OAuth client no Google Cloud (ativa a Gmail API + OAuth client ID tipo Desktop app), ' +
  'mete GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET no .env e reinicia. Ver README (Connecting Gmail).';

/**
 * True only when both OAuth vars hold real values — not empty, not a placeholder
 * ("your-client-id", "xxxx"), and the id has the Desktop-app client shape
 * (`*.apps.googleusercontent.com`). Guards against opening a Google error page.
 */
export function gmailConfigured(env: NodeJS.ProcessEnv): boolean {
  const id = (env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
  const secret = (env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!id || !secret) return false;
  const blob = `${id} ${secret}`.toLowerCase();
  if (blob.includes('your-client-id') || blob.includes('xxxx')) return false;
  return id.endsWith('.apps.googleusercontent.com');
}
