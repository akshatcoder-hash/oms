import type { ContenderModel, Funding } from './contenders.ts';

/** Where the run directory is mounted inside the agent container. Writable, private to one run. */
export const AGENT_HOME = '/home/agent';

export interface Launch {
  argv: string[];
  env: Record<string, string>;
  /** Files written under the agent home before launch, keyed by path relative to it. */
  files: Record<string, string>;
}

/** Output tokens per model call for every bench cell (OMS's --output-tokens, Claude Code's CLAUDE_CODE_MAX_OUTPUT_TOKENS). */
const BENCH_OUTPUT_TOKENS = 32_768;
export const benchOutputTokens = (model: ContenderModel) => Math.min(model.maxTokens, BENCH_OUTPUT_TOKENS);

/** Input bound OMS reserves per call. Subscription routes cost $0 per token and use the model's real context window. */
export const benchInputTokens = (r: { modelDefinition: ContenderModel; funding: Funding }) =>
  Math.min(r.modelDefinition.contextWindow, r.funding === 'api' ? 131_072 : 1_000_000);

const toml = (value: string) => JSON.stringify(value);

export interface SubscriptionLaunchInput {
  harness: 'codex' | 'claude-code';
  /** Vendor model id as the CLI names it. */
  modelId: string;
  prompt: string;
  /** Egress tunnel URL on the private bridge; the only way out, limited to the vendor's hosts (open HTTPS for online cells). */
  egress: string;
  /** Online cell: the CLI's own web search on, plus the official Solana MCP (codex; Claude Code). */
  online?: boolean;
}

export const SOLANA_MCP_URL = 'https://mcp.solana.com/mcp';

/**
 * Vendor CLIs on the subscription login. Traffic is not metered (the CLI talks to its vendor over
 * TLS through the allowlist tunnel); usage is read from the CLI's own output afterwards.
 */
export function buildSubscriptionLaunch(o: SubscriptionLaunchInput): Launch {
  const net = { HTTPS_PROXY: o.egress, https_proxy: o.egress, HOME: AGENT_HOME, TMPDIR: '/tmp' };
  switch (o.harness) {
    case 'codex':
      return {
        argv: [
          'codex',
          'exec',
          '--model',
          o.modelId,
          '--dangerously-bypass-approvals-and-sandbox',
          '--skip-git-repo-check',
          '--json',
          o.prompt,
        ],
        // Codex's web search runs on OpenAI's side, so the egress allowlist cannot stop it; the config turns it off .
        env: { ...net, CODEX_HOME: `${AGENT_HOME}/.codex` },
        files: {
          '.codex/config.toml': o.online
            ? `web_search = "live"\n\n[mcp_servers.solana]\nurl = ${toml(SOLANA_MCP_URL)}\n`
            : 'web_search = "disabled"\n',
        },
      };
    case 'claude-code':
      // Web tools off (isolation rule); background calls use the cell's model; nonessential traffic off, so the CLI needs only the API host.
      // Online (the Claude Code cell): its own WebSearch/WebFetch on, plus only the Solana MCP.
      return {
        argv: [
          'claude',
          '-p',
          o.prompt,
          '--model',
          o.modelId,
          '--permission-mode',
          'bypassPermissions',
          '--output-format',
          'json',
          ...(o.online
            ? [
                '--strict-mcp-config',
                '--mcp-config',
                JSON.stringify({ mcpServers: { solana: { type: 'http', url: SOLANA_MCP_URL } } }),
              ]
            : ['--disallowedTools', 'WebSearch', 'WebFetch']),
        ],
        env: {
          ...net,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: o.modelId,
          ANTHROPIC_SMALL_FAST_MODEL: o.modelId,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(BENCH_OUTPUT_TOKENS),
          DISABLE_TELEMETRY: '1',
          DISABLE_AUTOUPDATER: '1',
          DISABLE_ERROR_REPORTING: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
        files: {},
      };
  }
}

export interface ParsedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number | null;
}

/** Best-effort token totals from a vendor CLI's machine-readable output. Unknown stays null; nothing is guessed. */
export function parseCliUsage(harness: SubscriptionLaunchInput['harness'], stdout: string): ParsedUsage | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  const events: Array<Record<string, any>> = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      /* not an event */
    }
  }
  const n = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  if (harness === 'claude-code') {
    const result = events.findLast((event) => event.type === 'result' && event.usage);
    if (!result) return null;
    const u = result.usage;
    return {
      inputTokens: n(u.input_tokens),
      outputTokens: n(u.output_tokens),
      cacheReadTokens: n(u.cache_read_input_tokens),
      cacheWriteTokens: n(u.cache_creation_input_tokens),
      turns: typeof result.num_turns === 'number' ? n(result.num_turns) : null,
    };
  }
  if (harness === 'codex') {
    const done = events.filter((event) => event.type === 'turn.completed' && event.usage);
    if (!done.length) return null;
    const sum = (key: string) => done.reduce((total, event) => total + n(event.usage[key]), 0);
    const cached = sum('cached_input_tokens');
    return {
      inputTokens: Math.max(0, sum('input_tokens') - cached),
      outputTokens: sum('output_tokens'),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      turns: done.length,
    };
  }
  return null;
}
