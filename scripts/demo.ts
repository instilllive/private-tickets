import { createApp } from '../src/app';
import { STEP_MS } from '../src/clock';
import { openDatabase } from '../src/db';
import { formatScanResult, type ScanResult } from '../src/format';

const hostToken = 'demo-host-token';
const start = 1_780_000_000_000;
let now = start;

const db = openDatabase(':memory:');
const app = createApp({ db, hostToken, clock: () => now });

async function api(path: string, init: { method?: string; body?: unknown; host?: boolean } = {}): Promise<any> {
  const headers: Record<string, string> = {};
  if (init.host) headers.authorization = `Bearer ${hostToken}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text}`);
  }
  return json;
}

const event = await api('/api/host/events', {
  host: true,
  body: {
    name: 'Listening room',
    starts_at: '2026-06-01T20:00:00.000Z',
    venue: 'June hall',
    host: 'Mark',
  },
});

const issued = await api(`/api/host/events/${event.event.id}/tickets`, {
  host: true,
  body: { guest_name: 'Ada Lovelace' },
});

now = start - STEP_MS * 3;
const staleView = await api(`/api/guest/${issued.guest_path.slice(3)}`);
now = start;
const liveView = await api(`/api/guest/${issued.guest_path.slice(3)}`);

async function scan(code: string): Promise<ScanResult> {
  return api('/api/scan', {
    method: 'POST',
    body: { event_id: event.event.id, code },
  });
}

const admitted = await scan(liveView.code);
const replayed = await scan(liveView.code);
const stale = await scan(staleView.code);

const lines = [
  formatScanResult(admitted),
  formatScanResult(replayed),
  formatScanResult(stale),
];

console.log('Private tickets demo');
console.log('');
console.log(`event: ${event.event.name} at ${event.event.venue}`);
console.log(`guest: ${issued.ticket.guest_name}`);
console.log('');
console.log(`live code:  ${liveView.code}`);
console.log(`stale code: ${staleView.code}  (minted ${STEP_MS * 3}ms earlier)`);
console.log('');
console.log(`scan live:  ${lines[0]}`);
console.log(`replay:     ${lines[1]}`);
console.log(`scan stale: ${lines[2]}`);

const expected = ['ADMIT Ada Lovelace', 'REJECTED: already used', 'REJECTED: expired'];
db.close();

if (lines.some((line, index) => line !== expected[index])) {
  console.error('');
  console.error('demo failed');
  console.error(`expected: ${expected.join(' | ')}`);
  process.exit(1);
}
