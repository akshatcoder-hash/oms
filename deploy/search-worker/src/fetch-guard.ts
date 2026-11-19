import { htmlToMarkdown } from './html.ts';
import { isIP, isPrivateAddress } from './net.ts';

export const MAX_DOWNLOAD_BYTES = 2_000_000;
export const MAX_TEXT_CHARS = 200_000;
const MAX_REDIRECTS = 5;
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
  'metadata.azure.com',
]);

const PRIVATE = 'web_fetch refuses private, loopback and link-local addresses';

/** A refusal whose message is safe to return to the caller. */
export class GuardError extends Error {}

export type Resolve = (host: string) => Promise<string[]>;

/** The only URLs /fetch accepts: absolute HTTPS, no credentials, no metadata host, and an IP literal must be public. */
export function parseFetchUrl(raw: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new GuardError('web_fetch needs an absolute https:// URL');
  }
  if (url.protocol !== 'https:') throw new GuardError('web_fetch only fetches https:// URLs');
  if (url.username || url.password) throw new GuardError('web_fetch refuses URLs with credentials');
  const host = bareHost(url);
  if (
    !host ||
    METADATA_HOSTS.has(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    host === 'localhost' ||
    host.endsWith('.localhost')
  )
    throw new GuardError(PRIVATE);
  if (isIP(host) && isPrivateAddress(host)) throw new GuardError(PRIVATE);
  return url;
}

const bareHost = (url: URL) =>
  url.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();

/** A/AAAA answers over DNS-over-HTTPS (Workers have no resolver API). */
export const dohResolve: Resolve = async (host) => {
  const answers: string[] = [];
  for (const type of ['A', 'AAAA']) {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!response.ok) throw new GuardError('the host could not be resolved');
    const body = (await response.json()) as { Answer?: { type: number; data: string }[] };
    for (const answer of body.Answer ?? []) if (answer.type === 1 || answer.type === 28) answers.push(answer.data);
  }
  return answers;
};

/** Resolves the host and refuses it when it does not resolve or any answer is private, loopback, link-local, CGNAT or reserved. */
export async function assertPublicHost(url: URL, resolve: Resolve): Promise<void> {
  const host = bareHost(url);
  if (isIP(host)) return;
  const addresses = await resolve(host).catch(() => [] as string[]);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new GuardError(PRIVATE);
}

/** Reads at most `limit` bytes of the body; the rest is cancelled. */
export async function readCapped(
  response: Response,
  limit: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { bytes, truncated };
}

export interface Page {
  finalUrl: string;
  title: string;
  text: string;
  truncated: boolean;
}

/** Caps text at MAX_TEXT_CHARS. */
export const capText = (page: Page): Page => ({
  ...page,
  text: page.text.slice(0, MAX_TEXT_CHARS),
  truncated: page.truncated || page.text.length > MAX_TEXT_CHARS,
});

/** GET with every hop re-checked (URL rules and DNS), at most 5 redirects, the body capped at 2 MB. */
export async function plainFetch(
  start: URL,
  resolve: Resolve,
  signal: AbortSignal,
  doFetch: typeof fetch = fetch,
): Promise<Page> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url, resolve);
    const response = await doFetch(url.href, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9,*/*;q=0.5',
        'user-agent': 'oms-search/1',
      },
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      void response.body?.cancel().catch(() => {});
      url = parseFetchUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new GuardError(`web_fetch got HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !/html/i.test(contentType) && !/^(text\/|application\/(json|xml|markdown))/i.test(contentType)) {
      void response.body?.cancel().catch(() => {});
      // The server's own Content-Type text is not echoed.
      throw new GuardError(
        `web_fetch does not read ${/^[\w.+-]{1,64}\/[\w.+-]{1,64}/.exec(contentType)?.[0] ?? 'this'} content`,
      );
    }
    const { bytes, truncated } = await readCapped(response, MAX_DOWNLOAD_BYTES);
    const body = new TextDecoder().decode(bytes);
    if (/html/i.test(contentType)) {
      const { title, markdown } = htmlToMarkdown(body, url.href);
      return { finalUrl: url.href, title: '', text: title ? `# ${title}\n\n${markdown}` : markdown, truncated };
    }
    return { finalUrl: url.href, title: '', text: body, truncated };
  }
  throw new GuardError(`web_fetch stopped after ${MAX_REDIRECTS} redirects`);
}
