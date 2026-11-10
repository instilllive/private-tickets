import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MAC_BYTES,
  formatCode,
  macMessage,
  parsePayload,
  stepWithinWindow,
  type ParsedPayload,
} from './protocol';

export { MAC_BYTES, macMessage, stepWithinWindow };

export type ParsedCode = {
  ticketId: string;
  step: number;
  mac: Buffer;
};

export function parseCode(raw: string): ParsedCode | null {
  const parsed: ParsedPayload | null = parsePayload(raw);
  if (!parsed) return null;
  return { ticketId: parsed.ticketId, step: parsed.step, mac: Buffer.from(parsed.mac) };
}

export function computeMac(secret: Buffer, ticketId: string, step: number): Buffer {
  return createHmac('sha256', secret).update(macMessage(ticketId, step)).digest().subarray(0, MAC_BYTES);
}

export function compareMacs(expected: Buffer, provided: Buffer): boolean {
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

export function mintCode(secret: Buffer, ticketId: string, step: number): string {
  return formatCode(ticketId, step, computeMac(secret, ticketId, step));
}

export function newSecret(): Buffer {
  return randomBytes(32);
}

export function newAccessToken(): string {
  return randomBytes(32).toString('base64url');
}
