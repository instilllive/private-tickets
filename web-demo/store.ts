import { STEP_MS, stepAt, stepEndsAt } from '../src/clock';
import { readGuestCsv, cleanGuestName, type CsvRowError } from '../src/csv';
import { DEMO_EVENT, DEMO_EVENT_NAME } from '../src/demo-event';
import type { ScanResult } from '../src/format';
import {
  MAC_BYTES,
  admitTicket,
  formatCode,
  macMessage,
  parsePayload,
  rejectAtClaim,
  rejectBeforeClaim,
  stepWithinWindow,
} from '../src/protocol';

const STORAGE_KEY = 'breakpoint-door-demo-v1';
const DUMMY_SECRET = new Uint8Array(32);

export type Kv = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type DemoEvent = {
  id: string;
  name: string;
  startsAt: string;
  venue: string;
  host: string;
  createdAt: string;
};

export type DemoTicket = {
  id: string;
  eventId: string;
  guestName: string;
  email: string | null;
  handle: string | null;
  status: 'issued' | 'checked_in' | 'revoked';
  accessToken: string;
  createdAt: string;
  checkedInAt: string | null;
};

export type DemoTransfer = {
  id: string;
  ticketId: string;
  eventId: string;
  fromName: string;
  toName: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  resolvedAt: string | null;
};

export type GuestPass = {
  ticketId: string;
  guestName: string;
  status: DemoTicket['status'];
  event: DemoEvent;
  pendingTransfer: { id: string; toName: string } | null;
  step: number;
  stepMs: number;
  serverNow: number;
  stepEndsAt: number;
  code: string | null;
};

type TicketRecord = DemoTicket & { secret: string };

type State = {
  events: DemoEvent[];
  tickets: TicketRecord[];
  transfers: DemoTransfer[];
};

export type ImportOutcome =
  | { ok: true; created: DemoTicket[]; errors: CsvRowError[] }
  | { ok: false; error: 'not_found' | 'too_large' | 'missing_name_column' | 'duplicate_column' | 'too_many_rows' };

export function memoryKv(): Kv {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomSecret(): Uint8Array {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function hmacTag(secret: Uint8Array, ticketId: string, step: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret.slice(), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(macMessage(ticketId, step)));
  return new Uint8Array(signed).slice(0, MAC_BYTES);
}

function tagsEqual(expected: Uint8Array, provided: Uint8Array): boolean {
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) diff |= (expected[index] ?? 0) ^ (provided[index] ?? 0);
  return diff === 0;
}

function toPublic(ticket: TicketRecord): DemoTicket {
  return {
    id: ticket.id,
    eventId: ticket.eventId,
    guestName: ticket.guestName,
    email: ticket.email,
    handle: ticket.handle,
    status: ticket.status,
    accessToken: ticket.accessToken,
    createdAt: ticket.createdAt,
    checkedInAt: ticket.checkedInAt,
  };
}

function seedEvent(nowMs: number): DemoEvent {
  return {
    id: crypto.randomUUID(),
    name: DEMO_EVENT.name,
    startsAt: DEMO_EVENT.startsAt,
    venue: DEMO_EVENT.venue,
    host: DEMO_EVENT.host,
    createdAt: new Date(nowMs).toISOString(),
  };
}

function emptyState(nowMs: number): State {
  return { events: [seedEvent(nowMs)], tickets: [], transfers: [] };
}

export type DoorStore = ReturnType<typeof createDoorStore>;

