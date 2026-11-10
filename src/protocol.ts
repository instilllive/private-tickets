import { stepAt } from './clock';
import type { ScanResult } from './format';

/** Truncated authentication tag. 16 bytes of HMAC-SHA256, hex-encoded in the payload. */
export const MAC_BYTES = 16;

const CODE_VERSION = 'pt1';
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParsedPayload = {
  ticketId: string;
  step: number;
  mac: Uint8Array;
};

export type ClaimTicket = {
  id: string;
  eventId: string;
  guestName: string;
  status: 'issued' | 'checked_in' | 'revoked';
};

/**
 * Message is the UTF-8 encoding of `ticketId|decimalStep`.
 * The pipe is the field boundary so the two values cannot be confused.
 * The payload carries the ticket id and the step; it never carries the secret.
 */
export function macMessage(ticketId: string, step: number): string {
  return `${ticketId}|${step}`;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function formatCode(ticketId: string, step: number, mac: Uint8Array): string {
  return `${CODE_VERSION}.${ticketId}.${step}.${bytesToHex(mac)}`;
}

export function parsePayload(raw: string): ParsedPayload | null {
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
  const mac = new Uint8Array(MAC_BYTES);
  for (let i = 0; i < MAC_BYTES; i += 1) mac[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return { ticketId: ticketId.toLowerCase(), step, mac };
}

/** A code is live for the current step and one step of clock skew on either side. */
export function stepWithinWindow(codeStep: number, nowMs: number): boolean {
  return Math.abs(codeStep - stepAt(nowMs)) <= 1;
}

/**
 * Door decision before the ticket is claimed.
 * Order: signature, time window, event. A stale code is expired even if the
 * ticket was already used, so a screenshot is not described as a replay.
 * Returns null when the door should try to claim the ticket.
 */
export function rejectBeforeClaim(input: {
  macOk: boolean;
  inWindow: boolean;
  eventMatches: boolean;
}): ScanResult | null {
  if (!input.macOk) return { result: 'reject', reason: 'invalid_code' };
  if (!input.inWindow) return { result: 'reject', reason: 'expired' };
  if (!input.eventMatches) return { result: 'reject', reason: 'wrong_event' };
  return null;
}

/**
 * Door decision while the ticket row is locked for check-in.
 * The signature and event are read again so a transfer that rotated the
 * secret in between cannot be admitted. Returns null when the row may flip
 * from issued to checked_in.
 */
export function rejectAtClaim(input: {
  present: boolean;
  macOk: boolean;
  eventMatches: boolean;
  status: ClaimTicket['status'] | null;
}): ScanResult | null {
  if (!input.present || !input.macOk) return { result: 'reject', reason: 'invalid_code' };
  if (!input.eventMatches) return { result: 'reject', reason: 'wrong_event' };
  if (input.status === 'revoked') return { result: 'reject', reason: 'revoked' };
  if (input.status !== 'issued') return { result: 'reject', reason: 'already_used' };
  return null;
}

export function admitTicket(ticket: ClaimTicket): ScanResult {
  return {
    result: 'admit',
    ticket_id: ticket.id,
    guest_name: ticket.guestName,
    event_id: ticket.eventId,
  };
}
