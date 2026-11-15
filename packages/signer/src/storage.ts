import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import { SignerError } from './errors.ts';

export function privateDirectory(path: string): string {
  try {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    } catch {
      /* inspected below */
    }
    const stat = lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    return realpathSync(path);
  } catch {
    throw new SignerError('E_KEYPAIR_DIR_INSECURE', 'signer directory must be private, owned and not a symlink');
  }
}

export function readPrivateFile(path: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error();
    return readFileSync(fd, 'utf8');
  } catch {
    throw new SignerError('E_KEYPAIR', 'private signer issuance/key file missing or permissions invalid');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createPrivateFile(path: string, content: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new SignerError('E_KEYPAIR_EXISTS', 'signer alias already exists; never overwrite an issued key');
    throw new SignerError('E_KEYPAIR_WRITE', 'cannot create signer issuance/key file');
  }
  try {
    const bytes = Buffer.from(content);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } catch {
    throw new SignerError('E_KEYPAIR_WRITE', 'cannot persist signer issuance/key file');
  } finally {
    closeSync(fd);
  }
}

export function validateAlias(alias: unknown): asserts alias is string {
  if (typeof alias !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(alias))
    throw new SignerError('E_BAD_REQUEST', 'signer alias must be a lowercase name, not a path');
}