export function createDoorStore(kv: Kv, nowMs = Date.now()) {
  let state = readState(kv, nowMs);

  function save(): void {
    kv.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function dinner(): DemoEvent {
    const found = state.events.find((event) => event.name === DEMO_EVENT_NAME) ?? state.events[0];
    if (!found) throw new Error('demo event missing');
    return found;
  }

  function ticketById(id: string): TicketRecord | null {
    return state.tickets.find((ticket) => ticket.id === id) ?? null;
  }

  save();

  return {
    dinner,
    events(): DemoEvent[] {
      return state.events.map((event) => ({ ...event }));
    },
    createEvent(input: { name: string; startsAt: string; venue: string; host: string }, at = nowMs): DemoEvent {
      const event: DemoEvent = {
        id: crypto.randomUUID(),
        name: input.name,
        startsAt: input.startsAt,
        venue: input.venue,
        host: input.host,
        createdAt: new Date(at).toISOString(),
      };
      state.events.push(event);
      save();
      return { ...event };
    },
    tickets(eventId: string): DemoTicket[] {
      return state.tickets.filter((ticket) => ticket.eventId === eventId).map(toPublic);
    },
    transfers(eventId: string): DemoTransfer[] {
      return state.transfers.filter((transfer) => transfer.eventId === eventId).map((transfer) => ({ ...transfer }));
    },
    secretOf(ticketId: string): Uint8Array | null {
      const ticket = ticketById(ticketId);
      return ticket ? base64ToBytes(ticket.secret) : null;
    },
    importCsv(eventId: string, csv: string, at: number): ImportOutcome {
      if (!state.events.some((event) => event.id === eventId)) return { ok: false, error: 'not_found' };
      const read = readGuestCsv(csv);
      if (!read.ok) return read;
      const created: DemoTicket[] = [];
      for (const guest of read.guests) {
        const record: TicketRecord = {
          id: crypto.randomUUID(),
          eventId,
          guestName: guest.name,
          email: guest.email,
          handle: guest.handle,
          status: 'issued',
          secret: bytesToBase64(randomSecret()),
          accessToken: randomToken(),
          createdAt: new Date(at).toISOString(),
          checkedInAt: null,
        };
        state.tickets.push(record);
        created.push(toPublic(record));
      }
      save();
      return { ok: true, created, errors: read.errors };
    },
    async codeAt(ticketId: string, step: number): Promise<string | null> {
      const ticket = ticketById(ticketId);
      if (!ticket) return null;
      const mac = await hmacTag(base64ToBytes(ticket.secret), ticket.id, step);
      return formatCode(ticket.id, step, mac);
    },
    async guestPass(ticketId: string, at: number): Promise<GuestPass | null> {
      const ticket = ticketById(ticketId);
      if (!ticket) return null;
      return passFor(ticket, at);
    },
    async guestPassByToken(accessToken: string, at: number): Promise<GuestPass | null> {
      const ticket = state.tickets.find((row) => row.accessToken === accessToken);
      if (!ticket) return null;
      return passFor(ticket, at);
    },
    async scan(code: string, at: number, eventId = dinner().id): Promise<ScanResult> {
      const parsed = parsePayload(code);
      if (!parsed) return { result: 'reject', reason: 'invalid_code' };
      const ticket = ticketById(parsed.ticketId);
      const secret = ticket ? base64ToBytes(ticket.secret) : DUMMY_SECRET;
      const mac = await hmacTag(secret, parsed.ticketId, parsed.step);
      const macOk = Boolean(ticket) && tagsEqual(mac, parsed.mac);
      const early = rejectBeforeClaim({
        macOk,
        inWindow: stepWithinWindow(parsed.step, at),
        eventMatches: ticket?.eventId === eventId,
      });
      if (early) return early;
      const current = ticketById(parsed.ticketId);
      const lockedSecret = current ? base64ToBytes(current.secret) : DUMMY_SECRET;
      const lockedMac = await hmacTag(lockedSecret, parsed.ticketId, parsed.step);
      const blocked = rejectAtClaim({
        present: Boolean(current),
        macOk: Boolean(current) && tagsEqual(lockedMac, parsed.mac),
        eventMatches: current?.eventId === eventId,
        status: current?.status ?? null,
      });
      if (blocked || !current) return blocked ?? { result: 'reject', reason: 'invalid_code' };
      current.status = 'checked_in';
      current.checkedInAt = new Date(at).toISOString();
      save();
      return admitTicket({
        id: current.id,
        eventId: current.eventId,
        guestName: current.guestName,
        status: 'issued',
      });
    },
    requestTransfer(
      ticketId: string,
      toName: string,
      at: number,
    ): { ok: true; transfer: DemoTransfer } | { ok: false; error: 'not_found' | 'not_transferable' | 'same_name' | 'pending_exists' | 'invalid_name' } {
      const named = cleanGuestName(toName);
      if (!named.ok) return { ok: false, error: 'invalid_name' };
      const ticket = ticketById(ticketId);
      if (!ticket) return { ok: false, error: 'not_found' };
      if (ticket.status !== 'issued') return { ok: false, error: 'not_transferable' };
      if (ticket.guestName === named.name) return { ok: false, error: 'same_name' };
      if (state.transfers.some((transfer) => transfer.ticketId === ticket.id && transfer.status === 'pending')) {
        return { ok: false, error: 'pending_exists' };
      }
      const transfer: DemoTransfer = {
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        eventId: ticket.eventId,
        fromName: ticket.guestName,
        toName: named.name,
        status: 'pending',
        createdAt: new Date(at).toISOString(),
        resolvedAt: null,
      };
      state.transfers.push(transfer);
      save();
      return { ok: true, transfer: { ...transfer } };
    },
    approveTransfer(
      transferId: string,
      at: number,
    ):
      | { ok: true; transfer: DemoTransfer; ticket: DemoTicket }
      | { ok: false; error: 'not_found' | 'not_pending' | 'not_transferable' } {
      const transfer = state.transfers.find((row) => row.id === transferId);
      if (!transfer) return { ok: false, error: 'not_found' };
      if (transfer.status !== 'pending') return { ok: false, error: 'not_pending' };
      const ticket = ticketById(transfer.ticketId);
      if (!ticket || ticket.status !== 'issued') {
        transfer.status = 'denied';
        transfer.resolvedAt = new Date(at).toISOString();
        save();
        return { ok: false, error: 'not_transferable' };
      }
      ticket.guestName = transfer.toName;
      ticket.email = null;
      ticket.handle = null;
      ticket.secret = bytesToBase64(randomSecret());
      ticket.accessToken = randomToken();
      transfer.status = 'approved';
      transfer.resolvedAt = new Date(at).toISOString();
      save();
      return { ok: true, transfer: { ...transfer }, ticket: toPublic(ticket) };
    },
    reset(at = Date.now()): DemoEvent {
      state = emptyState(at);
      save();
      return dinner();
    },
  };

  async function passFor(ticket: TicketRecord, at: number): Promise<GuestPass> {
    const event = state.events.find((row) => row.id === ticket.eventId);
    if (!event) throw new Error('ticket event missing');
    const pending = state.transfers.find((transfer) => transfer.ticketId === ticket.id && transfer.status === 'pending');
    const step = stepAt(at);
    const code = ticket.status === 'issued' ? await hmacTag(base64ToBytes(ticket.secret), ticket.id, step).then((mac) => formatCode(ticket.id, step, mac)) : null;
    return {
      ticketId: ticket.id,
      guestName: ticket.guestName,
      status: ticket.status,
      event: { ...event },
      pendingTransfer: pending ? { id: pending.id, toName: pending.toName } : null,
      step,
      stepMs: STEP_MS,
      serverNow: at,
      stepEndsAt: stepEndsAt(step),
      code,
    };
  }
}

function readState(kv: Kv, nowMs: number): State {
  const raw = kv.getItem(STORAGE_KEY);
  if (!raw) return emptyState(nowMs);
  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    if (!Array.isArray(parsed.events) || !Array.isArray(parsed.tickets) || !Array.isArray(parsed.transfers)) {
      return emptyState(nowMs);
    }
    const state: State = {
      events: parsed.events as DemoEvent[],
      tickets: parsed.tickets as TicketRecord[],
      transfers: parsed.transfers as DemoTransfer[],
    };
    if (!state.events.some((event) => event.name === DEMO_EVENT_NAME)) state.events.unshift(seedEvent(nowMs));
    return state;
  } catch {
    return emptyState(nowMs);
  }
}
