import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEMO_EVENT, DEMO_EVENT_NAME } from '../src/demo-event';
import { openDatabase, type EventRow } from '../src/db';
import { loadEnvFile } from '../src/env';
import { createEvent, createStaffToken, importGuests, listStaff, listTickets } from '../src/service';

loadEnvFile(resolve(process.cwd(), '.env'));

const databasePath = process.env.DATABASE_PATH ?? './data/tickets.db';
const db = openDatabase(databasePath === ':memory:' ? databasePath : resolve(databasePath));
const now = Date.now();
const csv = readFileSync(resolve(process.cwd(), 'samples/breakpoint-guests.csv'), 'utf8');

const existing = db.prepare('SELECT * FROM events WHERE name = ? ORDER BY created_at ASC').get(DEMO_EVENT_NAME) as
  | EventRow
  | undefined;

let eventId: string;
if (existing) {
  eventId = existing.id;
  console.log('Demo event already exists. Leaving the guest list as it is.');
} else {
  const event = createEvent(db, {
    name: DEMO_EVENT.name,
    startsAt: DEMO_EVENT.startsAt,
    venue: DEMO_EVENT.venue,
    host: DEMO_EVENT.host,
    nowMs: now,
  });
  eventId = event.id;
  const imported = importGuests(db, { eventId, csv, nowMs: now });
  if (!imported.ok) {
    console.error(imported.error);
    process.exit(1);
  }
  console.log(`Imported ${imported.created.length} guests.`);
  for (const error of imported.errors) console.log(`line ${error.line}: ${error.reason}`);
}

const staffList = listStaff(db, eventId) ?? [];
let doorPath = staffList.find((staff) => !staff.revoked_at)?.door_path;
if (!doorPath) {
  const created = createStaffToken(db, { eventId, label: 'Front door', nowMs: now });
  if ('error' in created) {
    console.error(created.error);
    process.exit(1);
  }
  doorPath = created.door_path;
}

const tickets = listTickets(db, eventId) ?? [];
console.log('');
console.log(DEMO_EVENT_NAME);
console.log(`${DEMO_EVENT.venue} · ${DEMO_EVENT.host}`);
console.log(`guests: ${tickets.length}`);
console.log(`door staff: ${doorPath}`);
console.log('');
for (const ticket of tickets) {
  const contact = [ticket.email, ticket.handle].filter(Boolean).join(' ');
  console.log(`${ticket.guest_name}${contact ? `  ${contact}` : ''}  ${ticket.guest_path}`);
}
db.close();
