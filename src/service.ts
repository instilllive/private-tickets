import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { STEP_MS, stepAt, stepEndsAt } from './clock';
import { compareMacs, computeMac, mintCode, newAccessToken, newSecret, parseCode, stepWithinWindow } from './codes';
import {
  getEvent,
  getTicket,
  getTicketByAccess,
  mapTicket,
  type DB,
  type EventRow,
  type TicketRow,
  type TicketStatus,
  type TransferRow,
  type TransferStatus,
} from './db';
import { type ScanResult } from './format';

const DUMMY_SECRET = newSecret();

export type PublicEvent = {
  id: string;
  name: string;
  starts_at: string;
  venue: string;
  host: string;
  created_at: string;
};

export type PublicTicket = {
  id: string;
  event_id: string;
  guest_name: string;
  status: TicketStatus;
  created_at: string;
  checked_in_at: string | null;
  guest_path: string;
};

export type PublicTransfer = {
  id: string;
  ticket_id: string;
  event_id: string;
  from_name: string;
  to_name: string;
  status: TransferStatus;
  created_at: string;
  resolved_at: string | null;
};

export type GuestView = {
  guest_name: string;
  status: TicketStatus;
  event: PublicEvent;
  pending_transfer: { id: string; to_name: string } | null;
  step: number;
  step_ms: number;
  server_now: number;
  step_ends_at: number;
  code: string | null;
  qr_data_url: string | null;
};

function iso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function publicEvent(row: EventRow): PublicEvent {
  return {
    id: row.id,
    name: row.name,
    starts_at: row.starts_at,
    venue: row.venue,
    host: row.host,
    created_at: row.created_at,
  };
}

function publicTicket(row: TicketRow): PublicTicket {
  return {
    id: row.id,
    event_id: row.event_id,
    guest_name: row.guest_name,
    status: row.status,
    created_at: row.created_at,
    checked_in_at: row.checked_in_at,
    guest_path: `/t/${row.access_token}`,
  };
}

function publicTransfer(row: TransferRow): PublicTransfer {
  return { ...row };
}

export function listEvents(db: DB): PublicEvent[] {
  const rows = db.prepare('SELECT * FROM events ORDER BY starts_at ASC, name ASC').all() as EventRow[];
  return rows.map(publicEvent);
}

export function createEvent(
  db: DB,
  input: { name: string; startsAt: string; venue: string; host: string; nowMs: number },
): PublicEvent {
  const row: EventRow = {
    id: randomUUID(),
    name: input.name,
    starts_at: input.startsAt,
    venue: input.venue,
    host: input.host,
    created_at: iso(input.nowMs),
  };
  db.prepare(
    `INSERT INTO events (id, name, starts_at, venue, host, created_at)
     VALUES (@id, @name, @starts_at, @venue, @host, @created_at)`,
  ).run(row);
  return publicEvent(row);
}

export function issueTicket(
  db: DB,
  input: { eventId: string; guestName: string; nowMs: number },
): { ticket: PublicTicket; accessToken: string } | { error: 'not_found' } {
  if (!getEvent(db, input.eventId)) return { error: 'not_found' };
  const row: TicketRow = {
    id: randomUUID(),
    event_id: input.eventId,
    guest_name: input.guestName,
    status: 'issued',
    secret: newSecret(),
    access_token: newAccessToken(),
    created_at: iso(input.nowMs),
    checked_in_at: null,
  };
  db.prepare(
    `INSERT INTO tickets (id, event_id, guest_name, status, secret, access_token, created_at, checked_in_at)
     VALUES (@id, @event_id, @guest_name, @status, @secret, @access_token, @created_at, @checked_in_at)`,
  ).run(row);
  return { ticket: publicTicket(row), accessToken: row.access_token };
}

export function listTickets(db: DB, eventId: string): PublicTicket[] | null {
  if (!getEvent(db, eventId)) return null;
  const rows = db
    .prepare('SELECT * FROM tickets WHERE event_id = ? ORDER BY created_at ASC, guest_name ASC')
    .all(eventId) as Record<string, unknown>[];
  return rows.map((row) => publicTicket(mapTicket(row)));
}

