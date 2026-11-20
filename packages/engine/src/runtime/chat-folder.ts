import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { contains, privateDirectory } from '../workspace/storage.ts';
import { omsCommand } from './cli-command.ts';

/** The folder a chat works in, and the key its state is stored under. */
export interface ChatFolder {
  /** Where the agent works: the folder itself, or a scratch folder when the real one holds personal or system files. */
  readonly path: string;
  /** The folder oms was run in, resolved. */
  readonly requested: string;
  readonly key: string;
  readonly scratch: boolean;
  readonly git: boolean;
}

export interface ChatFolderOptions {
  stateRoot: string;
  /** Tests inject a home; production uses the real one. */
  home?: string;
  scratchRoot?: string;
}

export function scratchNotice(path: string): string {
  return `No project here, so this chat uses a scratch folder (${path}). cd into a project folder and run ${omsCommand()} to work on it.`;
}

const real = (path: string): string[] => {
  try {
    return [...new Set([path, realpathSync(path)])];
  } catch {
    return [path];
  }
};

/**
 * Whether a chat in this folder would expose credentials or OMS's own state: the folder is, holds or sits inside one
 * of them. Home and `/` count only when the folder holds them, since projects live below home.
 */
function holdsPersonalFiles(folder: string, home: string, stateRoot: string): boolean {
  const heldOnly = [...real(home), '/'];
  const secret = [
    ...real(stateRoot),
    ...real(join(home, '.oms')),
    ...['.ssh', '.aws', '.gnupg', '.config/solana', 'Library'].flatMap((name) => real(join(home, name))),
  ];
  return (
    heldOnly.some((path) => contains(folder, path)) ||
    secret.some((path) => contains(folder, path) || contains(path, folder))
  );
}

/**
 * Resolves the folder oms was run in. A folder that holds personal or system files is replaced by a private scratch
 * folder, so the chat still opens and never touches the real one.
 */
export function resolveChatFolder(input: string, options: ChatFolderOptions): ChatFolder {
  let requested: string;
  try {
    requested = realpathSync.native(input);
  } catch {
    throw new Error(`${input} is not a folder OMS can open`);
  }
  if (!statSync(requested).isDirectory()) throw new Error(`${requested} is not a folder`);
  const key = createHash('sha256').update(requested).digest('hex').slice(0, 40);
  if (!holdsPersonalFiles(requested, options.home ?? homedir(), options.stateRoot))
    return { path: requested, requested, key, scratch: false, git: existsSync(join(requested, '.git')) };
  const parent = join(options.scratchRoot ?? realpathSync.native(tmpdir()), 'oms-scratch');
  privateDirectory(parent);
  const path = join(parent, key);
  privateDirectory(path);
  return { path, requested, key, scratch: true, git: false };
}
