import { isAbsolute, relative } from 'node:path';
import { Container, Text } from '@earendil-works/pi-tui';
import { renderDiff } from '@earendil-works/pi-coding-agent';
import { displayText, singleLine } from './transcript.ts';

interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}
interface RenderContext {
  args?: Record<string, unknown>;
  cwd?: string;
  isError: boolean;
  lastComponent?: unknown;
  state: Record<string, unknown>;
}
interface ToolResult {
  content?: { type: string; text?: string }[];
  details?: { created?: boolean; lines?: number; diff?: string };
}
type Definition = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const quoted = (value: unknown): string => `"${singleLine(text(value), 80)}"`;

function shownPath(value: unknown, cwd?: string): string {
  const path = singleLine(text(value), 200);
  if (!cwd || !isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith('..') ? rel : path;
}
function resultText(result: ToolResult): string {
  return (result.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}
function reuse<T>(last: unknown, make: () => T): T {
  return (last ?? make()) as T;
}

/** What each OMS tool does in one line. Anything not listed shows its name and first argument. */
const SUMMARIES: Record<string, (args: Record<string, unknown>) => string> = {
  web_search: (a) => `Searched the web: ${quoted(a.query)}`,
  web_fetch: (a) => `Fetched ${singleLine(text(a.url), 200)}`,
  source_fetch: (a) => `Fetched source ${singleLine(text(a.url ?? a.source), 200)}`,
  solana_docs_search: (a) => `Searched Solana docs: ${quoted(a.query)}`,
  solana_ask: (a) => `Asked Solana docs: ${quoted(a.question ?? a.query)}`,
  solana_list_sections: () => 'Listed Solana doc sections',
  solana_get_documentation: (a) => `Read Solana docs: ${singleLine(text(a.section ?? a.name ?? a.path), 120)}`,
  search_docs: (a) => `Searched Solana docs: ${quoted(a.query)}`,
  read_doc: (a) => `Read doc ${singleLine(text(a.id ?? a.path ?? a.url), 160)}`,
  list_sources: () => 'Listed doc sources',
  decode_error: (a) =>
    `Decoded error ${singleLine(text(a.code), 40)}${a.program ? ` of ${singleLine(text(a.program), 60)}` : ''}`,
  idl_lookup: (a) => `Looked up IDL: ${singleLine(text(a.program ?? a.name ?? a.query), 120)}`,
  api_lookup: (a) => `Looked up API: ${singleLine(text(a.name ?? a.query ?? a.symbol), 120)}`,
  detect_topics: () => 'Detected Solana topics',
  list_topics: () => 'Listed Solana topics',
  get_topic: (a) => `Read topic ${singleLine(text(a.name ?? a.id ?? a.topic), 120)}`,
  toolchain_check: () => 'Checked the Solana toolchain',
  deps_fetch: () => 'Fetched dependencies',
  read_log: (a) => `Read command log ${singleLine(text(a.id), 40)}`,
};

function summaryDefinition(name: string, definition: Definition): Definition {
  const summarize = SUMMARIES[name];
  return {
    ...definition,
    renderCall(args: Record<string, unknown>, theme: Theme, context: RenderContext) {
      const line = reuse(context.lastComponent, () => new Text('', 0, 0));
      const first = Object.values(args ?? {}).find((value) => typeof value === 'string');
      const summary = summarize ? summarize(args ?? {}) : `${name}${first ? ' ' + quoted(first) : ''}`;
      line.setText(theme.fg('muted', summary));
      return line;
    },
    renderResult(result: ToolResult, options: { expanded: boolean }, theme: Theme, context: RenderContext) {
      const box = reuse(context.lastComponent, () => new Container());
      box.clear();
      const body = context.isError || options.expanded ? displayText(resultText(result), 4000).trim() : '';
      if (body) box.addChild(new Text(theme.fg(context.isError ? 'error' : 'toolOutput', body), 0, 0));
      return box;
    },
  };
}

/** A new file is one line; an existing file shows what changed; Ctrl+O shows the whole content. */
function writeDefinition(definition: Definition): Definition {
  return {
    ...definition,
    renderCall(args: Record<string, unknown>, theme: Theme, context: RenderContext) {
      const line = reuse(context.lastComponent, () => new Text('', 0, 0));
      context.state.writeCall = line;
      context.state.writePath = shownPath(args?.path ?? args?.file_path, context.cwd);
      line.setText(
        `${theme.fg('toolTitle', theme.bold('write'))} ${theme.fg('accent', String(context.state.writePath))}`,
      );
      return line;
    },
    renderResult(result: ToolResult, options: { expanded: boolean }, theme: Theme, context: RenderContext) {
      const box = reuse(context.lastComponent, () => new Container());
      box.clear();
      const call = context.state.writeCall as Text | undefined;
      const path = String(context.state.writePath ?? '');
      if (context.isError) {
        box.addChild(new Text(`\n${theme.fg('error', displayText(resultText(result), 2000))}`, 0, 0));
        return box;
      }
      const details = result.details;
      if (details?.created) {
        call?.setText(
          `${theme.fg('toolTitle', theme.bold('Wrote'))} ${theme.fg('accent', path)} ${theme.fg('muted', `(${plural(details.lines ?? 0, 'line')})`)}`,
        );
        const content = displayText(text(context.args?.content), 20_000);
        if (options.expanded && content)
          box.addChild(new Text(`\n${theme.fg('toolOutput', content.replace(/\n$/, ''))}`, 0, 0));
      } else if (details?.diff) {
        box.addChild(new Text(`\n${renderDiff(displayText(details.diff, 20_000), { filePath: path })}`, 0, 0));
      }
      return box;
    },
  };
}

/** The tool as the transcript draws it: pi's own look for pi's tools, one line for OMS's, a diff or one line for write. */
export function displayDefinition(name: string, definition: unknown): unknown {
  if (!definition || typeof definition !== 'object') return definition;
  const base = definition as Definition;
  if (name === 'write') return writeDefinition(base);
  if (['read', 'edit', 'bash', 'ls', 'find', 'grep'].includes(name)) return base;
  return summaryDefinition(name, base);
}
