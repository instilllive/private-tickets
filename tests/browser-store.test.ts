import { describe, expect, it } from 'vitest';
import { STEP_MS, stepAt } from '../src/clock';
import { computeMac, mintCode } from '../src/codes';
import { DEMO_EVENT_NAME } from '../src/demo-event';
import { createDoorStore, hmacTag, memoryKv } from '../web-demo/store';

const NOW = 1_780_000_000_000;

describe('browser door store', () => {
  it('uses the same HMAC tag as the server', async () => {
    const secret = new Uint8Array(32);
    crypto.getRandomValues(secret);
    const ticketId = crypto.randomUUID();
    const web = await hmacTag(secret, ticketId, 42);
    const node = computeMac(Buffer.from(secret), ticketId, 42);
    expect(Buffer.from(web).equals(node)).toBe(true);
  });

  it('seeds the Breakpoint dinner and imports good rows while reporting bad ones', () => {
    const store = createDoorStore(memoryKv(), NOW);
    expect(store.dinner().name).toBe(DEMO_EVENT_NAME);
    const csv = `name,email,handle
Amira Shah,amira@example.com,@amira
,missing@example.com,@no
Bob,not-an-email,@bob
`;
    const imported = store.importCsv(store.dinner().id, csv, NOW);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.created.map((ticket) => ticket.guestName)).toEqual(['Amira Shah']);
    expect(imported.errors.map((error) => error.reason)).toEqual(['Name is required', 'Email is not valid']);
    expect(store.tickets(store.dinner().id)).toHaveLength(1);
    const again = createDoorStore(memoryKv(), NOW);
    again.importCsv(again.dinner().id, csv, NOW);
    const saved = memoryKv();
    const first = createDoorStore(saved, NOW);
    first.importCsv(first.dinner().id, 'name\nNora Blake\n', NOW);
    const reloaded = createDoorStore(saved, NOW);
    expect(reloaded.tickets(reloaded.dinner().id).map((ticket) => ticket.guestName)).toEqual(['Nora Blake']);
  });

  it('admits a server-minted code once, rejects the replay, and rejects a stale code', async () => {
    const store = createDoorStore(memoryKv(), NOW);
    const imported = store.importCsv(store.dinner().id, 'name\nAmira Shah\nJonah Ellison\n', NOW);
    if (!imported.ok) throw new Error('import failed');
    const amira = imported.created[0];
    const jonah = imported.created[1];
    if (!amira || !jonah) throw new Error('missing guests');
    const secret = store.secretOf(amira.id);
    if (!secret) throw new Error('missing secret');
    const live = mintCode(Buffer.from(secret), amira.id, stepAt(NOW));
    expect(await store.scan(live, NOW)).toMatchObject({ result: 'admit', guest_name: 'Amira Shah' });
    expect(await store.scan(live, NOW)).toEqual({ result: 'reject', reason: 'already_used' });
    expect(store.tickets(store.dinner().id).find((ticket) => ticket.id === amira.id)?.status).toBe('checked_in');

    const stale = await store.codeAt(jonah.id, stepAt(NOW) - 3);
    if (!stale) throw new Error('missing stale code');
    expect(await store.scan(stale, NOW)).toEqual({ result: 'reject', reason: 'expired' });
    expect(store.tickets(store.dinner().id).find((ticket) => ticket.id === jonah.id)?.status).toBe('issued');
    const stillLive = await store.codeAt(jonah.id, stepAt(NOW));
    if (!stillLive) throw new Error('missing live code');
    expect((await store.scan(stillLive, NOW)).result).toBe('admit');
  });

  it('does not check in a ticket from another event', async () => {
    const store = createDoorStore(memoryKv(), NOW);
    const other = store.createEvent({
      name: 'Somewhere else',
      startsAt: '2026-11-17T19:00:00.000Z',
      venue: 'Elsewhere',
      host: 'Nia',
    });
    const imported = store.importCsv(other.id, 'name\nOutside Guest\n', NOW);
    if (!imported.ok || !imported.created[0]) throw new Error('import failed');
    const code = await store.codeAt(imported.created[0].id, stepAt(NOW));
    if (!code) throw new Error('missing code');
    expect(await store.scan(code, NOW)).toEqual({ result: 'reject', reason: 'wrong_event' });
    expect(store.tickets(other.id)[0]?.status).toBe('issued');
  });

  it('keeps the old code dead until the host approves a transfer, then rotates it', async () => {
    const store = createDoorStore(memoryKv(), NOW);
    const imported = store.importCsv(store.dinner().id, 'name,email\nPriya Raman,priya@example.com\n', NOW);
    if (!imported.ok || !imported.created[0]) throw new Error('import failed');
    const ticket = imported.created[0];
    const before = await store.guestPass(ticket.id, NOW);
    const requested = store.requestTransfer(ticket.id, 'Mina Patel', NOW);
    expect(requested.ok).toBe(true);
    const waiting = await store.guestPass(ticket.id, NOW);
    expect(waiting?.guestName).toBe('Priya Raman');
    expect(waiting?.code).toBe(before?.code);
    expect(waiting?.pendingTransfer?.toName).toBe('Mina Patel');
    if (!requested.ok) return;
    const oldToken = ticket.accessToken;
    const approved = store.approveTransfer(requested.transfer.id, NOW + 10);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.ticket.guestName).toBe('Mina Patel');
    expect(approved.ticket.email).toBeNull();
    expect(approved.ticket.accessToken).not.toBe(oldToken);
    expect(await store.guestPassByToken(oldToken, NOW + 10)).toBeNull();
    expect(await store.scan(before?.code ?? '', NOW + 10)).toEqual({ result: 'reject', reason: 'invalid_code' });
    const fresh = await store.guestPass(ticket.id, NOW + STEP_MS);
    expect(fresh?.guestName).toBe('Mina Patel');
    expect(fresh?.code).toBeTruthy();
    expect(fresh?.code).not.toBe(before?.code);
    expect(await store.scan(fresh?.code ?? '', NOW + STEP_MS)).toMatchObject({
      result: 'admit',
      guest_name: 'Mina Patel',
    });
  });
});
