import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { stepAt } from './clock';

/** Truncated authentication tag. 16 bytes of HMAC-SHA256, hex-encoded in the payload. */
export const MAC_BYTES = 16;

const CODE_VERSION = 'pt1';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedCode = {
  ticketId: string;
  step: number;
  mac: Buffer;
};

/**
 * Message is the UTF-8 encoding of `ticketId|decimalStep`.
 * The pipe is the field boundary so the two values cannot be confused.
 * The payload carries the ticket id and the step; it never carries the secret.
 */
export function macMessage(ticketId: string, step: number): string {
  return `${ticketId}|${step}`;
}

export function computeMac(secret: Buffer, ticketId: string, step: number): Buffer {
  return createHmac('sha256', secret).update(macMessage(ticketId, step)).digest().subarray(0, MAC_BYTES);
}

export function compareMacs(expected: Buffer, provided: Buffer): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function mintCode(secret: Buffer, ticketId: string, step: number): string {
  const mac = computeMac(secret, ticketId, step);
  return `${CODE_VERSION}.${ticketId}.${step}.${mac.toString('hex')}`;
}

export function parseCode(raw: string): ParsedCode | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  const parts = raw.trim().split('.');
  if (parts.length !== 4) return null;
  const version = parts[0];
  const ticketId = parts[1];
  const stepText = parts[2];
  const macHex = parts[3];
  if (version !== CODE_VERSION || ticketId === undefined || stepText === undefined || macHex === undefined) {
    return null;
  }
  if (!UUID_RE.test(ticketId)) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(stepText)) return null;
  const step = Number(stepText);
  if (!Number.isSafeInteger(step)) return null;
  const hex = macHex.toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  const mac = Buffer.from(hex, 'hex');
  if (mac.length !== MAC_BYTES) return null;
  return { ticketId: ticketId.toLowerCase(), step, mac };
}

export function newSecret(): Buffer {
  return randomBytes(32);
}

export function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}

/** A code is live for the current step and one step of clock skew on either side. */
export function stepWithinWindow(codeStep: number, nowMs: number): boolean {
  return Math.abs(codeStep - stepAt(nowMs)) <= 1;
}
