const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Comma-separated lowercase hex SHA-256 digests; anything else in the list is ignored. */
export function digestList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => /^[0-9a-f]{64}$/.test(part));
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The digest of the request's bearer token when it is in `accepted`, else undefined. The token itself is never kept. */
export async function authorize(request: Request, accepted: string[]): Promise<string | undefined> {
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(request.headers.get('authorization') ?? '');
  if (!match || !accepted.length) return undefined;
  const digest = await sha256Hex(match[1]!);
  let ok = false;
  for (const candidate of accepted) ok = sameHex(digest, candidate) || ok;
  return ok ? digest : undefined;
}
