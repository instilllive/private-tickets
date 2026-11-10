import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

export type DB = BetterSqlite3.Database;

export type TicketStatus = 'issued' | 'checked_in' | 'revoked';
export type TransferStatus = 'pending' | 'approved' | 'denied';

export type EventRow = {
  id: string;
  name: string;
  starts_at: string;
  venue: string;
  host: string;
  created_at: string;
};

export type TicketRow = {
  id: string;
  event_id: string;
  guest_name: string;
  email: string | null;
  handle: string | null;
  status: TicketStatus;
  secret: Buffer;
  access_token: string;
  created_at: string;
  checked_in_at: string | null;
};

export type StaffRow = {
  id: string;
  event_id: string;
  token: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
};

export type TransferRow = {
  id: string;
  ticket_id: string;
  event_id: string;
  from_name: string;
  to_name: string;
  status: TransferStatus;
  created_at: string;
  resolved_at: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  venue TEXT NOT NULL,
  host TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  guest_name TEXT NOT NULL,
  email TEXT,
  handle TEXT,
  status TEXT NOT NULL CHECK (status IN ('issued', 'checked_in', 'revoked')),
  secret BLOB NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  checked_in_at TEXT
);

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS staff_tokens (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  token TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);
CREATE INDEX IF NOT EXISTS idx_transfers_event ON transfers(event_id);
CREATE INDEX IF NOT EXISTS idx_transfers_ticket ON transfers(ticket_id);
CREATE INDEX IF NOT EXISTS idx_staff_event ON staff_tokens(event_id);
`;

function tableColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function migrate(db: DB): void {
  const tickets = tableColumns(db, 'tickets');
  if (!tickets.has('email')) db.exec('ALTER TABLE tickets ADD COLUMN email TEXT');
  if (!tickets.has('handle')) db.exec('ALTER TABLE tickets ADD COLUMN handle TEXT');
}

export function openDatabase(filename = ':memory:'): DB {
  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (filename !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

function asBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('expected ticket secret to be stored as bytes');
}

export function mapTicket(row: Record<string, unknown>): TicketRow {
  return {
    id: String(row.id),
    event_id: String(row.event_id),
    guest_name: String(row.guest_name),
    email: row.email == null ? null : String(row.email),
    handle: row.handle == null ? null : String(row.handle),
    status: row.status as TicketStatus,
    secret: asBuffer(row.secret),
    access_token: String(row.access_token),
    created_at: String(row.created_at),
    checked_in_at: row.checked_in_at == null ? null : String(row.checked_in_at),
  };
}

export function getEvent(db: DB, id: string): EventRow | null {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined;
  return row ?? null;
}

export function getTicket(db: DB, id: string): TicketRow | null {
  const row = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapTicket(row) : null;
}

export function getTicketByAccess(db: DB, accessToken: string): TicketRow | null {
  const row = db.prepare('SELECT * FROM tickets WHERE access_token = ?').get(accessToken) as
    | Record<string, unknown>
    | undefined;
  return row ? mapTicket(row) : null;
}
