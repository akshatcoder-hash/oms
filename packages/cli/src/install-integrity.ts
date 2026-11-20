import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * When `error` is Node failing to load a file that ships inside this installation, explain how to repair it.
 * Returns undefined for every other error, so the caller can rethrow it unchanged.
 */
export function incompleteInstallMessage(error: unknown, installRoot: string): string | undefined {
  if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') return undefined;
  const url = (error as { url?: unknown }).url;
  if (typeof url !== 'string' || !url.startsWith('file:')) return undefined;
  // Node reports resolved paths, so compare against the resolved root (macOS temp dirs sit behind /var -> /private/var).
  const missing = relative(resolvedPath(installRoot), fileURLToPath(url));
  if (!missing || missing.startsWith('..') || isAbsolute(missing)) return undefined;
  const release = publishedRelease(installRoot);
  const repair = release
    ? `Reinstall it: npm install -g ${release}`
    : 'Reinstall the dependencies: npm ci --ignore-scripts';
  return `oms: this installation is incomplete; ${missing} is missing.\n${repair}`;
}

function publishedRelease(installRoot: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8'));
    return manifest.name === '@barestate/oms' && typeof manifest.version === 'string'
      ? `${manifest.name}@${manifest.version}`
      : undefined;
  } catch {
    return undefined;
  }
}

function resolvedPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
