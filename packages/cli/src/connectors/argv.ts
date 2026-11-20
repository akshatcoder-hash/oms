/**
 * The argument lists connectors run on the host. Each action has a fixed shape; the model or the user supplies only
 * values, and every value is checked before it reaches an argument list. There is no shell, so a value can never become
 * a command, and none can begin with `-`, so none can become an option.
 */

export class ArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgumentError';
  }
}
function fail(message: string): never {
  throw new ArgumentError(message);
}

/** A program to run, its fixed arguments, and what the approval row says about it. */
export interface Call {
  program: string;
  args: string[];
  write: boolean;
  /** One line for the approval row and the transcript. */
  summary: string;
  timeoutMs: number;
  /** Keep only the last lines of the output (long CI logs). */
  tail?: number;
}
export type Params = Readonly<Record<string, unknown>>;
interface Action {
  write: boolean;
  build(params: Params): { args: string[]; summary: string; tail?: number };
}

const READ_MS = 20_000;
const WRITE_MS = 120_000;
const NUMBER = /^#?(\d{1,9})$/;
const REF = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;
const RUN_ID = /^\d{1,15}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;

const present = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

/** `42` or `#42`: the number, or undefined when none was given. */
function number(params: Params, key: string, required = false): string | undefined {
  const value = params[key];
  if (!present(value)) return required ? fail(`${key} is required, for example 42.`) : undefined;
  const match = NUMBER.exec(String(value).trim());
  return match ? match[1] : fail(`${key} must be a number such as 42.`);
}
/** A number, or a branch name; for commands that take either. */
function reference(params: Params, key: string): string | undefined {
  const value = params[key];
  if (!present(value)) return undefined;
  const text = String(value).trim();
  const match = NUMBER.exec(text);
  if (match) return match[1];
  return REF.test(text) && !text.includes('..') && !text.endsWith('/')
    ? text
    : fail(`${key} must be a number or a branch name.`);
}
function text(params: Params, key: string, max: number, required = true): string | undefined {
  const value = params[key];
  if (!present(value)) return required ? fail(`${key} is required.`) : undefined;
  if (typeof value !== 'string') return fail(`${key} must be text.`);
  if (value.length > max) return fail(`${key} is longer than ${max} characters.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return fail(`${key} contains control characters.`);
  return value;
}
function pick<T extends string>(params: Params, key: string, allowed: readonly T[], fallback: T): T {
  const value = params[key];
  if (!present(value)) return fallback;
  return allowed.includes(value as T) ? (value as T) : fail(`${key} must be one of: ${allowed.join(', ')}.`);
}
function limit(params: Params, key = 'limit', fallback = 20, max = 50): string {
  const value = params[key];
  if (!present(value)) return String(fallback);
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max
    ? String(n)
    : fail(`${key} must be a whole number from 1 to ${max}.`);
}
const preview = (value: string | undefined, max = 60): string => {
  const line = (value ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};
const label = (prefix: string, number?: string) => (number ? `${prefix} #${number}` : prefix);

// ---------------------------------------------------------------- GitHub (gh)

export const GITHUB_ACTIONS: Readonly<Record<string, Action>> = {
  pr_view: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: [
          'pr',
          'view',
          ...(n ? [n] : []),
          '--json',
          'number,title,body,state,headRefName,baseRefName,author,labels,reviewDecision,reviews,comments,files',
        ],
        summary: label('view pull request', n),
      };
    },
  },
  pr_list: {
    write: false,
    build(p) {
      const state = pick(p, 'state', ['open', 'closed', 'merged', 'all'], 'open');
      return {
        args: [
          'pr',
          'list',
          '--state',
          state,
          '--limit',
          limit(p),
          '--json',
          'number,title,headRefName,author,state,updatedAt',
        ],
        summary: `list ${state} pull requests`,
      };
    },
  },
  pr_diff: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['pr', 'diff', ...(n ? [n] : [])], summary: label('diff pull request', n) };
    },
  },
  pr_files: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: ['pr', 'diff', ...(n ? [n] : []), '--name-only'],
        summary: label('changed files of pull request', n),
      };
    },
  },
  pr_checks: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return {
        args: ['pr', 'checks', ...(n ? [n] : []), '--json', 'name,state,bucket,link,workflow'],
        summary: label('checks of pull request', n),
      };
    },
  },
  run_failed_log: {
    write: false,
    build(p) {
      const id = String(p.run_id ?? '').trim();
      if (!RUN_ID.test(id)) fail('run_id must be the number of a workflow run.');
      return { args: ['run', 'view', id, '--log-failed'], summary: `failed log of run ${id}`, tail: 200 };
    },
  },
  issue_view: {
    write: false,
    build(p) {
      const n = number(p, 'number', true);
      return {
        args: ['issue', 'view', n!, '--json', 'number,title,body,state,labels,author,comments'],
        summary: label('view issue', n),
      };
    },
  },
  issue_list: {
    write: false,
    build(p) {
      const state = pick(p, 'state', ['open', 'closed', 'all'], 'open');
      return {
        args: ['issue', 'list', '--state', state, '--limit', limit(p), '--json', 'number,title,state,labels,updatedAt'],
        summary: `list ${state} issues`,
      };
    },
  },
  pr_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      const base = reference(p, 'base');
      return {
        args: [
          'pr',
          'create',
          `--title=${title}`,
          `--body=${body}`,
          ...(base ? [`--base=${base}`] : []),
          ...(p.draft === true ? ['--draft'] : []),
        ],
        summary: `open pull request "${preview(title)}"${base ? ` into ${base}` : ''}`,
      };
    },
  },
  pr_comment: {
    write: true,
    build(p) {
      const n = reference(p, 'number');
      const body = text(p, 'body', 8000)!;
      return {
        args: ['pr', 'comment', ...(n ? [n] : []), `--body=${body}`],
        summary: `${label('comment on pull request', n)}: "${preview(body)}"`,
      };
    },
  },
  issue_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      return {
        args: ['issue', 'create', `--title=${title}`, `--body=${body}`],
        summary: `open issue "${preview(title)}"`,
      };
    },
  },
  issue_comment: {
    write: true,
    build(p) {
      const n = number(p, 'number', true);
      const body = text(p, 'body', 8000)!;
      return {
        args: ['issue', 'comment', n!, `--body=${body}`],
        summary: `${label('comment on issue', n)}: "${preview(body)}"`,
      };
    },
  },
};

