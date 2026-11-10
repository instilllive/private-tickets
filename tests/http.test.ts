import { afterEach, describe, expect, it, vi } from 'vitest';
import { STEP_MS } from '../src/clock';
import { openDatabase } from '../src/db';
import { createApp } from '../src/app';
import { snapshotTicket } from '../src/service';
import { HOST, hostJson, seed, setup, T0 } from './helpers';

const open: Array<{ close: () => void }> = [];

async function body(res: Response): Promise<any> {
  return res.json();
}

afterEach(() => {
  vi.useRealTimers();
  for (const ctx of open.splice(0)) ctx.close();
});

describe('http', () => {
  it('requires the host token', async () => {
    const ctx = setup();
    open.push(ctx);
    const missing = await ctx.app.request('/api/host/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', starts_at: T0, venue: 'Y', host: 'Mark' }),
    });
    expect(missing.status).toBe(401);
    const wrong = await ctx.app.request('/api/host/events', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', starts_at: new Date(T0).toISOString(), venue: 'Y', host: 'Mark' }),
    });
    expect(wrong.status).toBe(401);
  });

  it('creates an event, issues a ticket, lists guests, and revokes', async () => {
    const ctx = setup();
    open.push(ctx);
    const created = await hostJson(ctx.app, '/api/host/events', {
      name: 'Listening room',
      starts_at: '2026-06-01T20:00:00.000Z',
      venue: 'June hall',
      host: 'Mark',
    });
    expect(created.status).toBe(201);
    const eventId = created.json.event.id as string;
    const issued = await hostJson(ctx.app, `/api/host/events/${eventId}/tickets`, {
      guest_name: 'Ada Lovelace',
    });
    expect(issued.status).toBe(201);
    expect(issued.json.ticket.status).toBe('issued');
    expect(issued.json.guest_path).toMatch(/^\/t\//);
    const row = snapshotTicket(ctx.db, issued.json.ticket.id);
    expect(row?.secret).toHaveLength(32);
    expect(JSON.stringify(issued.json)).not.toContain(row?.secret.toString('hex'));
    expect(JSON.stringify(issued.json)).not.toContain(row?.secret.toString('base64'));

    const list = await hostJson(ctx.app, `/api/host/events/${eventId}/tickets`);
    expect(list.json.tickets).toHaveLength(1);
    expect(list.json.tickets[0].guest_name).toBe('Ada Lovelace');

    const guest = await ctx.app.request(issued.json.guest_path.replace('/t/', '/api/guest/'));
    const guestBody = await body(guest);
    expect(guest.status).toBe(200);
    expect(guestBody.code).toMatch(/^pt1\./);
    expect(guestBody.qr_data_url).toMatch(/^data:image\/png;base64,/);
    const withoutImage = { ...guestBody, qr_data_url: undefined };
    expect(JSON.stringify(withoutImage)).not.toContain(row?.secret.toString('hex'));
    expect(guestBody.code).not.toContain(row?.secret.toString('hex'));

    const revoked = await hostJson(ctx.app, `/api/host/tickets/${issued.json.ticket.id}/revoke`, {});
    expect(revoked.status).toBe(200);
    expect(revoked.json.ticket.status).toBe('revoked');
    const scan = await ctx.app.request('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: eventId, code: guestBody.code }),
    });
    expect(await body(scan)).toEqual({ result: 'reject', reason: 'revoked' });
  });

  it('rotates the guest code when the clock steps, including under fake timers', async () => {
    const ctx = setup();
    open.push(ctx);
    const { accessToken } = seed(ctx.db);
    const first = await body(await ctx.app.request(`/api/guest/${accessToken}`));
    ctx.setNow(T0 + STEP_MS);
    const second = await body(await ctx.app.request(`/api/guest/${accessToken}`));
    expect(second.code).not.toBe(first.code);
    expect(second.step).toBe(first.step + 1);
    ctx.setNow(T0 + STEP_MS + 100);
    const still = await body(await ctx.app.request(`/api/guest/${accessToken}`));
    expect(still.code).toBe(second.code);

    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const db = openDatabase(':memory:');
    const app = createApp({ db, hostToken: HOST, clock: () => Date.now() });
    const seeded = seed(db, T0);
    const live = await body(await app.request(`/api/guest/${seeded.accessToken}`));
    vi.setSystemTime(T0 + STEP_MS);
    const rotated = await body(await app.request(`/api/guest/${seeded.accessToken}`));
    expect(rotated.code).not.toBe(live.code);
    db.close();
  });

  it('serves the host, guest, and door pages', async () => {
    const ctx = setup();
    open.push(ctx);
    const { accessToken } = seed(ctx.db);
    const host = await ctx.app.request('/host');
    const door = await ctx.app.request('/door');
    const guest = await ctx.app.request(`/t/${accessToken}`);
    const css = await ctx.app.request('/styles.css');
    expect(host.status).toBe(200);
    expect(await host.text()).toContain('Host desk');
    expect(door.status).toBe(200);
    expect(await door.text()).toContain('html5-qrcode');
    expect(guest.status).toBe(200);
    expect(await guest.text()).toContain('Rotating entry code');
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    const scanner = await ctx.app.request('/vendor/html5-qrcode.min.js');
    expect(scanner.status).toBe(200);
    expect(await scanner.text()).toContain('Html5Qrcode');
  });

  it('approves a transfer only through the host API', async () => {
    const ctx = setup();
    open.push(ctx);
    const { event, accessToken } = seed(ctx.db);
    const before = await body(await ctx.app.request(`/api/guest/${accessToken}`));
    const requested = await ctx.app.request(`/api/guest/${accessToken}/transfers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to_name: 'Grace Hopper' }),
    });
    expect(requested.status).toBe(201);
    const still = await body(await ctx.app.request(`/api/guest/${accessToken}`));
    expect(still.guest_name).toBe('Ada Lovelace');
    expect(still.code).toBe(before.code);
    const transferId = (await body(requested)).transfer.id as string;
    const unauth = await ctx.app.request(`/api/host/transfers/${transferId}/approve`, { method: 'POST' });
    expect(unauth.status).toBe(401);
    const approved = await hostJson(ctx.app, `/api/host/transfers/${transferId}/approve`, {});
    expect(approved.status).toBe(200);
    expect(approved.json.ticket.guest_name).toBe('Grace Hopper');
    const oldGuest = await ctx.app.request(`/api/guest/${accessToken}`);
    expect(oldGuest.status).toBe(404);
    const scanOld = await ctx.app.request('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: event.id, code: before.code }),
    });
    expect(await body(scanOld)).toEqual({ result: 'reject', reason: 'invalid_code' });
    const token = approved.json.guest_path.replace('/t/', '');
    const fresh = await body(await ctx.app.request(`/api/guest/${token}`));
    const scanNew = await ctx.app.request('/api/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event_id: event.id, code: fresh.code }),
    });
    expect(await body(scanNew)).toMatchObject({ result: 'admit', guest_name: 'Grace Hopper' });
  });
});
