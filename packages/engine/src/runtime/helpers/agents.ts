import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The name of the tool that starts a helper. */
export const AGENT_TOOL = 'agent';

export type AgentTools = 'read' | 'edit';
export type AgentSource = 'built-in' | 'personal' | 'project';

/** A kind of helper: what it is for, which tools it gets, and the instructions it starts with. */
export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  readonly tools: AgentTools;
  /** "provider/id"; absent means the chat's current model. */
  readonly model?: string;
  readonly instructions: string;
  readonly source: AgentSource;
}

export interface AgentDirs {
  /** `~/.oms/agents` */
  readonly personal: string;
  /** `<folder>/.oms-agents` */
  readonly project: string;
}

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_FILES = 64;

const REPORT = 'End with a report under 150 words: what you found or did, with file paths and line numbers.';

export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  {
    name: 'explore',
    description: 'Find code and facts, report file paths',
    tools: 'read',
    instructions: `You find things in the project and report them. You cannot change files. Read and search as much as you need, and give exact file paths and line numbers. ${REPORT}`,
    source: 'built-in',
  },
  {
    name: 'build',
    description: 'Make one scoped change and run its check',
    tools: 'edit',
    instructions: `You make the one change you were asked for, only in the files you were given, then run the check you were told to run and report what it showed. If you need a file outside your files, say so in the report instead. ${REPORT}`,
    source: 'built-in',
  },
  {
    name: 'review',
    description: 'Read a diff or program, report problems',
    tools: 'read',
    instructions: `You review code and report problems, most serious first, each as file:line, the risk and a fix. You cannot change files. For a Solana program check signer, owner, account and PDA validation first. ${REPORT}`,
    source: 'built-in',
  },
];

interface Parsed {
  readonly definition?: AgentDefinition;
  readonly problem?: string;
}

/** `key: value` lines between two `---` fences; a ` # note` after a value is dropped. */
function frontmatter(text: string): { fields: Map<string, string>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const pair = /^([a-z]+):\s*(.*?)\s*(?:\s#.*)?$/.exec(line);
    if (!pair) return undefined;
    fields.set(pair[1]!, pair[2]!);
  }
  return { fields, body: match[2]!.trim() };
}

function parseAgent(stem: string, text: string, source: AgentSource): Parsed {
  const parsed = frontmatter(text);
  if (!parsed) return { problem: `${stem}.md: needs a --- header with name and description` };
  const { fields, body } = parsed;
  const unknown = [...fields.keys()].find((key) => !['name', 'description', 'tools', 'model'].includes(key));
  if (unknown) return { problem: `${stem}.md: unknown field "${unknown}"` };
  const name = fields.get('name') ?? '';
  if (!AGENT_NAME.test(name)) return { problem: `${stem}.md: name must be lowercase letters, digits and dashes` };
  if (name !== stem) return { problem: `${stem}.md: name "${name}" must match the file name` };
  const description = fields.get('description') ?? '';
  if (!description) return { problem: `${stem}.md: description is required` };
  const tools = fields.get('tools') ?? 'read';
  if (tools !== 'read' && tools !== 'edit') return { problem: `${stem}.md: tools must be read or edit` };
  const model = fields.get('model');
  if (model !== undefined && !/^[\w.-]+\/\S+$/.test(model))
    return { problem: `${stem}.md: model must look like provider/id` };
  if (!body) return { problem: `${stem}.md: write the instructions below the header` };
  return { definition: { name, description, tools, ...(model ? { model } : {}), instructions: body, source } };
}

function readDirectory(dir: string, source: AgentSource): { agents: AgentDefinition[]; problems: string[] } {
  const agents: AgentDefinition[] = [];
  const problems: string[] = [];
  if (!existsSync(dir)) return { agents, problems };
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch {
    return { agents, problems: [`${dir}: cannot be read`] };
  }
  for (const file of names.slice(0, MAX_FILES)) {
    const stem = file.slice(0, -3);
    try {
      const path = join(dir, file);
      const info = statSync(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        problems.push(`${file}: not a regular file under 16 KB`);
        continue;
      }
      const result = parseAgent(stem, readFileSync(path, 'utf8'), source);
      if (result.definition) agents.push(result.definition);
      else problems.push(result.problem!);
    } catch {
      problems.push(`${file}: cannot be read`);
    }
  }
  return { agents, problems };
}

/** Project beats personal beats built-in, by name. A file that fails to parse is listed in `problems` and never half-applied. */
export function loadAgents(dirs: AgentDirs): { agents: AgentDefinition[]; problems: string[] } {
  const byName = new Map(BUILT_IN_AGENTS.map((agent) => [agent.name, agent]));
  const problems: string[] = [];
  for (const [dir, source] of [
    [dirs.personal, 'personal'],
    [dirs.project, 'project'],
  ] as const) {
    const found = readDirectory(dir, source);
    problems.push(...found.problems.map((problem) => `${source}: ${problem}`));
    for (const agent of found.agents) byName.set(agent.name, agent);
  }
  return { agents: [...byName.values()], problems };
}

export interface AgentDraft {
  readonly name: string;
  readonly description: string;
  readonly scope: 'personal' | 'project';
  readonly tools?: AgentTools;
}

/** Writes a new agent file from a template and returns its path. Never overwrites. */
export function writeAgent(dirs: AgentDirs, draft: AgentDraft): string {
  if (!AGENT_NAME.test(draft.name)) throw new Error('The name must be lowercase letters, digits and dashes.');
  const description = draft.description.replace(/\s+/g, ' ').trim();
  if (!description) throw new Error('Say what the agent does.');
  if (/\s#/.test(description)) throw new Error('Leave "#" out of the description.');
  const dir = draft.scope === 'project' ? dirs.project : dirs.personal;
  const path = join(dir, `${draft.name}.md`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tools = draft.tools ?? 'read';
  const text = `---\nname: ${draft.name}\ndescription: ${description}\ntools: ${tools}\n---\nYou are ${draft.name}: ${description}.\n${
    tools === 'edit' ? 'Change only the files you were given.' : 'You cannot change files.'
  } ${REPORT}\n`;
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`${path} already exists.`);
    throw error;
  }
  return path;
}
