import { describe, expect, it } from 'vitest';
import { stepAt } from '../src/clock';
import { mintCode } from '../src/codes';
import { formatScanResult } from '../src/format';
import { createEvent, issueTicket, revokeTicket, scanCode, snapshotTicket } from '../src/service';
import { seed, setup, T0 } from './helpers';

function codeFor(ctx: ReturnType<typeof setup>, ticketId: string, step: number): string {
  const row = snapshotTicket(ctx.db, ticketId);
  if (!row) throw new Error('missing ticket');
  return mintCode(row.secret, row.id, step);
}

describe('door scan', () => {
  it('admits a current code once and rejects the replay as already used', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const code = codeFor(ctx, ticket.id, stepAt(T0));
    const first = scanCode(ctx.db, { eventId: event.id, code, nowMs: T0 });
    const second = scanCode(ctx.db, { eventId: event.id, code, nowMs: T0 });
    expect(formatScanResult(first)).toBe('ADMIT Ada Lovelace');
    expect(first).toMatchObject({ result: 'admit', ticket_id: ticket.id });
    expect(second).toEqual({ result: 'reject', reason: 'already_used' });
    expect(formatScanResult(second)).toBe('REJECTED: already used');
    expect(snapshotTicket(ctx.db, ticket.id)?.status).toBe('checked_in');
    ctx.close();
  });

  it('rejects a second in-window code for a ticket that was already admitted', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const previous = codeFor(ctx, ticket.id, stepAt(T0) - 1);
    const current = codeFor(ctx, ticket.id, stepAt(T0));
    expect(scanCode(ctx.db, { eventId: event.id, code: previous, nowMs: T0 }).result).toBe('admit');
    expect(scanCode(ctx.db, { eventId: event.id, code: current, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'already_used',
    });
    ctx.close();
  });

  it('rejects a code from 3 or more steps ago as expired and does not consume the ticket', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const stale = codeFor(ctx, ticket.id, stepAt(T0) - 3);
    const older = codeFor(ctx, ticket.id, stepAt(T0) - 4);
    const twoSteps = codeFor(ctx, ticket.id, stepAt(T0) - 2);
    expect(scanCode(ctx.db, { eventId: event.id, code: stale, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'expired',
    });
    expect(formatScanResult(scanCode(ctx.db, { eventId: event.id, code: older, nowMs: T0 }))).toBe(
      'REJECTED: expired',
    );
    expect(scanCode(ctx.db, { eventId: event.id, code: twoSteps, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'expired',
    });
    expect(snapshotTicket(ctx.db, ticket.id)?.status).toBe('issued');
    expect(scanCode(ctx.db, { eventId: event.id, code: codeFor(ctx, ticket.id, stepAt(T0)), nowMs: T0 }).result).toBe(
      'admit',
    );
    ctx.close();
  });

  it('still calls an already-used ticket expired when the presented code is stale', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const live = codeFor(ctx, ticket.id, stepAt(T0));
    const stale = codeFor(ctx, ticket.id, stepAt(T0) - 3);
    expect(scanCode(ctx.db, { eventId: event.id, code: live, nowMs: T0 }).result).toBe('admit');
    expect(scanCode(ctx.db, { eventId: event.id, code: stale, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'expired',
    });
    ctx.close();
  });

  it('rejects a tampered HMAC', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const code = codeFor(ctx, ticket.id, stepAt(T0));
    const tampered = `${code.slice(0, -1)}${code.endsWith('a') ? 'b' : 'a'}`;
    expect(scanCode(ctx.db, { eventId: event.id, code: tampered, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'invalid_code',
    });
    expect(snapshotTicket(ctx.db, ticket.id)?.status).toBe('issued');
    ctx.close();
  });

  it('rejects a revoked ticket', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const code = codeFor(ctx, ticket.id, stepAt(T0));
    expect(revokeTicket(ctx.db, ticket.id)).toMatchObject({ status: 'revoked' });
    expect(scanCode(ctx.db, { eventId: event.id, code, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'revoked',
    });
    ctx.close();
  });

  it('rejects a code presented at the wrong event and still admits it at the right one', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const other = createEvent(ctx.db, {
      name: 'Other night',
      startsAt: '2026-07-01T20:00:00.000Z',
      venue: 'Other hall',
      host: 'Mark',
      nowMs: T0,
    });
    const code = codeFor(ctx, ticket.id, stepAt(T0));
    expect(scanCode(ctx.db, { eventId: other.id, code, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'wrong_event',
    });
    expect(snapshotTicket(ctx.db, ticket.id)?.status).toBe('issued');
    expect(scanCode(ctx.db, { eventId: event.id, code, nowMs: T0 }).result).toBe('admit');
    ctx.close();
  });

  it('admits the neighboring steps for clock skew, and rejects two steps away', () => {
    const previous = setup();
    const next = setup();
    const early = seed(previous.db, T0, 'Grace Hopper');
    const late = seed(next.db, T0, 'Katherine Johnson');
    const prevCode = codeFor(previous, early.ticket.id, stepAt(T0) - 1);
    const nextCode = codeFor(next, late.ticket.id, stepAt(T0) + 1);
    expect(scanCode(previous.db, { eventId: early.event.id, code: prevCode, nowMs: T0 }).result).toBe('admit');
    expect(scanCode(next.db, { eventId: late.event.id, code: nextCode, nowMs: T0 }).result).toBe('admit');
    const far = setup();
    const third = seed(far.db);
    const plusTwo = codeFor(far, third.ticket.id, stepAt(T0) + 2);
    expect(scanCode(far.db, { eventId: third.event.id, code: plusTwo, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'expired',
    });
    previous.close();
    next.close();
    far.close();
  });

  it('does not issue a ticket without an event', () => {
    const ctx = setup();
    const missing = issueTicket(ctx.db, { eventId: crypto.randomUUID(), guestName: 'Nobody', nowMs: T0 });
    expect(missing).toEqual({ error: 'not_found' });
    ctx.close();
  });
});
