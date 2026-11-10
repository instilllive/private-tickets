import { describe, expect, it } from 'vitest';
import { stepAt } from '../src/clock';
import { mintCode } from '../src/codes';
import { createEvent, issueTicket, snapshotTicket } from '../src/service';
import { HOST, hostJson, seed, setup, T0 } from './helpers';

function codeFor(ctx: ReturnType<typeof setup>, ticketId: string, step = stepAt(T0)): string {
  const row = snapshotTicket(ctx.db, ticketId);
  if (!row) throw new Error('missing ticket');
  return mintCode(row.secret, row.id, step);
}

describe('door staff', () => {
  it('can scan its own event, cannot list guests, and cannot scan another event', async () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const other = createEvent(ctx.db, {
      name: 'Other dinner',
      startsAt: '2026-11-17T19:00:00.000Z',
      venue: 'Elsewhere',
      host: 'Nia',
      nowMs: T0,
    });
    const outsider = issueTicket(ctx.db, { eventId: other.id, guestName: 'Outside Guest', nowMs: T0 });
    if ('error' in outsider) throw new Error(outsider.error);

    const created = await hostJson(ctx.app, `/api/host/events/${event.id}/staff`, { label: 'Front door' });
    expect(created.status).toBe(201);
    const doorPath = created.json.staff.door_path as string;
    expect(doorPath).toMatch(/^\/door\/s\//);
    const token = doorPath.slice('/door/s/'.length);

    const page = await ctx.app.request(doorPath);
    expect(page.status).toBe(200);

    const admitted = await ctx.app.request(`/api/staff/${token}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeFor(ctx, ticket.id) }),
    });
    expect(await admitted.json()).toMatchObject({ result: 'admit', guest_name: 'Ada Lovelace' });

    const replay = await ctx.app.request(`/api/staff/${token}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeFor(ctx, ticket.id) }),
    });
    expect(await replay.json()).toEqual({ result: 'reject', reason: 'already_used' });

    const list = await ctx.app.request(`/api/host/events/${event.id}/tickets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.status).toBe(401);
    const imported = await ctx.app.request(`/api/host/events/${event.id}/import`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ csv: 'name\nSomeone\n' }),
    });
    expect(imported.status).toBe(401);

    const session = await ctx.app.request(`/api/staff/${token}`);
    const sessionBody = await session.json();
    expect(session.status).toBe(200);
    expect(sessionBody.event.id).toBe(event.id);
    expect(JSON.stringify(sessionBody)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(sessionBody)).not.toContain('guest_name');

    const wrong = await ctx.app.request(`/api/staff/${token}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeFor(ctx, outsider.ticket.id) }),
    });
    expect(await wrong.json()).toEqual({ result: 'reject', reason: 'wrong_event' });
    expect(snapshotTicket(ctx.db, outsider.ticket.id)?.status).toBe('issued');

    const fresh = issueTicket(ctx.db, { eventId: event.id, guestName: 'Second Guest', nowMs: T0 });
    if ('error' in fresh) throw new Error(fresh.error);
    const mismatched = await ctx.app.request(`/api/staff/${token}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeFor(ctx, fresh.ticket.id), event_id: other.id }),
    });
    expect(await mismatched.json()).toEqual({ result: 'reject', reason: 'wrong_event' });
    expect(snapshotTicket(ctx.db, fresh.ticket.id)?.status).toBe('issued');

    const hostList = await ctx.app.request(`/api/host/events/${event.id}/tickets`, {
      headers: { authorization: `Bearer ${HOST}` },
    });
    expect(hostList.status).toBe(200);

    const revoked = await hostJson(ctx.app, `/api/host/staff/${created.json.staff.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    const dead = await ctx.app.request(`/api/staff/${token}/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: codeFor(ctx, fresh.ticket.id) }),
    });
    expect(dead.status).toBe(401);
    expect(snapshotTicket(ctx.db, fresh.ticket.id)?.status).toBe('issued');
    ctx.close();
  });
});
