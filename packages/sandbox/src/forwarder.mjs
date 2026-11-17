// Forwarder script. Mounted read-only into the caller's approved Node image and run as
// uid 1000 with caps dropped. Two modes:
//
//   FWD_MODE=proxy    Allowlisting HTTP proxy (absolute-form GET + CONNECT).
//                     The install phase points npm/HTTPS_PROXY at it. The
//                     allowlist is exact host:port pairs in FWD_ALLOW; anything
//                     else is refused with 403 before any upstream connection.
//   FWD_MODE=forward  Single-port TCP forwarder. Exposes ONLY
//                     FWD_LISTEN_PORT and relays it to
//                     FWD_TARGET_HOST:FWD_TARGET_PORT (the task's surfnet RPC).
//                     Every other port is a refused connection because nothing
//                     is listening on it.
//
// With FWD_HOST_RELAY set, host.docker.internal:<port> targets go to the
// trusted host relay socket FWD_HOST_RELAY/<port>.sock instead of the network.
//
// Emits "forwarder ready" on stdout when listening; the host side polls for it.

import http from 'node:http';
import net from 'node:net';

const ALLOW = new Set(
  (process.env.FWD_ALLOW ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

function splitHostPort(hostPort) {
  // host:port where host may be a name or IPv4; IPv6 literals are not needed
  // for registry hosts and are not supported by the allowlist.
  const i = hostPort.lastIndexOf(':');
  if (i === -1) return null;
  return { host: hostPort.slice(0, i), port: Number(hostPort.slice(i + 1)) };
}

const RELAY = process.env.FWD_HOST_RELAY;

function relaySocket(host, port) {
  return RELAY && host.toLowerCase() === 'host.docker.internal' ? `${RELAY}/${port}.sock` : undefined;
}

function connectTarget(host, port, onConnect) {
  const socketPath = relaySocket(host, port);
  return socketPath ? net.connect(socketPath, onConnect) : net.connect(port, host, onConnect);
}

function deny(res) {
  res.writeHead(403, { 'content-type': 'text/plain' });
  res.end('forbidden by oms install proxy\n');
}

function startProxy() {
  const server = http.createServer((req, res) => {
    // Absolute-form request (http_proxy semantics): req.url is a full URL.
    let url;
    try {
      url = new URL(req.url ?? '');
    } catch {
      deny(res);
      return;
    }
    const hostPort = `${url.hostname}:${url.port || 80}`.toLowerCase();
    if (!ALLOW.has(hostPort)) {
      deny(res);
      return;
    }
    const target = splitHostPort(hostPort);
    if (!target || !Number.isInteger(target.port)) {
      deny(res);
      return;
    }
    const headers = { ...req.headers, host: url.host };
    delete headers['proxy-connection'];
    const socketPath = relaySocket(target.host, target.port);
    const upstream = http.request(
      {
        ...(socketPath ? { socketPath } : { host: target.host, port: target.port }),
        method: req.method,
        path: url.pathname + url.search,
        headers,
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream error\n');
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSock, head) => {
    const hostPort = (req.url ?? '').toLowerCase();
    const target = splitHostPort(hostPort);
    if (!ALLOW.has(hostPort) || !target || !Number.isInteger(target.port)) {
      clientSock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connectTarget(target.host, target.port, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSock);
      clientSock.pipe(upstream);
    });
    upstream.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstream.destroy());
  });

  server.listen(3128, '0.0.0.0', () => console.log('forwarder ready (proxy)'));
}

function startForward() {
  const listenPort = Number(process.env.FWD_LISTEN_PORT);
  const targetHost = process.env.FWD_TARGET_HOST ?? '';
  const targetPort = Number(process.env.FWD_TARGET_PORT);
  if (!Number.isInteger(listenPort) || !targetHost || !Number.isInteger(targetPort)) {
    throw new Error('FWD_LISTEN_PORT, FWD_TARGET_HOST and FWD_TARGET_PORT are required');
  }
  const server = net.createServer((clientSock) => {
    const upstream = connectTarget(targetHost, targetPort, () => {
      clientSock.pipe(upstream);
      upstream.pipe(clientSock);
    });
    upstream.on('error', () => clientSock.destroy());
    clientSock.on('error', () => upstream.destroy());
  });
  server.listen(listenPort, '0.0.0.0', () => console.log('forwarder ready (tcp)'));
}

if (process.env.FWD_MODE === 'proxy') {
  startProxy();
} else if (process.env.FWD_MODE === 'forward') {
  startForward();
} else {
  throw new Error('FWD_MODE must be "proxy" or "forward"');
}
