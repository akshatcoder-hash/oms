/** Real MCP transport: the native CLI waits here while OMS executes its ordinary
 * guarded Pi call, then receives the exact result (including policy denials).
 * This endpoint never executes a tool or invents an execution placeholder. */
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

const [path, socketPath] = process.argv.slice(2);
if (!path || !socketPath) process.exit(1);
const tools = JSON.parse(readFileSync(path, 'utf8')) as unknown[];
// Publish this exact native child to OMS's existing durable process tracker,
// so stale-owner recovery accounts for the entire native/MCP process tree.
await new Promise<void>((resolve, reject) => {
  const socket = createConnection(socketPath); let reply = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'register', pid: process.pid, parentPid: process.ppid }) + '\n'));
  socket.on('data', part => { reply += part; });
  socket.on('error', reject);
  socket.on('end', () => {
    try { if (JSON.parse(reply).registered !== true) throw new Error('Unregistered MCP process'); resolve(); }
    catch { reject(new Error('OMS MCP process registration failed')); }
  });
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (id: string | number, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
input.on('line', line => {
  if (line.length > 1_048_576) { input.close(); process.exitCode = 1; return; }
  try {
    const request = JSON.parse(line) as { id?: string | number; method?: string; params?: unknown };
    if (request.id === undefined) return;
    if (request.method === 'tools/call') {
      const socket = createConnection(socketPath); let response = '';
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify(request.params) + '\n'));
      socket.on('data', part => {
        response += part;
        if (response.length > 8_388_608) socket.destroy(new Error('Oversized OMS result'));
      });
      socket.on('end', () => {
        try { send(request.id!, JSON.parse(response)); }
        catch { process.exitCode = 1; input.close(); }
      });
      socket.on('error', () => {
        // A disconnected owner has UNKNOWN execution state, never a fake result.
        process.exitCode = 1; input.close(); process.stdin.destroy();
      });
      return;
    }
    send(request.id, request.method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'oms', version: '2' } }
      : request.method === 'tools/list' ? { tools } : {});
  } catch { input.close(); process.exitCode = 1; }
});
