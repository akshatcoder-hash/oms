/** IPv4 dotted quad to a 32-bit number, or undefined when the text is not one. */
export function parseIPv4(text: string): number | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

/** IPv6 text (brackets, a trailing dotted quad and a zone allowed) to eight 16-bit groups, or undefined. */
export function parseIPv6(text: string): number[] | undefined {
  let host = text.replace(/^\[|\]$/g, '').split('%')[0]!;
  if (!host.includes(':')) return undefined;
  const quad = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (quad) {
    const v4 = parseIPv4(quad[1]!);
    if (v4 === undefined) return undefined;
    host = `${host.slice(0, -quad[1]!.length)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = host.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part ? part.split(':') : []);
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (![...head, ...tail].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  return [...head, ...new Array<string>(fill).fill('0'), ...tail].map((g) => parseInt(g, 16));
}

const V4_BLOCKS: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
// IPv4-compatible, IPv4-mapped, NAT64 and 6to4 forms are refused outright rather than unpacked.
const V6_BLOCKS: [string, number][] = [
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

const inV4 = (address: number, [net, prefix]: [string, number]) => {
  const size = 2 ** (32 - prefix);
  return Math.floor(address / size) === Math.floor(parseIPv4(net)! / size);
};
const inV6 = (groups: number[], [net, prefix]: [string, number]) => {
  const base = parseIPv6(net)!;
  for (let bit = 0; bit < prefix; bit += 16) {
    const take = Math.min(16, prefix - bit);
    const shift = 16 - take;
    if (groups[bit / 16]! >> shift !== base[bit / 16]! >> shift) return false;
  }
  return true;
};

/** True for a literal IPv4 or IPv6 address (brackets allowed). */
export const isIP = (host: string) => parseIPv4(host) !== undefined || parseIPv6(host) !== undefined;

/** Loopback, RFC 1918, link-local, CGNAT, multicast, documentation, reserved and unspecified addresses; non-IPs too. */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4 !== undefined) return V4_BLOCKS.some((block) => inV4(v4, block));
  const v6 = parseIPv6(address);
  if (v6 === undefined) return true;
  if (v6.every((g, i) => g === (i === 7 ? 1 : 0))) return true;
  return V6_BLOCKS.some((block) => inV6(v6, block));
}
