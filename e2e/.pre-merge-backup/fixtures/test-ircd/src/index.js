'use strict';

/**
 * Minimal IRC daemon fixture for kubeclaw e2e tests.
 *
 * IRC port  6667 — implements the RFC-1459 subset that irc-upd requires:
 *   NICK, USER → 001 RPL_WELCOME (+ 376 ENDOFMOTD)
 *   JOIN       → 332 RPL_TOPIC, 353 RPL_NAMREPLY, 366 RPL_ENDOFNAMES
 *   PRIVMSG    → broadcast to all OTHER clients in that channel
 *   PING       → PONG
 *
 * HTTP port  8080 — test side-channel:
 *   POST /irc/inject  { channel, from, text } → injects a PRIVMSG into a channel
 *   GET  /irc/log     → returns all received PRIVMSGs (and JOINs) as JSON
 */

const net = require('node:net');
const http = require('node:http');

const IRC_PORT = Number(process.env.IRC_PORT) || 6667;
const HTTP_PORT = Number(process.env.HTTP_PORT) || 8080;
const SERVER_NAME = 'test-ircd.local';

// ── State ──────────────────────────────────────────────────────────────────

/** @type {Map<net.Socket, ClientState>} */
const clients = new Map();

/** @type {{ type: 'privmsg' | 'join', channel: string, from: string, text?: string, ts: number }[]} */
const eventLog = [];

/**
 * @typedef {{ socket: net.Socket, nick: string, user: string, registered: boolean, channels: Set<string>, buf: string }} ClientState
 */

/** @param {net.Socket} sock @returns {ClientState} */
function getClient(sock) {
  return clients.get(sock);
}

// ── IRC helpers ────────────────────────────────────────────────────────────

/**
 * Send a raw IRC line to a socket (appends \r\n).
 * @param {net.Socket} sock
 * @param {string} line
 */
function send(sock, line) {
  try {
    sock.write(line + '\r\n');
  } catch {
    // socket may have closed
  }
}

/**
 * Format a server numeric reply.
 * @param {string} target  recipient nick
 * @param {string} numeric  e.g. "001"
 * @param {string} text
 */
function numeric(target, numericCode, text) {
  return `:${SERVER_NAME} ${numericCode} ${target} ${text}`;
}

/**
 * Broadcast a line to all clients in a channel, optionally excluding one.
 * @param {string} channel
 * @param {string} line
 * @param {net.Socket|null} exclude
 */
function broadcastToChannel(channel, line, exclude) {
  for (const [sock, state] of clients) {
    if (sock !== exclude && state.registered && state.channels.has(channel)) {
      send(sock, line);
    }
  }
}

/** Returns a space-separated list of nicks in a channel. */
function channelNicks(channel) {
  const nicks = [];
  for (const state of clients.values()) {
    if (state.registered && state.channels.has(channel)) {
      nicks.push(state.nick);
    }
  }
  return nicks;
}

/** Complete registration for a client once both NICK and USER have been seen. */
function maybeRegister(sock) {
  const state = getClient(sock);
  if (state.registered || !state.nick || !state.user) return;
  state.registered = true;

  send(sock, numeric(state.nick, '001', `:Welcome to the test IRC Network, ${state.nick}!${state.user}@test`));
  send(sock, numeric(state.nick, '002', `:Your host is ${SERVER_NAME}, running kubeclaw-test-ircd`));
  send(sock, numeric(state.nick, '003', ':This server was created for testing'));
  send(sock, numeric(state.nick, '004', `${SERVER_NAME} kubeclaw-test-ircd o o`));
  // MOTD end (irc-upd listens for 376 or 422 to fire the 'registered' event)
  send(sock, numeric(state.nick, '375', ':- test-ircd MOTD -'));
  send(sock, numeric(state.nick, '372', ':- Welcome to the kubeclaw test IRC server -'));
  send(sock, numeric(state.nick, '376', ':End of MOTD command'));

  console.log(`[ircd] ${state.nick} registered`);
}

// ── IRC command handlers ───────────────────────────────────────────────────

/**
 * Parse and dispatch one complete IRC line for a client socket.
 * @param {net.Socket} sock
 * @param {string} line  (already stripped of \r\n)
 */
