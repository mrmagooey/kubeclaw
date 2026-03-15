/* eslint-disable @typescript-eslint/no-explicit-any */
import IRC from 'irc-upd';

import { ASSISTANT_NAME } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface IRCChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface IRCConfig {
  server: string;
  port: number;
  nick: string;
  channels: string[];
}

interface IRCMessage {
  time: number;
}

export class IRCChannel implements Channel {
  name = 'irc';

  private client: any = null;
  private opts: IRCChannelOpts;
  private config: IRCConfig;
  private messageId = 0;

  constructor(config: IRCConfig, opts: IRCChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  private parseJid(channel: string): string {
    return `irc:${channel.toLowerCase()}@${this.config.server}`;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = new (IRC as any).Client(
        this.config.server,
        this.config.nick,
        {
          ports: [this.config.port],
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
        } as any,
      );

      this.client.on('registered', () => {
        logger.info(
          { nick: this.config.nick, server: this.config.server },
          'IRC bot connected',
        );
        console.log(`\n  IRC bot: ${this.config.nick}@${this.config.server}`);
        console.log(`  Joined channels: ${this.config.channels.join(', ')}\n`);
        resolve();
      });

      this.client.on('error', (err: unknown) => {
        logger.error({ err }, 'IRC client error');
      });

      this.client.on(
        'message',
        (nick: string, target: string, text: string, message: IRCMessage) => {
          this.handleMessage(nick, target, text, message);
        },
      );

      this.client.on('join', (channel: string, nick: string) => {
        if (nick === this.config.nick) {
          const jid = this.parseJid(channel);
          const timestamp = new Date().toISOString();
          this.opts.onChatMetadata(jid, timestamp, channel, 'irc', true);
        }
      });

      this.client.on('quit', (nick: string, reason: string) => {
        logger.debug({ nick, reason }, 'User quit IRC');
      });

      this.client.on(
        'part',
        (channel: string, nick: string, reason: string) => {
          logger.debug({ channel, nick, reason }, 'User parted IRC');
        },
      );

      this.client.on(
        'names',
        (channel: string, nicks: Record<string, string>) => {
          logger.debug(
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

  private handleMessage(
    nick: string,
    target: string,
    text: string,
    message: IRCMessage,
  ): void {
    if (nick === this.config.nick) return;

    const jid = this.parseJid(target);
    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid, nick }, 'Message from unregistered IRC channel');
      return;
    }

    let content = text;
    const triggerRegex = new RegExp(`^@${ASSISTANT_NAME}\\b`, 'i');
    const mentionRegex = new RegExp(`@${this.config.nick}\\b`, 'i');

    if (mentionRegex.test(text) && !triggerRegex.test(text)) {
      content = `@${ASSISTANT_NAME} ${text}`;
    }

    const timestamp = new Date(message.time * 1000).toISOString();
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

    logger.info({ jid, nick, target }, 'IRC message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('IRC client not initialized');
      return;
    }

    try {
      const match = jid.match(/^irc:(.+?)@(.+)$/);
      if (!match) {
        logger.warn({ jid }, 'Invalid IRC JID format');
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

      logger.info({ jid, length: text.length }, 'IRC message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send IRC message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.conn?.connected === true;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('irc:') && jid.endsWith(`@${this.config.server}`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.disconnect('Goodbye', () => {
        logger.info('IRC bot disconnected');
      });
      this.client = null;
    }
  }
}

function parseConfig(): IRCConfig | null {
  const envVars = readEnvFile([
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
    logger.warn('IRC: IRC_SERVER, IRC_NICK, and IRC_CHANNELS must be set');
    return null;
  }

  const channels = channelsStr.split(',').map((c) => c.trim());

  return { server, port, nick, channels };
}

registerChannel('irc', (opts: ChannelOpts) => {
  const config = parseConfig();
  if (!config) {
    return null;
  }
  return new IRCChannel(config, opts);
});
