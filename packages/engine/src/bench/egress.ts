import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, connect, isIP, type AddressInfo } from 'node:net';

export interface EgressOptions {
  /** Interface to listen on; the benchmark binds the private Docker bridge gateway. */
  host: string;
  port: number;
  /**
   * Exact hostnames, or `*.example.com` for any subdomain; everything else is refused. `public-https` (online cells only) admits any host
   * whose address is public, so web fetch works but the host, the VPC and cloud metadata stay out of reach.
   */
  allow: readonly string[] | 'public-https';
  logFile: string;
}

/** Vendor hosts the subscription CLIs talk to. Only these are reachable from their containers. */
export const SUBSCRIPTION_HOSTS = [
  'chatgpt.com', 'auth.openai.com', 'api.openai.com',
  'api.x.ai', 'auth.x.ai', 'accounts.x.ai', 'grok.com', '*.grok.com',
] as const;

/** Claude Code on the owner subscription (owner 2026-11-09 17:26Z), with nonessential traffic off; the Opus experiment's tunnel allows only these. */
export const CLAUDE_CODE_HOSTS = ['api.anthropic.com'] as const;

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for a globally routable address. IPv4-mapped IPv6 is judged as its IPv4 address. */
export function publicAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  const address = mapped ?? ip;
  const family = isIP(address);
  return family !== 0 && !PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The address to dial, or null when the rule refuses the host. Open mode resolves once and dials that address, so DNS cannot rebind it. */
async function admit(host: string, allow: EgressOptions['allow']): Promise<string | null> {
  if (allow !== 'public-https') return hostAllowed(host, allow) ? host : null;
  try {
    const { address } = await lookup(host);
    return publicAddress(address) ? address : null;
  } catch { return null; }
}

export const hostAllowed = (host: string, allow: readonly string[]) => {
  const name = host.toLowerCase();
  return allow.some(rule => rule.startsWith('*.') ? name.endsWith(rule.slice(1)) && name.length > rule.length - 1 : name === rule);
};

/**
 * A CONNECT-only tunnel with a hostname allowlist and TLS left untouched: the CLI keeps its own end-to-end encryption to the vendor,
 * and the container reaches nothing else. Subscription traffic cannot go through the key-injecting metering proxy.
 */
export async function startEgressProxy(o: EgressOptions): Promise<{ port: number; close(): Promise<void> }> {
  const log = (entry: Record<string, unknown>) => appendFileSync(o.logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  const open = new Set<import('node:stream').Duplex>();
  const server = createServer((_req, res) => { res.writeHead(403); res.end('CONNECT only'); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connect', async (req, client, head) => {
    client.on('error', () => { /* a reset from the container must never crash the tunnel */ });
    const [host = '', portText = ''] = (req.url ?? '').split(':');
    const port = Number(portText);
    const address = port === 443 ? await admit(host, o.allow) : null;
    if (!address) {
      log({ host: host.slice(0, 120), port, allowed: false });
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(443, address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    open.add(client); open.add(upstream);
    const done = () => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream); };
    upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); done(); });
    client.on('error', done);
    upstream.on('close', done);
    client.on('close', done);
    log({ host, port, allowed: true });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(o.port, o.host, resolve); });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => { for (const socket of open) socket.destroy(); server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
