/**
 * Simple IRC Server for E2E Testing
 *
 * This creates a minimal IRC server that can be used to test
 * the IRC channel implementation without requiring external
 * IRC network connectivity.
 */
import { createServer, Server, Socket } from 'net';
import { EventEmitter } from 'events';

interface IRCClient {
  socket: Socket;
  nick: string | null;
  username: string | null;
  hostname: string;
  channels: Set<string>;
  registered: boolean;
}

interface IRCMessage {
  prefix: string | null;
  command: string;
  params: string[];
}

export class MockIRCServer extends EventEmitter {
  private server: Server | null = null;
  private clients: Map<Socket, IRCClient> = new Map();
  private port: number;
  private hostname: string;
  private serverName: string;
  private _channelMessages: Map<string, Array<{ nick: string; text: string }>> =
    new Map();

  constructor(port: number = 6667, hostname: string = 'localhost') {
    super();
    this.port = port;
    this.hostname = hostname;
    this.serverName = 'test.irc.local';
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => {
        console.log(
          `[IRC] Connection event: ${socket.remoteAddress} -> ${socket.localAddress}`,
        );
        this.handleConnection(socket);
      });

      this.server.on('error', (err) => {
        console.error(`[IRC] Server error: ${err.message}`);
        reject(err);
      });

      this.server.on('listening', () => {
        console.log(`[IRC] Server listening`);
      });

      this.server.on('connection', (socket) => {
        console.log(`[IRC] New connection`);
      });

