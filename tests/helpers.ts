import { createApp, type AppDeps } from '../src/app';
import { openDatabase, type DB } from '../src/db';
import { createEvent, issueTicket, type PublicEvent, type PublicTicket } from '../src/service';

export const HOST = 'test-host-token';
export const T0 = 1_780_000_000_000;

export type TestApp = {
  db: DB;
  app: ReturnType<typeof createApp>;
  now: number;
  setNow: (value: number) => void;
  close: () => void;
};

export function setup(start = T0, deps: Partial<AppDeps> = {}): TestApp {
  const db = openDatabase(':memory:');
  let now = start;
  const app = createApp({
    db,
    hostToken: HOST,
    clock: () => now,
    ...deps,
  });
  return {
    db,
    app,
    get now() {
      return now;
    },
    setNow(value: number) {
      now = value;
    },
    close() {
      db.close();
    },
  };
}

export function seed(db: DB, now = T0, guestName = 'Ada Lovelace'): {
  event: PublicEvent;
  ticket: PublicTicket;
  accessToken: string;
} {
  const event = createEvent(db, {
    name: 'Listening room',
    startsAt: '2026-06-01T20:00:00.000Z',
    venue: 'June hall',
    host: 'Mark',
    nowMs: now,
  });
  const issued = issueTicket(db, { eventId: event.id, guestName, nowMs: now });
  if ('error' in issued) throw new Error(issued.error);
  return { event, ticket: issued.ticket, accessToken: issued.accessToken };
}

export async function hostJson(
  app: ReturnType<typeof createApp>,
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method,
    headers: {
      authorization: `Bearer ${HOST}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