function handleLine(sock, line) {
  if (!line.trim()) return;
  const state = getClient(sock);
  if (!state) return;

  // Basic IRC line parse: [:prefix] COMMAND [params...] [:trailing]
  let rest = line;
  if (rest.startsWith(':')) {
    // strip origin prefix if client sends one (shouldn't, but be safe)
    rest = rest.slice(rest.indexOf(' ') + 1);
  }

  const trailingIdx = rest.indexOf(' :');
  let trailing = '';
  if (trailingIdx !== -1) {
    trailing = rest.slice(trailingIdx + 2);
    rest = rest.slice(0, trailingIdx);
  }
  const parts = rest.split(' ').filter(Boolean);
  if (parts.length === 0) return;

  const cmd = parts[0].toUpperCase();
  const params = parts.slice(1);
  if (trailing) params.push(trailing);

  console.log(`[ircd] ${state.nick || '<unreg>'} → ${cmd} ${params.join(' ')}`);

  switch (cmd) {
    case 'CAP':
      // Ignore capability negotiation; just send CAP NAK so the client moves on.
      if (params[0] === 'LS') {
        send(sock, `:${SERVER_NAME} CAP * LS :`);
      } else if (params[0] === 'REQ') {
        send(sock, `:${SERVER_NAME} CAP * NAK :${params[1] || ''}`);
      } else if (params[0] === 'END') {
        // nothing needed
      }
      break;

    case 'NICK': {
      const newNick = params[0];
      if (!newNick) { send(sock, numeric(state.nick || '*', '431', ':No nickname given')); break; }
      const oldNick = state.nick;
      state.nick = newNick;
      if (state.registered && oldNick && oldNick !== newNick) {
        // Notify channels of nick change
        for (const ch of state.channels) {
          broadcastToChannel(ch, `:${oldNick}!${state.user}@test NICK :${newNick}`, sock);
        }
        send(sock, `:${oldNick}!${state.user}@test NICK :${newNick}`);
      }
      maybeRegister(sock);
      break;
    }

    case 'USER':
      // USER <user> <mode> <unused> :<realname>
      state.user = params[0] || 'user';
      maybeRegister(sock);
      break;

    case 'PASS':
      // Accept any password silently
      break;

    case 'JOIN': {
      if (!state.registered) { send(sock, numeric('*', '451', ':You have not registered')); break; }
      const channels = params[0] ? params[0].split(',') : [];
      for (const rawCh of channels) {
        const ch = rawCh.toLowerCase();
        if (!ch.startsWith('#') && !ch.startsWith('&')) {
          send(sock, numeric(state.nick, '403', `${ch} :No such channel`));
          continue;
        }
        state.channels.add(ch);
        const prefix = `:${state.nick}!${state.user}@test`;
        // Announce JOIN to everyone in the channel (including the joiner)
        broadcastToChannel(ch, `${prefix} JOIN :${ch}`, null);
        send(sock, `${prefix} JOIN :${ch}`);

        // Topic (332) — send empty topic
        send(sock, numeric(state.nick, '332', `${ch} :test channel`));
        // Names list (353)
        const nicks = channelNicks(ch);
        send(sock, numeric(state.nick, '353', `= ${ch} :${nicks.join(' ')}`));
        send(sock, numeric(state.nick, '366', `${ch} :End of NAMES list`));

        eventLog.push({ type: 'join', channel: ch, from: state.nick, ts: Date.now() });
        console.log(`[ircd] ${state.nick} joined ${ch}`);
      }
      break;
    }

    case 'PART': {
      if (!state.registered) break;
      const channels = params[0] ? params[0].split(',') : [];
      for (const rawCh of channels) {
        const ch = rawCh.toLowerCase();
        state.channels.delete(ch);
        const prefix = `:${state.nick}!${state.user}@test`;
        broadcastToChannel(ch, `${prefix} PART :${ch}`, null);
        send(sock, `${prefix} PART :${ch}`);
      }
      break;
    }

    case 'PRIVMSG': {
      if (!state.registered) break;
      const target = params[0] ? params[0].toLowerCase() : '';
      const text = params[1] || '';
      const prefix = `:${state.nick}!${state.user}@test`;

      if (target.startsWith('#') || target.startsWith('&')) {
        broadcastToChannel(target, `${prefix} PRIVMSG ${target} :${text}`, sock);
        eventLog.push({ type: 'privmsg', channel: target, from: state.nick, text, ts: Date.now() });
        console.log(`[ircd] PRIVMSG ${target} <${state.nick}> ${text}`);
      } else {
        // Direct message — find target client
        for (const [, s] of clients) {
          if (s.nick && s.nick.toLowerCase() === target) {
            send(s.socket, `${prefix} PRIVMSG ${s.nick} :${text}`);
            break;
          }
        }
      }
      break;
    }

    case 'PING':
      send(sock, `:${SERVER_NAME} PONG ${SERVER_NAME} :${params[0] || SERVER_NAME}`);
      break;

    case 'PONG':
      // nothing
      break;

    case 'QUIT': {
      const reason = params[0] || 'Client quit';
      if (state.registered) {
        for (const ch of state.channels) {
          broadcastToChannel(ch, `:${state.nick}!${state.user}@test QUIT :${reason}`, sock);
        }
      }
      sock.end();
      break;
    }

    case 'WHOIS':
    case 'MODE':
    case 'WHO':
      // Silently ignore or send minimal reply
      if (state.registered && cmd === 'MODE') {
        const target = params[0];
        if (target === state.nick) {
          send(sock, numeric(state.nick, '221', '+i'));
        }
      }
      break;

    default:
      if (state.registered) {
        send(sock, numeric(state.nick, '421', `${cmd} :Unknown command`));
      }
      break;
  }
}