export function revokeTicket(db: DB, ticketId: string): PublicTicket | { error: 'not_found' | 'not_revocable' } {
  const existing = getTicket(db, ticketId);
  if (!existing) return { error: 'not_found' };
  if (existing.status === 'revoked') return { error: 'not_revocable' };
  const info = db
    .prepare(`UPDATE tickets SET status = 'revoked' WHERE id = ? AND status != 'revoked'`)
    .run(ticketId);
  if (info.changes !== 1) return { error: 'not_revocable' };
  const updated = getTicket(db, ticketId);
  if (!updated) return { error: 'not_found' };
  return publicTicket(updated);
}

export function listTransfers(db: DB, eventId: string): PublicTransfer[] | null {
  if (!getEvent(db, eventId)) return null;
  const rows = db
    .prepare('SELECT * FROM transfers WHERE event_id = ? ORDER BY created_at ASC')
    .all(eventId) as TransferRow[];
  return rows.map(publicTransfer);
}

export type TransferResult =
  | { ok: true; transfer: PublicTransfer }
  | { ok: false; error: 'not_found' | 'not_transferable' | 'same_name' | 'pending_exists' };

export function requestTransfer(
  db: DB,
  input: { accessToken: string; toName: string; nowMs: number },
): TransferResult {
  const run = db.transaction((): TransferResult => {
    const ticket = getTicketByAccess(db, input.accessToken);
    if (!ticket) return { ok: false, error: 'not_found' };
    if (ticket.status !== 'issued') return { ok: false, error: 'not_transferable' };
    if (ticket.guest_name === input.toName) return { ok: false, error: 'same_name' };
    const pending = db
      .prepare(`SELECT * FROM transfers WHERE ticket_id = ? AND status = 'pending'`)
      .get(ticket.id) as TransferRow | undefined;
    if (pending) return { ok: false, error: 'pending_exists' };
    const row: TransferRow = {
      id: randomUUID(),
      ticket_id: ticket.id,
      event_id: ticket.event_id,
      from_name: ticket.guest_name,
      to_name: input.toName,
      status: 'pending',
      created_at: iso(input.nowMs),
      resolved_at: null,
    };
    db.prepare(
      `INSERT INTO transfers (id, ticket_id, event_id, from_name, to_name, status, created_at, resolved_at)
       VALUES (@id, @ticket_id, @event_id, @from_name, @to_name, @status, @created_at, @resolved_at)`,
    ).run(row);
    return { ok: true, transfer: publicTransfer(row) };
  });
  return run.immediate();
}

export type ApproveResult =
  | { ok: true; transfer: PublicTransfer; ticket: PublicTicket; accessToken: string }
  | { ok: false; error: 'not_found' | 'not_pending' | 'not_transferable' };

export function approveTransfer(db: DB, transferId: string, nowMs: number): ApproveResult {
  const run = db.transaction((): ApproveResult => {
    const transfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId) as TransferRow | undefined;
    if (!transfer) return { ok: false, error: 'not_found' };
    if (transfer.status !== 'pending') return { ok: false, error: 'not_pending' };
    const ticket = getTicket(db, transfer.ticket_id);
    if (!ticket || ticket.status !== 'issued') {
      db.prepare(`UPDATE transfers SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'`).run(
        iso(nowMs),
        transferId,
      );
      return { ok: false, error: 'not_transferable' };
    }
    const secret = newSecret();
    const accessToken = newAccessToken();
    const updated = db
      .prepare(
        `UPDATE tickets
         SET guest_name = ?, secret = ?, access_token = ?
         WHERE id = ? AND status = 'issued'`,
      )
      .run(transfer.to_name, secret, accessToken, ticket.id);
    if (updated.changes !== 1) return { ok: false, error: 'not_transferable' };
    db.prepare(`UPDATE transfers SET status = 'approved', resolved_at = ? WHERE id = ?`).run(iso(nowMs), transferId);
    const freshTicket = getTicket(db, ticket.id);
    const freshTransfer = db.prepare('SELECT * FROM transfers WHERE id = ?').get(transferId) as TransferRow;
    if (!freshTicket) return { ok: false, error: 'not_found' };
    return {
      ok: true,
      transfer: publicTransfer(freshTransfer),
      ticket: publicTicket(freshTicket),
      accessToken,
    };
  });
  return run.immediate();
}

