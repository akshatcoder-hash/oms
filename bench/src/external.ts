import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SubscriptionLaunchInput } from './harnesses.ts';

/** Staged logins are deleted as soon as the container exits; session logs in the home directory stay for the report. */
export function scrubCredentials(home: string): void {
  for (const path of ['.codex/auth.json', '.claude/.credentials.json']) rmSync(join(home, path), { force: true });
}

/** Login files each vendor CLI needs, copied into the run's private home with refresh tokens removed so a run can never rotate the login. */
type SubscriptionHarness = SubscriptionLaunchInput['harness'];

export function stageSubscriptionLogin(harness: SubscriptionHarness, home: string): void {
  const read = (path: string) => JSON.parse(readFileSync(join(homedir(), path), 'utf8')) as Record<string, any>;
  const write = (path: string, value: unknown) => {
    mkdirSync(dirname(join(home, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, path), JSON.stringify(value), { mode: 0o600 });
  };
  if (harness === 'codex') {
    const auth = read('.codex/auth.json');
    if (auth.tokens) auth.tokens.refresh_token = '';
    // An API key in the login file would put a provider key inside the contender (a cell must carry no provider key).
    delete auth.OPENAI_API_KEY;
    write('.codex/auth.json', auth);
  } else if (harness === 'claude-code') {
    // The CLI uses the access token as is; without the refresh token it can never extend the login past this run.
    const auth = read('.claude/.credentials.json');
    if (auth.claudeAiOauth) {
      delete auth.claudeAiOauth.refreshToken;
      delete auth.claudeAiOauth.refreshTokenExpiresAt;
    }
    write('.claude/.credentials.json', auth);
  }
}

/**
 * The CLI lost its staged sign-in mid-run (the staged login has no refresh token). Claude Code ends with an error result. Only the CLI's own unescaped event JSON counts, so the same words inside tool output do not.
 */
export function lostSubscriptionAuth(stdout: string): boolean {
  const last = stdout.trim().split('\n').at(-1) ?? '';
  try {
    const result = JSON.parse(last) as { type?: unknown; is_error?: unknown; result?: unknown };
    return (
      result.type === 'result' &&
      result.is_error === true &&
      typeof result.result === 'string' &&
      /Not logged in|Please run \/login|OAuth token has expired/.test(result.result)
    );
  } catch {
    return false;
  }
}