// ── IRC TCP server ─────────────────────────────────────────────────────────

const ircServer = net.createServer((sock) => {
  /** @type {ClientState} */
  const state = {
    socket: sock,
    nick: '',
    user: '',
    registered: false,
    channels: new Set(),
    buf: '',
  };
  clients.set(sock, state);
  console.log(`[ircd] client connected from ${sock.remoteAddress}`);

  sock.setEncoding('utf8');

  sock.on('data', (chunk) => {
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf('\n')) !== -1) {
      const line = state.buf.slice(0, nl).replace(/\r$/, '');
      state.buf = state.buf.slice(nl + 1);
      handleLine(sock, line);
    }
  });

  sock.on('close', () => {
    clients.delete(sock);
    console.log(`[ircd] client disconnected (nick=${state.nick || '<unreg>'})`);
  });

  sock.on('error', (err) => {
    console.error(`[ircd] socket error (nick=${state.nick || '<unreg>'}): ${err.message}`);
  });
});

ircServer.listen(IRC_PORT, '0.0.0.0', () => {
  console.log(`[ircd] IRC server listening on port ${IRC_PORT}`);
});

// ── HTTP side-channel server ───────────────────────────────────────────────

/**
 * Read the full body of an HTTP request as a string.
 * @param {http.IncomingMessage} req
 * @returns {Promise<string>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(chunks.join('')));
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // GET /irc/log — return all logged events
  if (req.method === 'GET' && url.pathname === '/irc/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events: eventLog }));
    return;
  }

  // POST /irc/inject — inject a PRIVMSG from a fictitious user into a channel
  if (req.method === 'POST' && url.pathname === '/irc/inject') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad JSON' }));
      return;
    }

    const { channel, from, text } = body;
    if (!channel || !from || text === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'channel, from, and text are required' }));
      return;
    }

    const ch = channel.toLowerCase();
    const line = `:${from}!injected@test PRIVMSG ${ch} :${text}`;
    let delivered = 0;
    for (const [, state] of clients) {
      if (state.registered && state.channels.has(ch)) {
        send(state.socket, line);
        delivered++;
      }
    }

    // Also record in the event log so /irc/log reflects injected messages
    eventLog.push({ type: 'privmsg', channel: ch, from, text, ts: Date.now(), injected: true });

    console.log(`[ircd] injected PRIVMSG into ${ch} from ${from}: "${text}" (delivered to ${delivered} client(s))`);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, delivered }));
    return;
  }

  // GET /health
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[ircd] HTTP side-channel listening on port ${HTTP_PORT}`);
});

process.on('SIGINT', () => { console.log('[ircd] shutting down'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[ircd] shutting down'); process.exit(0); });
