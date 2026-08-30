const http = require('node:http');
const net = require('node:net');

function parsePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

const listenHost = process.env.MVBAR_PROXY_HOST || '127.0.0.1';
const listenPort = parsePort(process.env.MVBAR_PROXY_PORT, 8080);
const apiPort = parsePort(process.env.MVBAR_API_PORT, 53001);
const webPort = parsePort(process.env.MVBAR_WEB_PORT, 53000);

function targetPortFor(url = '/') {
  const pathname = url.split('?', 1)[0];
  if (/^\/api\/hls\/[^/]+\/(request|status|index\.m3u8|seg_[0-9]+\.ts)$/.test(pathname)) {
    return apiPort;
  }
  if (
    pathname.startsWith('/api/hls/') ||
    pathname.startsWith('/api/stream/') ||
    pathname.startsWith('/api/audiobook-stream/') ||
    pathname.startsWith('/api/art/') ||
    pathname.startsWith('/api/lyrics/')
  ) {
    return webPort;
  }
  if (pathname === '/health' || pathname.startsWith('/api/') || pathname.startsWith('/rest/')) {
    return apiPort;
  }
  return webPort;
}

function forwardedHeaders(req) {
  const headers = { ...req.headers };
  const remoteAddress = req.socket.remoteAddress || '';
  headers['x-forwarded-for'] = headers['x-forwarded-for']
    ? `${headers['x-forwarded-for']}, ${remoteAddress}`
    : remoteAddress;
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = headers.host || '';
  return headers;
}

const server = http.createServer((req, res) => {
  const proxy = http.request(
    {
      host: '127.0.0.1',
      port: targetPortFor(req.url),
      method: req.method,
      path: req.url,
      headers: forwardedHeaders(req),
    },
    (upstream) => {
      res.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(res);
    }
  );

  proxy.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ ok: false, error: 'upstream_unavailable', detail: error.message }));
  });

  req.on('aborted', () => proxy.destroy());
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(apiPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`X-Forwarded-For: ${req.socket.remoteAddress || ''}`);
    lines.push('X-Forwarded-Proto: http');
    lines.push('', '');
    upstream.write(lines.join('\r\n'));
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });

  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(listenPort, listenHost, () => {
  process.stdout.write(
    `MVBar proxy listening on http://${listenHost}:${listenPort} ` +
    `(web=${webPort}, api=${apiPort})\n`
  );
});
