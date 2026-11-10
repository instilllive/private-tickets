import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createEvent } from '../src/service';
import { hostJson, setup, T0 } from './helpers';

const CSV = `name,email,handle
Ada Lovelace,ada@example.com,@ada
"Hopper, Grace",grace@example.com,@grace
,missing@example.com,@nope
${'N'.repeat(121)},long@example.com,@long
Bob,not-an-email,@bob
Cara,cara@example.com,bad handle!
Priya Raman,,@priya
`;

describe('csv import', () => {
  it('creates named tickets and reports bad rows', async () => {
    const ctx = setup();
    const created = await hostJson(ctx.app, '/api/host/events', {
      name: 'Dinner',
      starts_at: '2026-11-16T19:00:00.000Z',
      venue: 'Olympia',
      host: 'Nia',
    });
    const eventId = created.json.event.id as string;
    const imported = await hostJson(ctx.app, `/api/host/events/${eventId}/import`, { csv: CSV });
    expect(imported.status).toBe(200);
    expect(imported.json.created.map((ticket: { guest_name: string }) => ticket.guest_name)).toEqual([
      'Ada Lovelace',
      'Hopper, Grace',
      'Priya Raman',
    ]);
    expect(imported.json.created[0].email).toBe('ada@example.com');
    expect(imported.json.created[0].handle).toBe('@ada');
    expect(imported.json.created[2].email).toBeNull();
    expect(imported.json.errors).toEqual([
      { line: 4, reason: 'Name is required' },
      { line: 5, reason: 'Name is too long' },
      { line: 6, reason: 'Email is not valid' },
      { line: 7, reason: 'Handle is not valid' },
    ]);
    const list = await hostJson(ctx.app, `/api/host/events/${eventId}/tickets`);
    expect(list.json.tickets).toHaveLength(3);
    ctx.close();
  });

  it('accepts a header with the name column elsewhere and a file with no header', async () => {
    const ctx = setup();
    const event = createEvent(ctx.db, {
      name: 'Dinner',
      startsAt: '2026-11-16T19:00:00.000Z',
      venue: 'Olympia',
      host: 'Nia',
      nowMs: T0,
    });
    const swapped = await hostJson(ctx.app, `/api/host/events/${event.id}/import`, {
      csv: 'email,name\nleo@example.com,Leo Martins\n',
    });
    expect(swapped.status).toBe(200);
    expect(swapped.json.created[0].guest_name).toBe('Leo Martins');
    expect(swapped.json.created[0].email).toBe('leo@example.com');
    const positional = await hostJson(ctx.app, `/api/host/events/${event.id}/import`, {
      csv: 'Nora Blake\n',
    });
    expect(positional.json.created[0].guest_name).toBe('Nora Blake');
    expect(positional.json.created[0].email).toBeNull();
    expect(positional.json.created[0].handle).toBeNull();
    ctx.close();
  });

  it('rejects a header that has no name column and does not issue tickets', async () => {
    const ctx = setup();
    const event = createEvent(ctx.db, {
      name: 'Dinner',
      startsAt: '2026-11-16T19:00:00.000Z',
      venue: 'Olympia',
      host: 'Nia',
      nowMs: T0,
    });
    const missing = await hostJson(ctx.app, `/api/host/events/${event.id}/import`, {
      csv: 'email,handle\nada@example.com,@ada\n',
    });
    expect(missing.status).toBe(400);
    expect(missing.json.error).toBe('missing_name_column');
    const list = await hostJson(ctx.app, `/api/host/events/${event.id}/tickets`);
    expect(list.json.tickets).toHaveLength(0);
    const denied = await ctx.app.request(`/api/host/events/${event.id}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ csv: 'name\nAda\n' }),
    });
    expect(denied.status).toBe(401);
    ctx.close();
  });

  it('imports the Breakpoint sample list', async () => {
    const ctx = setup();
    const event = createEvent(ctx.db, {
      name: 'Dinner',
      startsAt: '2026-11-16T19:00:00.000Z',
      venue: 'Olympia',
      host: 'Nia',
      nowMs: T0,
    });
    const csv = readFileSync(new URL('../samples/breakpoint-guests.csv', import.meta.url), 'utf8');
    const imported = await hostJson(ctx.app, `/api/host/events/${event.id}/import`, { csv });
    expect(imported.status).toBe(200);
    expect(imported.json.errors).toEqual([]);
    expect(imported.json.created).toHaveLength(12);
    expect(imported.json.created[0].guest_name).toBe('Amira Shah');
    expect(imported.json.created[4].guest_name).toBe('Nora Blake');
    expect(imported.json.created[4].email).toBeNull();
    ctx.close();
  });
});
