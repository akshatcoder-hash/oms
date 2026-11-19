// Ported from packages/engine/src/runtime/web.ts (htmlToMarkdown), unchanged.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text: string) =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{0,15});/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

// Everything below scans with indexOf, never a lazy or unbounded regex span: hostile markup (thousands of unclosed
// tags) must cost linear time, because this runs on the main thread where the fetch timeout cannot stop it.
/** Removes `<...>` tags; an unclosed `<` and everything after it stays as text. */
function tags(html: string): string {
  let out = '';
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    const gt = lt < 0 ? -1 : html.indexOf('>', lt);
    if (gt < 0) return out + html.slice(at);
    out += html.slice(at, lt);
    at = gt + 1;
  }
}
// Entities are decoded once, last, so decoded text such as `Vec&lt;u8&gt;` is never mistaken for a tag.
const strip = (html: string) => decode(tags(html));

/** Replaces each `<name ...>inner</name>` with render(inner, openTag). Stops at the first unclosed element. */
function elements(html: string, name: string, render: (inner: string, open: string) => string): string {
  const lower = html.toLowerCase();
  let out = '';
  let at = 0;
  let from = 0;
  for (;;) {
    const lt = lower.indexOf(`<${name}`, from);
    if (lt < 0) break;
    if (!/[\s>/]/.test(lower[lt + name.length + 1] ?? '')) {
      from = lt + 1;
      continue;
    }
    const gt = lower.indexOf('>', lt);
    const close = gt < 0 ? -1 : lower.indexOf(`</${name}`, gt);
    if (close < 0) break;
    const closeGt = lower.indexOf('>', close);
    out += html.slice(at, lt) + render(html.slice(gt + 1, close), html.slice(lt, gt + 1));
    at = from = closeGt < 0 ? html.length : closeGt + 1;
  }
  return out + html.slice(at);
}

/** The outermost `<name>...</name>` span, if the page has one. */
function outer(html: string, name: string): string | undefined {
  const lower = html.toLowerCase();
  const start = lower.indexOf(`<${name}`);
  const end = lower.lastIndexOf(`</${name}>`);
  return start >= 0 && end > start ? html.slice(start, end + name.length + 3) : undefined;
}

/**
 * Readability-style extraction without a dependency: the <article> or <main> body (else <body>), page chrome removed,
 * headings, links, lists, tables and code kept as markdown.
 * shortcut: string scanning, not a DOM; nested same-name elements or odd markup degrade to plain text. Upgrade to @mozilla/readability if quality matters.
 */
export function htmlToMarkdown(html: string, base: string): { title: string; markdown: string } {
  let title = '';
  elements(html, 'title', (inner) => {
    title ||= strip(inner).trim();
    return '';
  });
  const focused = outer(html, 'article') ?? outer(html, 'main');
  let body = focused ?? outer(html, 'body') ?? html;
  let comments = '';
  for (let at = 0; ;) {
    const open = body.indexOf('<!--', at);
    const close = open < 0 ? -1 : body.indexOf('-->', open + 4);
    if (close < 0) {
      body = comments + body.slice(at);
      break;
    }
    comments += body.slice(at, open);
    at = close + 3;
  }
  // A page <header> is chrome; inside an article it usually holds the article's own title.
  for (const name of [
    'script',
    'style',
    'noscript',
    'svg',
    'nav',
    'footer',
    'aside',
    'form',
    'iframe',
    'template',
    ...(focused ? [] : ['header']),
  ]) {
    body = elements(body, name, () => '');
  }
  const blocks: string[] = [];
  body = elements(
    body,
    'pre',
    (code) => `\n\n\u0000${blocks.push('```\n' + strip(code).replace(/\n+$/, '') + '\n```') - 1}\u0000\n\n`,
  );
  for (let level = 1; level <= 6; level++)
    body = elements(body, `h${level}`, (text) => `\n\n${'#'.repeat(level)} ${tags(text).trim()}\n\n`);
  body = elements(body, 'a', (text, open) => {
    const label = tags(text).trim();
    const href = /\shref\s*=\s*["']([^"']{0,2048})["']/i.exec(open)?.[1];
    if (!label || href === undefined) return label;
    let target = href;
    try {
      target = new URL(decode(href), base).href;
    } catch {
      /* keep the raw href */
    }
    return target.startsWith('http') ? `[${label}](${target})` : label;
  });
  body = elements(body, 'code', (code) => '`' + tags(code) + '`')
    .replace(/<li(?=[\s>])/gi, '\n- <li')
    .replace(/<br(?=[\s>/])/gi, '\n<br')
    .replace(/<\/t[dh]>/gi, ' | ')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/(p|div|section|ul|ol|table|blockquote|dl|dd|dt)>/gi, '\n\n');
  const markdown = strip(body)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/^- ?$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\u0000(\d+)\u0000/g, (_m, index: string) => blocks[Number(index)]!)
    .trim();
  return { title, markdown };
}
