/**
 * Unix-domain-socket front end for the signer service.
 *
 * Both authenticated channels expose development signing and trusted RPC
 * reconciliation only. Neither accepts confirmation or claimed outcomes.
 * Tokens and sockets are private host artifacts, not peer-process identity.
 *
 * HONEST LIMITATION: Node exposes no SO_PEERCRED / LOCAL_PEERCRED, so the
 * signer cannot ask the kernel which PID/UID connected. Caller identity is
 * therefore "whoever can open the socket and read the matching token file",
 * which on a single-user machine means "any process running as this user".
 * See README "Peer identity".
 */

import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { basename, join } from 'node:path';
import { SignerError, toPublicError } from './errors.ts';
import { PROTOCOL_VERSION } from './constants.ts';
import { loadIssuedKeypair } from './keypair.ts';
import { createLogger, createTrace, type Logger, type Trace } from './output.ts';
import { SpendLedger, type SpendLedgerHooks } from './ledger.ts';
import { validatePolicyConfig, type PolicyConfig } from './policy.ts';
import { ProfileRpc } from './profile.ts';
import { privateDirectory } from './storage.ts';
import { safeJson } from './secret.ts';
import { ServerArtifacts } from './server-artifacts.ts';
import { createSignerService, type Channel, type ServiceOptions, type SignerService } from './service.ts';

export interface ServeOptions {
  config: PolicyConfig;
  /** Trusted host-owned issuance store, never a repository or agent-writable path. */
  signerDir: string;
  alias: string;
  socketDir: string;
  ledgerHooks?: SpendLedgerHooks;
  logPath?: string;
  tracePath?: string;
  /** Deterministic tokens for tests. Production should let the signer generate them. */
  tokens?: { engine?: string; tui?: string };
  /** Mirror log lines to this sink as well (the CLI uses stdout). */
  alsoWrite?: (line: string) => void;
  testHooks?: ServiceOptions['testHooks'];
  /** Host-only startup barrier/fault injection; never accepted by the CLI. */
  startupHooks?: { afterChannelListen?: (channel: Channel, path: string) => void | Promise<void> };
}

