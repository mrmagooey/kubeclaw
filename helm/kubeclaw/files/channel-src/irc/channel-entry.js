/* eslint-disable */
import IRC from 'irc-upd';

class IRCChannel {
  name = 'irc';
  capabilities = {};

  constructor(config, opts, sdk) {
    this.config = config;
    this.opts = opts;
    this.sdk = sdk;
    this.client = null;
    this.messageId = 0;
  }

  parseJid(channel) {
    return `irc:${channel.toLowerCase()}@${this.config.server}:${this.config.port}`;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      console.log(
        `[IRC Client] Attempting to connect to ${this.config.server}:${this.config.port}`,
      );

      this.client = new IRC.Client(
        this.config.server,
        this.config.nick,
        {
          port: this.config.port,
          channels: this.config.channels,
          auto_reconnect: true,
          auto_reconnect_wait: 4000,
          auto_reconnect_max_retries: 10,
          secure: this.config.port === 6697 || this.config.port === 9999,
          selfSigned: false,
          certExpired: false,
          floodProtection: true,
          floodProtectionDelay: 500,
          stripColors: false,
          channelPrefixes: '&#',
          messageMaxLength: 480,
        },
      );

      this.client.on('registered', (msg) => {
        console.log(`[IRC Client] Registered event received!`, msg);
        this.sdk.logger.info(
          { nick: this.config.nick, server: this.config.server },
          'IRC bot connected',
        );
        console.log(`\n  IRC bot: ${this.config.nick}@${this.config.server}`);
        console.log(`  Joined channels: ${this.config.channels.join(', ')}\n`);

        // Manually join channels if auto-join doesn't work (for E2E tests)
        // Join immediately without delay
        for (const channel of this.config.channels) {
          console.log(`[IRC Client] Joining channel: ${channel}`);
          this.client.join(channel);
        }

        resolve();
      });

      this.client.on('motd', (motd) => {
        console.log(
          `[IRC Client] MOTD received, will join channels: ${this.config.channels.join(', ')}`,
        );
      });

      this.client.on('join', (channel, nick) => {
        console.log(`[IRC Client] Joined channel: ${channel} as ${nick}`);
      });

      this.client.on('error', (err) => {
        console.log(`[IRC Client] Error: ${JSON.stringify(err)}`);
        this.sdk.logger.error({ err }, 'IRC client error');
      });

      this.client.on('connect', () => {
        console.log(`[IRC Client] TCP connection established`);
      });

      this.client.on('netConnect', () => {
        console.log(`[IRC Client] Net connect event`);
      });

      this.client.on('raw', (msg) => {
        console.log(
          `[IRC Client] Raw message: ${msg.command} ${msg.args?.join(' ')}`,
        );
      });

      this.client.on(
        'message',
        (nick, target, text, message) => {
          this.handleMessage(nick, target, text, message);
        },
      );

      this.client.on('join', (channel, nick) => {
        if (nick === this.config.nick) {
          const jid = this.parseJid(channel);
          const timestamp = new Date().toISOString();
          this.opts.onChatMetadata(jid, timestamp, channel, 'irc', true);
        }
      });

      this.client.on('quit', (nick, reason) => {
        this.sdk.logger.debug({ nick, reason }, 'User quit IRC');
      });

      this.client.on(
        'part',
        (channel, nick, reason) => {
          this.sdk.logger.debug({ channel, nick, reason }, 'User parted IRC');
        },
      );

      this.client.on(
        'names',
        (channel, nicks) => {
          this.sdk.logger.debug(
            { channel, nickCount: Object.keys(nicks).length },
            'Received names list',
          );
        },
      );

      try {
        this.client.connect();
      } catch (err) {
        reject(err);
      }
    });
  }

  handleMessage(nick, target, text, message) {
    if (nick === this.config.nick) return;

    const jid = this.parseJid(target);
    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      this.sdk.logger.debug({ jid, nick }, 'Message from unregistered IRC channel');
      return;
    }

    let content = text;
    const triggerRegex = new RegExp(`^@${this.sdk.assistantName}\\b`, 'i');
    const mentionRegex = new RegExp(`@${this.config.nick}\\b`, 'i');

    if (mentionRegex.test(text) && !triggerRegex.test(text)) {
      content = `@${this.sdk.assistantName} ${text}`;
    }

    const timestamp = new Date(
      (message.time || Date.now() / 1000) * 1000,
    ).toISOString();
    const msgId = `${Date.now()}-${++this.messageId}`;

    const isGroup = true;
    this.opts.onChatMetadata(jid, timestamp, target, 'irc', isGroup);

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: nick,
      sender_name: nick,
      content,
      timestamp,
      is_from_me: false,
    });

    this.sdk.logger.info({ jid, nick, target }, 'IRC message stored');
  }

  async sendMessage(jid, text) {
    if (!this.client) {
      this.sdk.logger.warn('IRC client not initialized');
      return;
    }

    try {
      const match = jid.match(/^irc:(.+?)@(.+)$/);
      if (!match) {
        this.sdk.logger.warn({ jid }, 'Invalid IRC JID format');
        return;
      }

      const [, channel] = match;
      const maxLength = 480;

      if (text.length <= maxLength) {
        this.client.say(channel, text);
      } else {
        for (let i = 0; i < text.length; i += maxLength) {
          this.client.say(channel, text.slice(i, i + maxLength));
        }
      }

      this.sdk.logger.info({ jid, length: text.length }, 'IRC message sent');
    } catch (err) {
      this.sdk.logger.error({ jid, err }, 'Failed to send IRC message');
    }
  }

  isConnected() {
    return (
      this.client !== null &&
      this.client.conn !== undefined &&
      this.client.conn !== null
    );
  }

  ownsJid(jid) {
    return (
      jid.startsWith('irc:') &&
      jid.endsWith(`@${this.config.server}:${this.config.port}`)
    );
  }

  async disconnect() {
    if (this.client) {
      this.client.disconnect('Goodbye', () => {
        this.sdk.logger.info('IRC bot disconnected');
      });
      this.client = null;
    }
  }
}

function parseConfig(sdk) {
  const envVars = sdk.readEnvFile([
    'IRC_SERVER',
    'IRC_PORT',
    'IRC_NICK',
    'IRC_CHANNELS',
  ]);

  const server = process.env.IRC_SERVER || envVars.IRC_SERVER;
  const port = process.env.IRC_PORT
    ? parseInt(process.env.IRC_PORT, 10)
    : parseInt(envVars.IRC_PORT || '6697', 10);
  const nick = process.env.IRC_NICK || envVars.IRC_NICK;
  const channelsStr = process.env.IRC_CHANNELS || envVars.IRC_CHANNELS;

  if (!server || !nick || !channelsStr) {
    sdk.logger.warn('IRC: IRC_SERVER, IRC_NICK, and IRC_CHANNELS must be set');
    return null;
  }

  const channels = channelsStr.split(',').map((c) => c.trim());

  return { server, port, nick, channels };
}

export default function register(sdk) {
  sdk.registerChannel('irc', (opts) => {
    const cfg = parseConfig(sdk);
    if (!cfg) return null;
    return new IRCChannel(cfg, opts, sdk);
  });
}