// ---------------------------------------------------------------- GitLab (glab)

export const GITLAB_ACTIONS: Readonly<Record<string, Action>> = {
  mr_view: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['mr', 'view', ...(n ? [n] : []), '--comments'], summary: label('view merge request', n) };
    },
  },
  mr_list: {
    write: false,
    build(p) {
      return { args: ['mr', 'list', '--per-page', limit(p)], summary: 'list merge requests' };
    },
  },
  mr_diff: {
    write: false,
    build(p) {
      const n = reference(p, 'number');
      return { args: ['mr', 'diff', ...(n ? [n] : [])], summary: label('diff merge request', n) };
    },
  },
  issue_view: {
    write: false,
    build(p) {
      const n = number(p, 'number', true);
      return { args: ['issue', 'view', n!, '--comments'], summary: label('view issue', n) };
    },
  },
  issue_list: {
    write: false,
    build(p) {
      return { args: ['issue', 'list', '--per-page', limit(p)], summary: 'list issues' };
    },
  },
  ci_status: {
    write: false,
    build() {
      return { args: ['ci', 'status'], summary: 'pipeline status of this branch', tail: 200 };
    },
  },
  mr_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      const base = reference(p, 'base');
      return {
        args: [
          'mr',
          'create',
          `--title=${title}`,
          `--description=${body}`,
          '--yes',
          ...(base ? [`--target-branch=${base}`] : []),
        ],
        summary: `open merge request "${preview(title)}"${base ? ` into ${base}` : ''}`,
      };
    },
  },
  mr_comment: {
    write: true,
    build(p) {
      const n = reference(p, 'number');
      const body = text(p, 'body', 8000)!;
      return {
        args: ['mr', 'note', ...(n ? [n] : []), `--message=${body}`],
        summary: `${label('comment on merge request', n)}: "${preview(body)}"`,
      };
    },
  },
  issue_create: {
    write: true,
    build(p) {
      const title = text(p, 'title', 200)!;
      const body = text(p, 'body', 8000, false) ?? '';
      return {
        args: ['issue', 'create', `--title=${title}`, `--description=${body}`, '--yes'],
        summary: `open issue "${preview(title)}"`,
      };
    },
  },
  issue_comment: {
    write: true,
    build(p) {
      const n = number(p, 'number', true);
      const body = text(p, 'body', 8000)!;
      return {
        args: ['issue', 'note', n!, `--message=${body}`],
        summary: `${label('comment on issue', n)}: "${preview(body)}"`,
      };
    },
  },
};

