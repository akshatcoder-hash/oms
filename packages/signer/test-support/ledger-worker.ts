import { readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { SpendLedger } from '../src/ledger.ts';

const [path, mode] = process.argv.slice(2);
if (!path) throw new Error('journal path required');
const wait = () => { readSync(0, Buffer.alloc(1), 0, 1, null); };
try {
  const ledger = new SpendLedger(6000, path, { hooks: { beforeLockRecovery: () => {
    if (mode === 'barrier') { process.stdout.write('recovering\n'); wait(); }
  } } });
  if (mode === 'seed') {
    const message = Buffer.from('synthetic unsigned message');
    ledger.reserve({ txDigest: createHash('sha256').update(message).digest('hex'), messageBase64: message.toString('base64'), profileId: 'a'.repeat(64), lamports: 6000, lifetime: { blockhash: 'synthetic', lastValidBlockHeight: 1000, validatedSlot: 100 } });
  }
  process.stdout.write(`ready:${ledger.spent()}\n`);
  wait();
  ledger.close();
} catch {
  process.stdout.write('denied\n');
  process.exitCode = 1;
}
