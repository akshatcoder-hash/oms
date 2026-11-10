// Stands in for `surfpool start` inside an OMS run: OMS's sandbox reaches exactly one host port (its "Surfpool" RPC), so this
// listens on that port and relays each JSON-RPC body to the run's solbench-harness env. It holds no key and starts no validator.
// usage (from the per-run wrapper): node surfpool-shim.mjs <env-url> start ... --port <rpc> ...
import { createServer } from 'node:http';

const [envUrl, ...args] = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (!envUrl || !Number.isInteger(port)) { console.error('usage: surfpool-shim.mjs <env-url> start --port <rpc>'); process.exit(2); }

createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const answer = await fetch(envUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(Buffer.from(await answer.arrayBuffer()));
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `env unreachable: ${error.message}` } }));
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`solbench-harness shim on 127.0.0.1:${port} -> env`));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => process.exit(0));
