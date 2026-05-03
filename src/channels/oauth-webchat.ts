import crypto from 'node:crypto';

export interface SessionPayload {
  email: string;
  /** Unix epoch seconds */
  exp: number;
}

export function signSessionCookie(payload: SessionPayload, secret: string): string {
  const payloadBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const sig = crypto.createHmac('sha256', secret).update(payloadBytes).digest();
  return `${payloadBytes.toString('base64url')}.${sig.toString('base64url')}`;
}

export function verifySessionCookie(
  cookie: string,
  secret: string,
): SessionPayload | null {
  const dot = cookie.indexOf('.');
  if (dot < 1 || dot === cookie.length - 1) return null;

  const payloadB64 = cookie.slice(0, dot);
  const sigB64 = cookie.slice(dot + 1);

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = Buffer.from(payloadB64, 'base64url');
    sig = Buffer.from(sigB64, 'base64url');
  } catch {
    return null;
  }

  const expected = crypto.createHmac('sha256', secret).update(payloadBytes).digest();
  if (expected.length !== sig.length) return null;
  if (!crypto.timingSafeEqual(expected, sig)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8')) as SessionPayload;
  } catch {
    return null;
  }

  // Only `exp` is required. Other fields are validated by callers
  // (e.g. session vs state cookies have different shapes).
  if (typeof payload.exp !== 'number') return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;

  return payload;
}