      this.server.listen(this.port, this.hostname, () => {
        console.log(
          `🚀 Mock IRC Server started on ${this.hostname}:${this.port}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      // Disconnect all clients
      for (const [socket, client] of this.clients) {
        this.sendToClient(socket, 'ERROR', ['Closing Link']);
        socket.end();
      }
      this.clients.clear();

      if (this.server) {
        this.server.close(() => {
          console.log('🛑 Mock IRC Server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private handleConnection(socket: Socket): void {
    const client: IRCClient = {
      socket,
      nick: null,
      username: null,
      hostname: socket.remoteAddress || 'unknown',
      channels: new Set(),
      registered: false,
    };

    this.clients.set(socket, client);

    console.log(`[IRC] New connection from ${socket.remoteAddress}`);

    socket.on('data', (data) => {
      console.log(
        `[IRC] Raw data: ${data.toString().replace(/\r\n/g, '\\r\\n')}`,
      );
      const lines = data
        .toString()
        .split('\r\n')
        .filter((line) => line.trim());
      for (const line of lines) {
        this.handleMessage(client, line);
      }
    });

    socket.on('close', () => {
      this.handleDisconnect(client);
    });

    socket.on('error', (err) => {
      console.error('Client socket error:', err.message);
      this.handleDisconnect(client);
    });
  }

  private handleMessage(client: IRCClient, line: string): void {
    const message = this.parseMessage(line);
    if (!message) return;

    console.log(
      `📨 [IRC] ${client.nick || 'unregistered'}: ${message.command} ${message.params.join(' ')}`,
    );

    switch (message.command.toUpperCase()) {
      case 'NICK':
        this.handleNick(client, message.params[0]);
        break;
      case 'USER':
        this.handleUser(client, message.params);
        break;
      case 'JOIN':
        this.handleJoin(client, message.params[0]);
        break;
      case 'PART':
        this.handlePart(client, message.params[0]);
        break;
      case 'PRIVMSG':
        this.handlePrivmsg(client, message.params[0], message.params[1]);
        break;
      case 'PING':
        this.handlePing(client, message.params[0]);
        break;
      case 'QUIT':
        this.handleQuit(client, message.params[0]);
        break;
      case 'WHO':
        this.handleWho(client, message.params[0]);
        break;
      case 'MODE':
        // Minimal MODE implementation
        break;
    }
  }

  private parseMessage(line: string): IRCMessage | null {
    let prefix: string | null = null;
    let command: string;
    let params: string[] = [];

    let pos = 0;

    // Parse prefix
    if (line.startsWith(':')) {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) return null;
      prefix = line.slice(1, spaceIdx);
      pos = spaceIdx + 1;
    }

    // Skip leading spaces
    while (pos < line.length && line[pos] === ' ') pos++;

    // Parse command
    const spaceIdx = line.indexOf(' ', pos);
    if (spaceIdx === -1) {
      command = line.slice(pos);
    } else {
      command = line.slice(pos, spaceIdx);
      pos = spaceIdx + 1;

      // Parse params
      while (pos < line.length) {
        // Skip spaces
        while (pos < line.length && line[pos] === ' ') pos++;
        if (pos >= line.length) break;

        // Trailing parameter (starts with :)
        if (line[pos] === ':') {
          params.push(line.slice(pos + 1));
          break;
        }

        // Regular parameter
        const nextSpace = line.indexOf(' ', pos);
        if (nextSpace === -1) {
          params.push(line.slice(pos));
          break;
        } else {
          params.push(line.slice(pos, nextSpace));
          pos = nextSpace + 1;
        }
      }
    }

    return { prefix, command, params };
  }

  private handleNick(client: IRCClient, nick: string): void {
    const oldNick = client.nick;
    client.nick = nick;
    console.log(
      `[IRC] handleNick: nick=${nick}, oldNick=${oldNick}, username=${client.username}, registered=${client.registered}`,
    );

    if (oldNick && client.registered) {
      // Nick change
      this.broadcastToChannels(client, `NICK`, [], nick);
    } else if (client.username && !client.registered) {
      // Registration complete
      console.log(`[IRC] Completing registration from handleNick`);
      this.completeRegistration(client);
    }
  }

  private handleUser(client: IRCClient, params: string[]): void {
    if (params.length < 4) {
      this.sendNumeric(client, 461, ['USER', 'Not enough parameters']);
      return;
    }

    client.username = params[0];
    console.log(
      `[IRC] handleUser: username=${client.username}, nick=${client.nick}, registered=${client.registered}`,
    );

    if (client.nick && !client.registered) {
      console.log(`[IRC] Completing registration from handleUser`);
      this.completeRegistration(client);
    }
  }

  private completeRegistration(client: IRCClient): void {
    client.registered = true;

    // Send welcome numerics
    this.sendNumeric(client, 1, [
      `Welcome to the NanoClaw Test IRC Network ${client.nick}!${client.username}@${client.hostname}`,
    ]);
    this.sendNumeric(client, 2, [
      `Your host is ${this.serverName}, running version test-1.0`,
    ]);
    this.sendNumeric(client, 3, [`This server was created today`]);
    this.sendNumeric(client, 4, [this.serverName, 'test-1.0', 'ao', 'mtov']);

    // Send MOTD to trigger channel auto-join
    this.sendNumeric(client, 375, [
      `:- ${this.serverName} Message of the Day -`,
    ]);
    this.sendNumeric(client, 372, [
      `:- Welcome to the NanoClaw Test IRC Server`,
    ]);
    this.sendNumeric(client, 376, [`:End of /MOTD command`]);

    this.emit('registered', client.nick);
  }

  private handleJoin(client: IRCClient, channel: string): void {
    if (!client.registered || !channel) return;

    const channelLower = channel.toLowerCase();
    client.channels.add(channelLower);

    // Send JOIN to client
    this.sendToClient(
      client.socket,
      'JOIN',
      [channel],
      `${client.nick}!${client.username}@${client.hostname}`,
    );

    // Send topic (empty)
    this.sendNumeric(client, 331, [channel, 'No topic is set']);

    // Send names list
    const names = this.getChannelUsers(channelLower);
    this.sendNumeric(client, 353, ['=', channel, names.join(' ')]);
    this.sendNumeric(client, 366, [channel, 'End of /NAMES list']);

    // Notify other users in channel
    for (const [sock, otherClient] of this.clients) {
      if (sock !== client.socket && otherClient.channels.has(channelLower)) {
        this.sendToClient(
          sock,
          'JOIN',
          [channel],
          `${client.nick}!${client.username}@${client.hostname}`,
        );
      }
    }

    this.emit('join', client.nick, channel);
  }

  private handlePart(client: IRCClient, channel: string): void {
    if (!client.registered || !channel) return;

    const channelLower = channel.toLowerCase();
    client.channels.delete(channelLower);

    // Broadcast PART to channel
    this.broadcastToChannel(
      channelLower,
      `PART`,
      [channel],
      `${client.nick}!${client.username}@${client.hostname}`,
    );

    this.emit('part', client.nick, channel);
  }

  private handlePrivmsg(client: IRCClient, target: string, text: string): void {
    if (!client.registered || !target || !text) return;

    const targetLower = target.toLowerCase();

    if (targetLower.startsWith('#')) {
      // Record the message for test inspection
      if (!this._channelMessages.has(targetLower)) {
        this._channelMessages.set(targetLower, []);
      }
      this._channelMessages.get(targetLower)!.push({
        nick: client.nick || 'unknown',
        text,
      });

      // Channel message - broadcast to all users in channel except sender
      for (const [sock, otherClient] of this.clients) {
        if (sock !== client.socket && otherClient.channels.has(targetLower)) {
          this.sendToClient(
            sock,
            'PRIVMSG',
            [target, text],
            `${client.nick}!${client.username}@${client.hostname}`,
          );
        }
      }
      this.emit('message', client.nick, target, text);
    } else {
      // Private message
      for (const [sock, otherClient] of this.clients) {
        if (otherClient.nick?.toLowerCase() === targetLower) {
          this.sendToClient(
            sock,
            'PRIVMSG',
            [target, text],
            `${client.nick}!${client.username}@${client.hostname}`,
          );
          break;
        }
      }
    }
  }

  private handlePing(client: IRCClient, token: string): void {
    this.sendToClient(client.socket, 'PONG', [
      this.serverName,
      token || this.serverName,
    ]);
  }

  private handleQuit(client: IRCClient, reason: string): void {
    // Broadcast QUIT to all channels
    for (const channel of client.channels) {
      for (const [sock, otherClient] of this.clients) {
        if (sock !== client.socket && otherClient.channels.has(channel)) {
          this.sendToClient(
            sock,
            'QUIT',
            [reason || 'Client Quit'],
            `${client.nick}!${client.username}@${client.hostname}`,
          );
        }
      }
    }

    client.socket.end();
    this.handleDisconnect(client);
  }

  private handleWho(client: IRCClient, target: string): void {
    if (target.startsWith('#')) {
      const channelLower = target.toLowerCase();
      for (const [, otherClient] of this.clients) {
        if (otherClient.channels.has(channelLower) && otherClient.nick) {
          this.sendNumeric(client, 352, [
            target,
            otherClient.username || '~user',
            otherClient.hostname,
            this.serverName,
            otherClient.nick,
            'H',
            '0',
            otherClient.nick,
          ]);
        }
      }
    }
    this.sendNumeric(client, 315, [target, 'End of /WHO list']);
  }

  private handleDisconnect(client: IRCClient): void {
    // Remove from channels
    for (const channel of client.channels) {
      for (const [sock, otherClient] of this.clients) {
        if (sock !== client.socket && otherClient.channels.has(channel)) {
          this.sendToClient(
            sock,
            'PART',
            [channel],
            `${client.nick}!${client.username}@${client.hostname}`,
          );
        }
      }
    }

    this.clients.delete(client.socket);
    this.emit('disconnect', client.nick);
  }

  private broadcastToChannels(
    client: IRCClient,
    command: string,
    params: string[],
    prefix?: string,
  ): void {
    const seen = new Set<Socket>();
    for (const channel of client.channels) {
      for (const [sock, otherClient] of this.clients) {
        if (
          sock !== client.socket &&
          otherClient.channels.has(channel) &&
          !seen.has(sock)
        ) {
          this.sendToClient(sock, command, params, prefix);
          seen.add(sock);
        }
      }
    }
  }

  private broadcastToChannel(
    channel: string,
    command: string,
    params: string[],
    prefix?: string,
  ): void {
    for (const [sock, client] of this.clients) {
      if (client.channels.has(channel)) {
        this.sendToClient(sock, command, params, prefix);
      }
    }
  }

  private sendToClient(
    socket: Socket,
    command: string,
    params: string[],
    prefix?: string,
  ): void {
    let line: string;
    if (prefix) {
      line = `:${prefix} ${command}`;
    } else {
      line = `:${this.serverName} ${command}`;
    }

    for (let i = 0; i < params.length; i++) {
      if (
        i === params.length - 1 &&
        (params[i].includes(' ') || params[i].startsWith(':'))
      ) {
        line += ` :${params[i]}`;
      } else {
        line += ` ${params[i]}`;
      }
    }

    line += '\r\n';
    console.log(`[IRC] Sending to client: ${line.replace(/\r\n$/, '')}`);
    const success = socket.write(line);
    if (!success) {
      console.log(`[IRC] Warning: socket.write returned false, draining`);
      socket.once('drain', () => {
        console.log(`[IRC] Socket drained`);
      });
    }
  }

  private sendNumeric(
    client: IRCClient,
    numeric: number,
    params: string[],
  ): void {
    const nick = client.nick || '*';
    const numericStr = numeric.toString().padStart(3, '0');
    this.sendToClient(client.socket, numericStr, [nick, ...params]);
  }

  // Public methods for test control

  getConnectedClients(): string[] {
    const nicks: string[] = [];
    for (const [, client] of this.clients) {
      if (client.nick) {
        nicks.push(client.nick);
      }
    }
    return nicks;
  }

  getChannels(): string[] {
    const channels = new Set<string>();
    for (const [, client] of this.clients) {
      for (const channel of client.channels) {
        channels.add(channel);
      }
    }
    console.log(
      `[IRC] getChannels() called, returning: ${Array.from(channels)}`,
    );
    return Array.from(channels);
  }

  getChannelMessages(channel: string): Array<{ nick: string; text: string }> {
    return this._channelMessages.get(channel.toLowerCase()) ?? [];
  }

  clearMessages(): void {
    this._channelMessages.clear();
  }

  getChannelUsers(channel: string): string[] {
    const users: string[] = [];
    const channelLower = channel.toLowerCase();
    for (const [, client] of this.clients) {
      if (client.channels.has(channelLower) && client.nick) {
        users.push(client.nick);
      }
    }
    return users;
  }

  simulateMessage(nick: string, channel: string, text: string): void {
    const channelLower = channel.toLowerCase();
    for (const [sock, client] of this.clients) {
      if (client.channels.has(channelLower)) {
        this.sendToClient(
          sock,
          'PRIVMSG',
          [channel, text],
          `${nick}!user@localhost`,
        );
      }
    }
    this.emit('message', nick, channel, text);
  }

  getPort(): number {
    return this.port;
  }

  getHost(): string {
    return this.hostname;
  }
}

let serverInstance: MockIRCServer | null = null;

export async function startIRCServer(port?: number): Promise<MockIRCServer> {
  if (serverInstance) {
    return serverInstance;
  }

  // Find an available port if not specified
  const serverPort = port || 16667;
  serverInstance = new MockIRCServer(serverPort);
  await serverInstance.start();
  return serverInstance;
}

export async function stopIRCServer(): Promise<void> {
  if (serverInstance) {
    await serverInstance.stop();
    serverInstance = null;
  }
}

export function getIRCServer(): MockIRCServer | null {
  return serverInstance;
}