// ---------------------------------------------------------------- Docker

function containerName(params: Params): string {
  const value = String(params.container ?? '').trim();
  return NAME.test(value) ? value : fail('container must be a container name or id.');
}
/** Printed fields only: `docker inspect` as a whole carries the container's environment, which can hold secrets. */
const INSPECT_FORMAT =
  '{"image":{{json .Config.Image}},"command":{{json .Config.Cmd}},"state":{{json .State}},"ports":{{json .NetworkSettings.Ports}},"mounts":{{json .Mounts}}}';

export const DOCKER_ACTIONS: Readonly<Record<string, Action>> = {
  ps: {
    write: false,
    build: () => ({
      args: ['ps', '--all', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'],
      summary: 'list containers',
    }),
  },
  logs: {
    write: false,
    build(p) {
      const c = containerName(p);
      const tail = limit(p, 'tail', 200, 1000);
      return { args: ['logs', '--tail', tail, c], summary: `last ${tail} log lines of ${c}` };
    },
  },
  inspect: {
    write: false,
    build(p) {
      const c = containerName(p);
      return { args: ['inspect', '--format', INSPECT_FORMAT, c], summary: `inspect ${c}` };
    },
  },
  images: {
    write: false,
    build: () => ({
      args: ['images', '--format', '{{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.Size}}'],
      summary: 'list images',
    }),
  },
  compose_up: {
    write: true,
    build(p) {
      const services = Array.isArray(p.services)
        ? p.services
        : p.services === undefined
          ? []
          : fail('services must be a list of names.');
      if (services.length > 10) fail('services can name at most 10.');
      for (const service of services)
        if (typeof service !== 'string' || !NAME.test(service)) fail('services must be names.');
      return {
        args: ['compose', 'up', '-d', '--no-color', ...(services as string[])],
        summary: `compose up${services.length ? ' ' + services.join(' ') : ''}`,
      };
    },
  },
  compose_down: {
    write: true,
    // No -v: named volumes, which can hold data, stay.
    build: () => ({ args: ['compose', 'down'], summary: 'compose down (volumes stay)' }),
  },
  run: {
    write: true,
    build(p) {
      const image = String(p.image ?? '').trim();
      if (!IMAGE.test(image)) fail('image must be an image name such as node:22.');
      const command = p.command === undefined ? [] : p.command;
      if (!Array.isArray(command) || command.length > 20) fail('command must be a list of at most 20 words.');
      for (const word of command as unknown[]) {
        if (typeof word !== 'string' || word.length > 200 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(word))
          fail('command words must be short text.');
      }
      return {
        // No mounts, no extra privileges: the image and what it runs, then it is removed.
        args: ['run', '--rm', image, ...(command as string[])],
        summary: `run ${[image, ...(command as string[])].join(' ')}`,
      };
    },
  },
};

// ---------------------------------------------------------------- AWS

/** Services the agent may look at. Read operations only, and a few operations that return secrets are refused anyway. */
export const AWS_SERVICES: readonly string[] = [
  'acm',
  'apigateway',
  'apigatewayv2',
  'cloudformation',
  'cloudfront',
  'cloudwatch',
  'dynamodb',
  'ec2',
  'ecr',
  'ecs',
  'eks',
  'elbv2',
  'iam',
  'lambda',
  'logs',
  'rds',
  'route53',
  's3api',
  'sns',
  'sqs',
  'sts',
];
const AWS_OPERATION = /^(describe|list|get)-[a-z0-9]+(-[a-z0-9]+)*$/;
/** Operations that return credentials, secrets or file contents, though their names look like reads. */
const AWS_REFUSED = new Set([
  'ecr:get-login-password',
  'ecr:get-authorization-token',
  'lambda:get-function',
  'iam:get-credential-report',
  'dynamodb:get-item',
  'dynamodb:batch-get-item',
  's3api:get-object',
  's3api:get-object-torrent',
]);
const AWS_FLAG = /^[a-z][a-z0-9-]{0,40}$/;
/** Flags that would change where the request goes, whose credentials it uses, or what it reads from disk or reveals. */
const AWS_REFUSED_FLAGS = new Set([
  'profile',
  'region',
  'output',
  'endpoint-url',
  'no-verify-ssl',
  'ca-bundle',
  'debug',
  'cli-input-json',
  'cli-input-yaml',
  'generate-cli-skeleton',
  'cli-binary-format',
  'with-decryption',
  'include-values',
  'no-sign-request',
]);
const AWS_VALUE = /^[^\x00-\x1f\x7f]{1,512}$/;
const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function awsCall(params: Params, profile?: string): Call {
  const service = String(params.service ?? '').trim();
  const operation = String(params.operation ?? '').trim();
  if (!AWS_SERVICES.includes(service))
    fail(`AWS service ${service || '(none)'} is not available. Choose one of: ${AWS_SERVICES.join(', ')}.`);
  if (!AWS_OPERATION.test(operation)) fail('Only describe-, list- and get- operations are allowed.');
  if (AWS_REFUSED.has(`${service}:${operation}`))
    fail(`${service} ${operation} is not available: it can return secrets.`);
  if (service === 'sts' && operation !== 'get-caller-identity') fail('sts allows only get-caller-identity.');
  const extra: string[] = [];
  const flags = params.args === undefined ? {} : params.args;
  if (!flags || typeof flags !== 'object' || Array.isArray(flags))
    fail('args must be an object of flag names and values.');
  const entries = Object.entries(flags as Record<string, unknown>);
  if (entries.length > 12) fail('args can have at most 12 flags.');
  for (const [flag, value] of entries) {
    if (!AWS_FLAG.test(flag) || AWS_REFUSED_FLAGS.has(flag)) fail(`The flag --${flag} is not allowed.`);
    if (typeof value !== 'string' || !AWS_VALUE.test(value) || value.startsWith('-'))
      fail(`The value of --${flag} must be short text that does not start with a dash.`);
    // The AWS CLI reads a local file, or fetches an address, when a value starts like this.
    if (/^(file|fileb|https?):\/\//i.test(value.trim()))
      fail(`The value of --${flag} cannot read a file or an address.`);
    extra.push(`--${flag}`, value);
  }
  const region = params.region === undefined ? undefined : String(params.region).trim();
  if (region !== undefined && !AWS_REGION.test(region)) fail('region must be a region name such as us-east-1.');
  if (profile !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(profile))
    fail('The saved AWS profile name is not valid.');
  return {
    program: 'aws',
    args: [
      service,
      operation,
      ...extra,
      '--output',
      'json',
      '--no-cli-pager',
      ...(region ? ['--region', region] : []),
      ...(profile ? ['--profile', profile] : []),
    ],
    write: false,
    summary: `aws ${service} ${operation}${region ? ` in ${region}` : ''}`,
    timeoutMs: READ_MS,
  };
}

// ---------------------------------------------------------------- lookup

const PROGRAMS = { github: 'gh', gitlab: 'glab', docker: 'docker' } as const;
const TABLES = { github: GITHUB_ACTIONS, gitlab: GITLAB_ACTIONS, docker: DOCKER_ACTIONS } as const;

export type CliConnector = keyof typeof TABLES;
export const actionsOf = (connector: CliConnector): readonly string[] => Object.keys(TABLES[connector]);
export const writeActionsOf = (connector: CliConnector): readonly string[] =>
  Object.entries(TABLES[connector])
    .filter(([, action]) => action.write)
    .map(([name]) => name);
export const readActionsOf = (connector: CliConnector): readonly string[] =>
  Object.entries(TABLES[connector])
    .filter(([, action]) => !action.write)
    .map(([name]) => name);

/** The call for `action` of a command-line connector, or an ArgumentError saying what to fix. */
export function buildCall(connector: CliConnector, action: unknown, params: Params): Call {
  const spec =
    typeof action === 'string' && Object.hasOwn(TABLES[connector], action) ? TABLES[connector][action] : undefined;
  if (!spec)
    return fail(
      `${connector} has no action ${String(action).slice(0, 40)}. Choose one of: ${actionsOf(connector).join(', ')}.`,
    );
  const built = spec.build(params);
  return { program: PROGRAMS[connector], ...built, write: spec.write, timeoutMs: spec.write ? WRITE_MS : READ_MS };
}
