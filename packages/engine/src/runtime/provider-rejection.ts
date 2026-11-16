const PROVIDER_NAMES: Record<string, string> = {
  xai: 'xAI',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  'google-vertex': 'Google',
  groq: 'Groq',
  mistral: 'Mistral',
  openrouter: 'OpenRouter',
  cerebras: 'Cerebras',
  deepseek: 'DeepSeek',
  'openai-codex': 'Codex',
  'github-copilot': 'GitHub Copilot',
};

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}

/** A 4xx answer is a refusal to start. 408 and 429 say nothing about whether work began, so they keep their transient handling. */
export function isRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

const KEY_LIKE = /\b(?:sk|xai|gsk|key)[-_][A-Za-z0-9_-]{8,}/g;

function messageFrom(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const field of ['message', 'error', 'detail', 'msg']) {
    const found = messageFrom(record[field]);
    if (found) return found;
  }
  return undefined;
}

/** One plain sentence for a rejected request: the provider's own reason, never raw JSON and never a key. */
export function describeRejection(provider: string, status: number, body: string): string {
  const name = providerName(provider);
  if (status === 401 || status === 403) return `${name} says the API key is invalid. /connect to fix it.`;
  let reason: string | undefined;
  try {
    reason = messageFrom(JSON.parse(body));
  } catch {
    reason = /^\s*[{[]/.test(body) ? undefined : body;
  }
  const clean = (reason ?? '')
    .replace(KEY_LIKE, '[key]')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return clean ? `${name} rejected the request: ${clean}` : `${name} rejected the request (HTTP ${status}).`;
}