export interface RunningSigner {
  engineSocketPath: string;
  tuiSocketPath: string;
  socketDir: string;
  engineToken: string;
  tuiToken: string;
  tokenFiles: { engine: string; tui: string };
  logPath: string | null;
  tracePath: string | null;
  journalPath: string;
  signerAddress: string;
  service: SignerService;
  ledger: SpendLedger;
  logger: Logger;
  trace: Trace;
  close(): Promise<void>;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function tokensMatch(provided: string, expected: string): boolean {
  const a = hashToken(provided);
  const b = hashToken(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startSignerServer(options: ServeOptions): Promise<RunningSigner> {
  if (
    Object.keys(options).some(
      (k) =>
        ![
          'config',
          'signerDir',
          'alias',
          'socketDir',
          'ledgerHooks',
          'logPath',
          'tracePath',
          'tokens',
          'alsoWrite',
          'testHooks',
          'startupHooks',
        ].includes(k),
    )
  )
    throw new SignerError('E_BAD_REQUEST', 'unsupported or legacy signer startup option');
  validatePolicyConfig(options.config);
  const keypair = loadIssuedKeypair({ signerDir: options.signerDir, alias: options.alias });
  const rpc = new ProfileRpc(keypair.profile);
  await rpc.assertIdentity();
  const socketDir = privateDirectory(options.socketDir);

  const logPath = options.logPath ?? join(socketDir, 'signer.log');
  const tracePath = options.tracePath ?? join(socketDir, 'trace.jsonl');

  const logger = createLogger({ secret: keypair.secret, filePath: logPath, alsoWrite: options.alsoWrite });
  const trace = createTrace({ secret: keypair.secret, filePath: tracePath });
  const journalPath = join(privateDirectory(options.signerDir), `${options.alias}.spend.journal`);
  const ledger = new SpendLedger(options.config.spend.cumulativeLamports, journalPath, {
    ...(options.ledgerHooks ? { hooks: options.ledgerHooks } : {}),
  });
  const servers: Server[] = [];
  const openSockets = new Set<Socket>();
  let artifacts: ServerArtifacts | undefined;
  let active = false;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closing) return closing;
    active = false;
    closing = (async () => {
      try {
        for (const socket of openSockets) socket.destroy();
        openSockets.clear();
        await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
      } finally {
        try {
          artifacts?.close();
        } finally {
          ledger.close();
        }
      }
    })();
    return closing;
  }

  try {
    artifacts = new ServerArtifacts(socketDir);

    const service = createSignerService({
      config: options.config,
      keypair,
      ledger,
      logger,
      trace,
      // Profile and key provenance come exclusively from the issuance store.
      ...(options.testHooks ? { testHooks: options.testHooks } : {}),
    });

    const engineToken = options.tokens?.engine ?? randomBytes(32).toString('hex');
    const tuiToken = options.tokens?.tui ?? randomBytes(32).toString('hex');

    const tokenFiles = {
      engine: join(socketDir, 'engine.token'),
      tui: join(socketDir, 'tui.token'),
    };
    for (const [channel, token] of [
      ['engine', engineToken],
      ['tui', tuiToken],
    ] as const) {
      const file = tokenFiles[channel];
      const fd = openSync(file, 'wx', 0o600);
      try {
        artifacts.track(basename(file));
        writeFileSync(fd, token + '\n');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }

    const expectedTokens: Record<Channel, string> = { engine: engineToken, tui: tuiToken };

    const engineSocketPath = join(socketDir, 'engine.sock');
    const tuiSocketPath = join(socketDir, 'tui.sock');

    async function createChannelServer(channel: Channel, socketPath: string): Promise<Server> {
      // The listener owns only its unique path. Its public hardlink can be
      // removed conditionally without net.Server.close unlinking a replacement.
      const privateSocketPath = join(socketDir, `.${channel[0]}-${artifacts!.token.slice(0, 8)}`);
      const server = createServer((socket: Socket) => {
        if (!active) {
          socket.destroy();
          return;
        }
        openSockets.add(socket);
        socket.on('close', () => openSockets.delete(socket));
        socket.on('error', () => openSockets.delete(socket));

        let authenticated = false;
        let buffer = '';
        let queue: Promise<void> = Promise.resolve();

        const writeLine = (line: string): void => {
          if (socket.destroyed) return;
          socket.write(line + '\n');
        };

        const deny = (code: string, message: string): void => {
          writeLine(safeJson({ v: PROTOCOL_VERSION, status: 'error', code, message }, keypair.secret));
          logger.log('warn', 'channel_auth_failed', { channel, code });
          socket.end();
        };

        const processLine = async (raw: string): Promise<void> => {
          if (!active) return;
          if (raw.trim().length === 0) return;

          if (!authenticated) {
            let hello: Record<string, unknown>;
            try {
              const parsed = JSON.parse(raw) as unknown;
              if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                deny('E_AUTH', 'first message must be a hello with a valid token');
                return;
              }
              hello = parsed as Record<string, unknown>;
            } catch {
              deny('E_AUTH', 'first message must be a hello with a valid token');
              return;
            }
            if (hello.type !== 'hello' || typeof hello.token !== 'string') {
              deny('E_AUTH', 'first message must be a hello with a valid token');
              return;
            }
            if (!tokensMatch(hello.token, expectedTokens[channel])) {
              deny('E_AUTH', 'channel token rejected');
              return;
            }
            authenticated = true;
            const helloResult = await service.handle(channel, JSON.stringify({ type: 'hello' }));
            writeLine(helloResult.line);
            return;
          }

          const result = await service.handle(channel, raw);
          writeLine(result.line);
        };

        socket.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let index = buffer.indexOf('\n');
          while (index !== -1) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            queue = queue
              .then(() => processLine(line))
              .catch((error: unknown) => {
                const publicError = toPublicError(error, keypair.secret.scrub);
                writeLine(
                  safeJson(
                    { v: PROTOCOL_VERSION, status: 'error', code: publicError.code, message: publicError.message },
                    keypair.secret,
                  ),
                );
              });
            index = buffer.indexOf('\n');
          }
        });

        socket.on('end', () => {
          if (buffer.trim().length > 0) {
            queue = queue.then(() => processLine(buffer)).catch(() => undefined);
          }
        });
      });

      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(privateSocketPath, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      artifacts!.track(basename(privateSocketPath));
      chmodSync(privateSocketPath, 0o600);
      linkSync(privateSocketPath, socketPath);
      artifacts!.track(basename(socketPath));
      await options.startupHooks?.afterChannelListen?.(channel, socketPath);
      return server;
    }

    await createChannelServer('engine', engineSocketPath);
    await createChannelServer('tui', tuiSocketPath);

    logger.log('info', 'signer_started', {
      signerAddress: keypair.address,
      profileId: keypair.profileId,
      engineSocketPath,
      tuiSocketPath,
    });

    active = true;
    return {
      engineSocketPath,
      tuiSocketPath,
      socketDir,
      engineToken,
      tuiToken,
      tokenFiles,
      logPath,
      tracePath,
      journalPath,
      signerAddress: keypair.address,
      service,
      ledger,
      logger,
      trace,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
