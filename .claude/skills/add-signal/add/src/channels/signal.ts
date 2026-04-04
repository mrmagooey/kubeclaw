import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface SignalConfig {
  cliUrl: string;
  phoneNumber: string;
  pollIntervalMs: number;
}

// signal-cli-rest-api envelope types (v1 receive endpoint)
interface SignalDataMessage {
  timestamp: number;
  message?: string;
  groupInfo?: {
    groupId: string;
    type: string;
  };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
}

interface ReceiveItem {
  envelope: SignalEnvelope;
  account?: string;
}

function toJid(source: string, groupId?: string): string {
  if (groupId) {
    return `signal:g.${groupId}`;
  }
  return `signal:${source}`;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private opts: SignalChannelOpts;
  private config: SignalConfig;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private messageSeq = 0;

  constructor(config: SignalConfig, opts: SignalChannelOpts) {
    this.config = config;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this._connected = true;
    logger.info(
      { phoneNumber: this.config.phoneNumber, cliUrl: this.config.cliUrl },
      'Signal channel connected',
    );
    console.log(`\n  Signal number: ${this.config.phoneNumber}`);
    console.log(`  Signal CLI: ${this.config.cliUrl}`);
    console.log(
      `  Send /chatid to get a JID for group registration\n`,
    );
    this.schedulePoll();
  }

  private schedulePoll(): void {
    if (!this._connected) return;
    this.pollTimer = setTimeout(() => {
      this.poll().finally(() => this.schedulePoll());
    }, this.config.pollIntervalMs);
  }

  async poll(): Promise<void> {
    try {
      const url = `${this.config.cliUrl}/v1/receive/${encodeURIComponent(this.config.phoneNumber)}`;
      const resp = await fetch(url);

      if (!resp.ok) {
        logger.warn({ status: resp.status }, 'Signal receive returned non-ok');
        return;
      }

      const data: unknown = await resp.json();
      if (!Array.isArray(data)) return;
      const items = data as ReceiveItem[];

      for (const item of items) {
        this.handleEnvelope(item.envelope);
      }
    } catch (err) {
      logger.debug({ err }, 'Signal poll error');
    }
  }

  handleEnvelope(envelope: SignalEnvelope): void {
    const dm = envelope.dataMessage;
    if (!dm?.message) return; // receipts, typing notifications, sync events

    const source = envelope.sourceNumber || envelope.source || '';
    const groupId = dm.groupInfo?.groupId;
    const jid = toJid(source, groupId);
    const senderName = envelope.sourceName || source;
    const timestamp = new Date(dm.timestamp).toISOString();
    const msgId = `${dm.timestamp}-${++this.messageSeq}`;
    const isGroup = !!groupId;

    this.opts.onChatMetadata(jid, timestamp, senderName, 'signal', isGroup);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid, senderName }, 'Signal message from unregistered JID');
      return;
    }

    this.opts.onMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: source,
      sender_name: senderName,
      content: dm.message,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, senderName }, 'Signal message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this._connected) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      const id = jid.slice('signal:'.length);
      const isGroup = id.startsWith('g.');

      // Signal has no hard per-message limit but we split conservatively
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }

      for (const chunk of chunks) {
        const body = isGroup
          ? {
              message: chunk,
              number: this.config.phoneNumber,
              recipients: [] as string[],
              group_id: id.slice('g.'.length),
            }
          : {
              message: chunk,
              number: this.config.phoneNumber,
              recipients: [id],
            };

        const resp = await fetch(`${this.config.cliUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!resp.ok) {
          const errText = await resp.text();
          logger.error(
            { jid, status: resp.status, errText },
            'Signal send failed',
          );
          return;
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Signal channel disconnected');
  }
}

function parseConfig(): SignalConfig | null {
  const envVars = readEnvFile(['SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_URL']);

  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER;
  const cliUrl =
    process.env.SIGNAL_CLI_URL ||
    envVars.SIGNAL_CLI_URL ||
    'http://kubeclaw-signal-cli:8080';
  const pollIntervalMs = parseInt(
    process.env.SIGNAL_POLL_INTERVAL_MS || '3000',
    10,
  );

  if (!phoneNumber) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER must be set');
    return null;
  }

  return { cliUrl, phoneNumber, pollIntervalMs };
}

registerChannel('signal', (opts: ChannelOpts) => {
  const config = parseConfig();
  if (!config) return null;
  return new SignalChannel(config, opts);
});
