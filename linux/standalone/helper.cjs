const http = require('node:http');
const net = require('node:net');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function number(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    fail(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function waitFor(check, timeoutSeconds, description) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const attempt = () => {
    let settled = false;
    check((ready) => {
      if (settled) return;
      settled = true;
      if (ready) process.exit(0);
      if (Date.now() >= deadline) fail(`Timed out waiting for ${description}`);
      setTimeout(attempt, 500);
    });
  };
  attempt();
}

const [command, ...args] = process.argv.slice(2);

if (command === 'find-port') {
  const start = number(args[0], 'starting port');
  const attempts = Number(args[1] || 40);

  const tryPort = (port, remaining) => {
    if (port > 65535 || remaining < 1) fail(`No free port found from ${start}`);
    const server = net.createServer();
    server.unref();
    server.once('error', () => tryPort(port + 1, remaining - 1));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.close(() => {
        process.stdout.write(`${port}\n`);
      });
    });
  };

  tryPort(start, attempts);
} else if (command === 'tcp') {
  const host = args[0] || '127.0.0.1';
  const port = number(args[1], 'port');
  const timeout = Number(args[2] || 60);
  waitFor((done) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1500);
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(false));
  }, timeout, `${host}:${port}`);
} else if (command === 'http') {
  const url = args[0];
  const timeout = Number(args[1] || 120);
  if (!url) fail('A URL is required');
  waitFor((done) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      response.resume();
      done((response.statusCode || 500) < 500);
    });
    request.once('timeout', () => {
      request.destroy();
      done(false);
    });
    request.once('error', () => done(false));
  }, timeout, url);
} else {
  fail('Usage: helper.cjs find-port PORT [ATTEMPTS] | tcp HOST PORT [SECONDS] | http URL [SECONDS]');
}
