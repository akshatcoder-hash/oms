import { resolve } from 'node:path';
import { SignerError } from './errors.ts';
import { generateSignerKeypair } from './init.ts';
import { startSignerServer, type ServeOptions } from './server.ts';
import { readPrivateFile } from './storage.ts';
import { validateProfile } from './profile.ts';

async function main(): Promise<void> {
  try {
    const command = process.argv[2];
    if (command === 'init') {
      const [, , , signerDir, alias, profilePath] = process.argv;
      if (!signerDir || !alias || !profilePath)
        throw new SignerError('E_BAD_REQUEST', 'usage: cli.ts init <signerDir> <alias> <private-profile.json>');
      const profile = validateProfile(JSON.parse(readPrivateFile(resolve(profilePath))));
      const generated = generateSignerKeypair({ signerDir: resolve(signerDir), alias, profile });
      process.stdout.write(JSON.stringify({ status: 'ok', ...generated }) + '\n');
      return;
    }
    if (!command) throw new SignerError('E_BAD_REQUEST', 'usage: cli.ts <private-config.json>');
    const config = JSON.parse(readPrivateFile(resolve(command))) as ServeOptions;
    if (Object.keys(config).some((k) => !['signerDir', 'alias', 'socketDir', 'config'].includes(k)))
      throw new SignerError('E_BAD_REQUEST', 'unsupported or legacy CLI startup configuration');
    const running = await startSignerServer(config);
    process.stdout.write(
      JSON.stringify({
        status: 'ready',
        signerAddress: running.signerAddress,
        engineSocket: running.engineSocketPath,
        tuiSocket: running.tuiSocketPath,
        tokenFiles: running.tokenFiles,
      }) + '\n',
    );
    const shutdown = async () => {
      await running.close();
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
  } catch (error) {
    const code = error instanceof SignerError ? error.code : 'E_INTERNAL';
    const message = error instanceof SignerError ? error.message : 'signer operation failed (details suppressed)';
    process.stderr.write(JSON.stringify({ status: 'error', code, message }) + '\n');
    process.exitCode = 1;
  }
}
void main();
