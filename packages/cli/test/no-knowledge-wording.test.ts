import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url).pathname;
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

// Anything that says the reference service is on, off, enabled, disabled or (not) configured, or tells the user to switch it.
const WORDING =
  /knowledge[^\n]{0,60}\b(enabled?|disabled?|configured|turned on|turn on|turn off|on|off)\b|\b(enable|disable|turn on|turn off)[^\n]{0,40}knowledge|--knowledge\b|only help when the model calls/i;

test('no user-facing text says the Solana reference service is enabled, disabled or configured', () => {
  const files = [
    join(root, 'README.md'),
    ...walk(join(root, 'packages/cli/src/tui')),
    ...walk(join(root, 'packages/cli/src')).filter((file) => /doctor/.test(file)),
  ];
  const hits = files.flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line, index) => ({ file, line, index }))
      .filter(({ line }) => WORDING.test(line))
      .map(({ file: f, index, line }) => `${f.slice(root.length)}:${index + 1}: ${line.trim()}`),
  );
  assert.deepEqual(hits, []);
});
