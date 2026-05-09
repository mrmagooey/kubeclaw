/**
 * Types for orchestrator-side skill execution.
 *
 * Orchestrator skills create and manage K8s resources (Secrets, PVCs,
 * Deployments) on behalf of channels and capabilities.
 */

export interface ChannelSetupInput {
  /** Channel type: telegram, discord, slack, whatsapp, irc, http, signal, gmail */
  type: string;
  /** Unique instance name (defaults to type). Use for multiple instances of the same type. */
  instanceName?: string;
  /** Bot token or API key (Telegram, Discord, Slack) */
  token?: string;
  /** Phone number in E.164 format (WhatsApp, Signal) */
  phoneNumber?: string;
  /** IRC server hostname */
  server?: string;
  /** IRC nickname */
  nick?: string;
  /** Comma-separated IRC channels */
  channels?: string;
  /** Comma-separated user:pass pairs (HTTP) */
  httpUsers?: string;
  /** HTTP listen port (HTTP) */
  httpPort?: number;
  /** Public base URL with scheme, e.g. https://chat.example.com (oauth-webchat) */
  publicUrl?: string;
  /** OIDC issuer URL (oauth-webchat) */
  oidcIssuer?: string;
  /** OAuth client ID (oauth-webchat) */
  clientId?: string;
  /** OAuth client secret (oauth-webchat) */
  clientSecret?: string;
  /** Comma-separated allowed emails or @domain wildcards (oauth-webchat) */
  allowedEmails?: string;
  /** ≥32-char HMAC secret for session cookie (oauth-webchat) */
  cookieSecret?: string;
  /** Session lifetime in days (oauth-webchat, default 30) */
  sessionTtlDays?: number;
  /** OIDC scopes (oauth-webchat, default "openid email profile") */
  scopes?: string;
  /** Display name on login button (oauth-webchat, default "OIDC") */
  providerName?: string;
  /** Auto-register a default group */
  registerGroup?: boolean;
  groupJid?: string;
  groupName?: string;
  groupFolder?: string;
  trigger?: string;
}

export interface ChannelSetupResult {
  success: boolean;
  log: string[];
  instanceName: string;
  deploymentName: string;
}

/** Environment variables required per channel type for credential validation. */
export const CHANNEL_ENV: Record<string, string[]> = {
  telegram: ['TELEGRAM_BOT_TOKEN'],
  discord: ['DISCORD_BOT_TOKEN'],
  slack: ['SLACK_BOT_TOKEN'],
  whatsapp: ['WHATSAPP_PHONE_NUMBER'],
  irc: ['IRC_SERVER', 'IRC_NICK', 'IRC_CHANNELS'],
  http: ['HTTP_CHANNEL_PORT', 'HTTP_CHANNEL_USERS'],
  signal: ['SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_URL'],
  'oauth-webchat': [
    'OAUTH_WEBCHAT_PUBLIC_URL',
    'OAUTH_WEBCHAT_OIDC_ISSUER',
    'OAUTH_WEBCHAT_CLIENT_ID',
    'OAUTH_WEBCHAT_CLIENT_SECRET',
    'OAUTH_WEBCHAT_ALLOWED_EMAILS',
    'OAUTH_WEBCHAT_COOKIE_SECRET',
  ],
};