export async function guestView(db: DB, accessToken: string, nowMs: number): Promise<GuestView | null> {
  const ticket = getTicketByAccess(db, accessToken);
  if (!ticket) return null;
  const event = getEvent(db, ticket.event_id);
  if (!event) return null;
  const pending = db
    .prepare(`SELECT id, to_name FROM transfers WHERE ticket_id = ? AND status = 'pending'`)
    .get(ticket.id) as { id: string; to_name: string } | undefined;
  const step = stepAt(nowMs);
  let code: string | null = null;
  let qr: string | null = null;
  if (ticket.status === 'issued') {
    code = mintCode(ticket.secret, ticket.id, step);
    qr = await QRCode.toDataURL(code, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
    });
  }
  return {
    guest_name: ticket.guest_name,
    status: ticket.status,
    event: publicEvent(event),
    pending_transfer: pending ? { id: pending.id, to_name: pending.to_name } : null,
    step,
    step_ms: STEP_MS,
    server_now: nowMs,
    step_ends_at: stepEndsAt(step),
    code,
    qr_data_url: qr,
  };
}

/**
 * Verify a door code and, on success, claim the ticket.
 * Check order: signature, time window, event, then an immediate transaction
 * that re-reads the secret and flips issued → checked_in. The re-read matters
 * because a host can rotate the secret in between. A second claim loses the race.
 * Codes outside the window are expired even after check-in, so a stale
 * screenshot is not reported as a replay of a live code.
 */
export function scanCode(db: DB, input: { eventId: string; code: string; nowMs: number }): ScanResult {
  const parsed = parseCode(input.code);
  if (!parsed) return { result: 'reject', reason: 'invalid_code' };

  const ticket = getTicket(db, parsed.ticketId);
  const expected = computeMac(ticket?.secret ?? DUMMY_SECRET, parsed.ticketId, parsed.step);
  if (!ticket || !compareMacs(expected, parsed.mac)) return { result: 'reject', reason: 'invalid_code' };

  if (!stepWithinWindow(parsed.step, input.nowMs)) {
    return { result: 'reject', reason: 'expired' };
  }
  if (ticket.event_id !== input.eventId) {
    return { result: 'reject', reason: 'wrong_event' };
  }

  const claim = db.transaction((): ScanResult => {
    const current = getTicket(db, ticket.id);
    if (!current) return { result: 'reject', reason: 'invalid_code' };
    const lockedMac = computeMac(current.secret, current.id, parsed.step);
    if (!compareMacs(lockedMac, parsed.mac)) return { result: 'reject', reason: 'invalid_code' };
    if (current.event_id !== input.eventId) return { result: 'reject', reason: 'wrong_event' };
    if (current.status === 'revoked') return { result: 'reject', reason: 'revoked' };
    if (current.status !== 'issued') return { result: 'reject', reason: 'already_used' };
    const info = db
      .prepare(
        `UPDATE tickets SET status = 'checked_in', checked_in_at = ?
         WHERE id = ? AND status = 'issued'`,
      )
      .run(iso(input.nowMs), ticket.id);
    if (info.changes !== 1) {
      const again = getTicket(db, ticket.id);
      if (again?.status === 'revoked') return { result: 'reject', reason: 'revoked' };
      return { result: 'reject', reason: 'already_used' };
    }
    return {
      result: 'admit',
      ticket_id: current.id,
      guest_name: current.guest_name,
      event_id: current.event_id,
    };
  });
  return claim.immediate();
}

export function snapshotTicket(db: DB, ticketId: string): TicketRow | null {
  return getTicket(db, ticketId);
}
