#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { incompleteInstallMessage } from './install-integrity.ts';

// Loaded dynamically so a file missing from the installed package is reported, not thrown as a loader stack.
try {
  await import('./main.ts');
} catch (error) {
  const message = incompleteInstallMessage(error, fileURLToPath(new URL('../../../', import.meta.url)));
  if (!message) throw error;
  console.error(message);
  process.exitCode = 1;
}
