import { readFileSync } from 'node:fs';

/** The pi-format OAuth credential for a ChatGPT (Codex) subscription, without a refresh token. */
export interface CodexCredential { type: 'oauth'; access: string; refresh: ''; expires: number; accountId: string }

/**
 * Reads the Codex CLI login and returns a credential pi and OMS can use directly. The refresh token is deliberately dropped: a run
 * can then never rotate that login, and an expired access token fails the run as an infrastructure pause instead.
 */
export function codexCredential(authFile: string): CodexCredential {
  const auth = JSON.parse(readFileSync(authFile, 'utf8')) as { auth_mode?: string; tokens?: { access_token?: string } };
  const access = auth.tokens?.access_token;
  if (auth.auth_mode !== 'chatgpt' || !access) throw new Error('The Codex login is not a ChatGPT subscription login');
  const payload = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8')) as
    { exp?: number; 'https://api.openai.com/auth'?: { chatgpt_account_id?: string } };
  const accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId || typeof payload.exp !== 'number') throw new Error('The Codex access token carries no account or expiry');
  if (payload.exp * 1000 < Date.now() + 60 * 60_000) throw new Error('The Codex access token expires within the hour; log in again');
  return { type: 'oauth', access, refresh: '', expires: payload.exp * 1000, accountId };
}
