import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { systemClock, type Clock } from './clock';
import type { DB } from './db';
import {
  approveTransfer,
  createEvent,
  guestView,
  issueTicket,
  listEvents,
  listTickets,
  listTransfers,
  requestTransfer,
  revokeTicket,
  scanCode,
} from './service';

export type AppDeps = {
  db: DB;
  hostToken: string;
  clock?: Clock;
  publicDir?: string;
};

const NAME_MAX = 120;

function cleanText(value: unknown, max = NAME_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > max) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

function cleanStartsAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function hostAuthorized(authorization: string | undefined, hostToken: string): boolean {
  if (!authorization) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!match?.[1]) return false;
  return tokensEqual(match[1], hostToken);
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

function page(publicDir: string, name: string): string {
  return readFileSync(join(publicDir, name), 'utf8');
}

const STATIC_FILES: Record<string, string> = {
  '/styles.css': 'text/css; charset=utf-8',
  '/host.js': 'text/javascript; charset=utf-8',
  '/guest.js': 'text/javascript; charset=utf-8',
  '/door.js': 'text/javascript; charset=utf-8',
  '/vendor/html5-qrcode.min.js': 'text/javascript; charset=utf-8',
};

export function createApp(deps: AppDeps): Hono {
  if (typeof deps.hostToken !== 'string' || deps.hostToken.length === 0) {
    throw new Error('hostToken is required');
  }
  const clock = deps.clock ?? systemClock;
  const publicDir = deps.publicDir ?? join(process.cwd(), 'public');
  const app = new Hono();

  app.onError((error, c) => {
    console.error(error instanceof Error ? error.message : 'request failed');
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/api/events', (c) => c.json({ events: listEvents(deps.db) }));

  app.post('/api/scan', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const eventId = cleanText(body.event_id, 80);
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!eventId || code.length === 0) return c.json({ error: 'invalid_body' }, 400);
    const result = scanCode(deps.db, { eventId, code, nowMs: clock() });
    c.header('cache-control', 'no-store');
    return c.json(result);
  });

  app.get('/api/guest/:token', async (c) => {
    const view = await guestView(deps.db, c.req.param('token'), clock());
    if (!view) return c.json({ error: 'not_found' }, 404);
    c.header('cache-control', 'no-store');
    return c.json(view);
  });

  app.post('/api/guest/:token/transfers', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const toName = cleanText(body.to_name);
    if (!toName) return c.json({ error: 'invalid_name' }, 400);
    const result = requestTransfer(deps.db, {
      accessToken: c.req.param('token'),
      toName,
      nowMs: clock(),
    });
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json({ transfer: result.transfer }, 201);
  });

  const host = new Hono();
  host.use('*', async (c, next) => {
    if (!hostAuthorized(c.req.header('authorization'), deps.hostToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  host.post('/events', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const name = cleanText(body.name);
    const venue = cleanText(body.venue);
    const host = cleanText(body.host);
    const startsAt = cleanStartsAt(body.starts_at);
    if (!name || !venue || !host || !startsAt) return c.json({ error: 'invalid_body' }, 400);
    const event = createEvent(deps.db, { name, startsAt, venue, host, nowMs: clock() });
    return c.json({ event }, 201);
  });

  host.post('/events/:eventId/tickets', async (c) => {
    const body = await readJson(c);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const guestName = cleanText(body.guest_name);
    if (!guestName) return c.json({ error: 'invalid_name' }, 400);
    const result = issueTicket(deps.db, {
      eventId: c.req.param('eventId'),
      guestName,
      nowMs: clock(),
    });
    if ('error' in result) return c.json({ error: result.error }, 404);
    return c.json({ ticket: result.ticket, guest_path: result.ticket.guest_path }, 201);
  });

  host.get('/events/:eventId/tickets', (c) => {
    const tickets = listTickets(deps.db, c.req.param('eventId'));
    if (!tickets) return c.json({ error: 'not_found' }, 404);
    return c.json({ tickets });
  });

  host.get('/events/:eventId/transfers', (c) => {
    const transfers = listTransfers(deps.db, c.req.param('eventId'));
    if (!transfers) return c.json({ error: 'not_found' }, 404);
    return c.json({ transfers });
  });

  host.post('/tickets/:ticketId/revoke', (c) => {
    const result = revokeTicket(deps.db, c.req.param('ticketId'));
    if ('error' in result) {
      const status = result.error === 'not_found' ? 404 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json({ ticket: result });
  });

  host.post('/transfers/:transferId/approve', (c) => {
    const result = approveTransfer(deps.db, c.req.param('transferId'), clock());
    if (!result.ok) {
      const status = result.error === 'not_found' ? 404 : 409;
      return c.json({ error: result.error }, status);
    }
    return c.json({
      transfer: result.transfer,
      ticket: result.ticket,
      guest_path: result.ticket.guest_path,
    });
  });

  app.route('/api/host', host);

  app.get('/', (c) => c.html(page(publicDir, 'index.html')));
  app.get('/host', (c) => c.html(page(publicDir, 'host.html')));
  app.get('/door', (c) => c.html(page(publicDir, 'door.html')));
  app.get('/t/:token', (c) => c.html(page(publicDir, 'guest.html')));

  for (const [route, contentType] of Object.entries(STATIC_FILES)) {
    app.get(route, (c) => {
      const body = readFileSync(join(publicDir, route.slice(1)), 'utf8');
      c.header('content-type', contentType);
      c.header('cache-control', 'no-cache');
      return c.body(body);
    });
  }

  return app;
}
