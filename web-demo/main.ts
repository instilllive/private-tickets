import QRCode from 'qrcode';
import sampleCsv from '../samples/breakpoint-guests.csv?raw';
import { stepAt } from '../src/clock';
import { REJECT_LABEL, type ScanResult } from '../src/format';
import { createDoorStore, memoryKv, type GuestPass, type Kv } from './store';

const ring = document.querySelector<SVGCircleElement>('#ring');
const radius = Number(ring?.getAttribute('r') ?? 54);
const circumference = 2 * Math.PI * radius;
if (ring) ring.style.strokeDasharray = `${circumference} ${circumference}`;

const store = createDoorStore(browserKv());
let selectedId = '';
let pass: GuestPass | null = null;
let scanning = false;
let queuedCode: string | null | undefined;
let camera: import('html5-qrcode').Html5Qrcode | null = null;

function browserKv(): Kv {
  try {
    const probe = 'breakpoint-door-probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    };
  } catch {
    return memoryKv();
  }
}

function note(message: string): void {
  const el = document.querySelector('#note');
  if (el) el.textContent = message;
}

function showScan(result: ScanResult): void {
  const box = document.querySelector('#result');
  const title = box?.querySelector('.result-title');
  const detail = box?.querySelector('.result-detail');
  if (!box || !title || !detail) return;
  if (result.result === 'admit') {
    box.className = 'result admit';
    title.textContent = 'ADMIT';
    detail.textContent = result.guest_name;
    return;
  }
  box.className = 'result reject';
  title.textContent = 'REJECTED';
  detail.textContent = REJECT_LABEL[result.reason];
}

async function drawTicket(): Promise<void> {
  const nameEl = document.querySelector('#guest-name');
  const statusEl = document.querySelector('#guest-status');
  const pendingEl = document.querySelector('#pending');
  const countdown = document.querySelector<HTMLElement>('#countdown');
  const form = document.querySelector<HTMLFormElement>('#transfer-form');
  const img = document.querySelector<HTMLImageElement>('#qr');
  if (!nameEl || !statusEl || !pendingEl || !countdown || !form || !img) return;
  if (!selectedId) {
    pass = null;
    nameEl.textContent = 'Choose a guest';
    statusEl.textContent = '';
    pendingEl.textContent = '';
    countdown.hidden = true;
    form.hidden = true;
    img.hidden = true;
    document.querySelector<HTMLElement>('.qr-stage')?.toggleAttribute('hidden', true);
    return;
  }
  pass = await store.guestPass(selectedId, Date.now());
  if (!pass) return;
  nameEl.textContent = pass.guestName;
  statusEl.textContent = pass.status === 'issued' ? 'Show this at the door' : pass.status === 'checked_in' ? 'Checked in' : 'Revoked';
  countdown.hidden = pass.status !== 'issued';
  form.hidden = pass.status !== 'issued';
  document.querySelector<HTMLElement>('.qr-stage')?.toggleAttribute('hidden', pass.status !== 'issued');
  pendingEl.textContent = pass.pendingTransfer
    ? `Transfer to ${pass.pendingTransfer.toName} is waiting for the host. Nothing changes until they approve.`
    : '';
  if (pass.code) {
    if (img.dataset.code !== pass.code) {
      img.src = await QRCode.toDataURL(pass.code, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
      img.dataset.code = pass.code;
    }
    img.hidden = false;
  } else {
    img.hidden = true;
    img.removeAttribute('src');
    delete img.dataset.code;
  }
}

function paintRing(): void {
  const remainEl = document.querySelector('#remain');
  if (!ring || !remainEl) return;
  if (!pass || pass.status !== 'issued') {
    ring.style.strokeDashoffset = String(circumference);
    remainEl.textContent = '–';
    return;
  }
  const remain = pass.stepEndsAt - Date.now();
  const fraction = Math.max(0, Math.min(1, remain / pass.stepMs));
  ring.style.strokeDashoffset = String(circumference * (1 - fraction));
  ring.classList.toggle('urgent', remain < 1000);
  remainEl.textContent = Math.max(0, remain / 1000).toFixed(1);
}

function renderLists(): void {
  const event = store.dinner();
  const meta = document.querySelector('#event-meta');
  const title = document.querySelector('#event-name');
  if (title) title.textContent = event.name;
  if (meta) {
    const when = new Date(event.startsAt).toLocaleString('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'Europe/London',
    });
    meta.textContent = `${event.venue} · ${when} · Host ${event.host}`;
  }
  const tickets = store.tickets(event.id);
  const count = document.querySelector('#tally-count');
  const label = document.querySelector('#tally-label');
  const checked = tickets.filter((ticket) => ticket.status === 'checked_in').length;
  if (count) count.textContent = String(checked);
  if (label) label.textContent = `of ${tickets.length} checked in`;
  const body = document.querySelector('#guests');
  if (!body) return;
  body.replaceChildren();
  if (tickets.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 2;
    cell.className = 'muted';
    cell.textContent = 'No guests yet. Import the sample list.';
    row.append(cell);
    body.append(row);
  }
  for (const ticket of tickets) {
    const row = document.createElement('tr');
    row.className = ticket.id === selectedId ? 'guest selected' : 'guest';
    const name = document.createElement('td');
    name.textContent = ticket.guestName;
    const extra = [ticket.email, ticket.handle].filter(Boolean).join(' · ');
    if (extra) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = extra;
      name.append(sub);
    }
    const status = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${ticket.status}`;
    pill.textContent = ticket.status === 'checked_in' ? 'checked in' : ticket.status === 'issued' ? 'not in yet' : 'revoked';
    status.append(pill);
    row.append(name, status);
    row.addEventListener('click', () => {
      selectedId = ticket.id;
      void render();
    });
    body.append(row);
  }
  const transfers = document.querySelector('#transfers');
  if (!transfers) return;
  transfers.replaceChildren();
  const pending = store.transfers(event.id).filter((transfer) => transfer.status === 'pending');
  if (pending.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No transfer is waiting.';
    transfers.append(empty);
  }
  for (const transfer of pending) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.textContent = `${transfer.fromName} → ${transfer.toName}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'approve';
    button.textContent = 'Approve transfer';
    button.addEventListener('click', () => {
      const result = store.approveTransfer(transfer.id, Date.now());
      if (!result.ok) {
        note(result.error);
        return;
      }
      note(`Approved. ${result.ticket.guestName} now holds this ticket. The old code is dead.`);
      showScanPlaceholder();
      const detail = document.querySelector('#result .result-detail');
      if (detail) detail.textContent = 'The new guest has a new code';
      void render();
    });
    row.append(text, button);
    transfers.append(row);
  }
}

async function render(): Promise<void> {
  renderLists();
  await drawTicket();
  paintRing();
}

function reportImport(created: number, errors: Array<{ line: number; reason: string }>, failure = ''): void {
  const report = document.querySelector('#import-report');
  const list = document.querySelector('#import-errors');
  if (!report || !list) return;
  list.replaceChildren();
  if (failure) {
    report.textContent = failure;
    return;
  }
  report.textContent = `${created} guests added. ${errors.length} rows need a fix.`;
  for (const error of errors) {
    const item = document.createElement('li');
    item.textContent = `Line ${error.line}: ${error.reason}`;
    list.append(item);
  }
}

function importText(csv: string): void {
  const result = store.importCsv(store.dinner().id, csv, Date.now());
  if (!result.ok) {
    reportImport(0, [], result.error.replaceAll('_', ' '));
    return;
  }
  reportImport(result.created.length, result.errors);
  const first = result.created[0];
  if (first && !selectedId) selectedId = first.id;
  note(result.errors.length ? 'Some rows were skipped.' : 'Guest list imported. Open a name to show their ticket.');
  void render();
}

async function submitCode(code: string | null): Promise<void> {
  if (scanning) {
    queuedCode = code;
    return;
  }
  scanning = true;
  if (camera) {
    try { camera.pause(true); } catch { /* already paused */ }
    window.setTimeout(() => {
      if (!camera) return;
      try { camera.resume(); } catch { /* camera stopped */ }
    }, 1200);
  }
  try {
    let next: string | null | undefined = code;
    while (next !== undefined) {
      const current = next;
      queuedCode = undefined;
      if (!current) showScan({ result: 'reject', reason: 'invalid_code' });
      else showScan(await store.scan(current, Date.now()));
      await render();
      next = queuedCode;
      queuedCode = undefined;
    }
  } finally {
    scanning = false;
  }
}

document.querySelector('#import-sample')?.addEventListener('click', () => {
  importText(sampleCsv);
});

document.querySelector<HTMLInputElement>('#csv-file')?.addEventListener('change', async (event) => {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  importText(await file.text());
  input.value = '';
});

document.querySelector('#transfer-form')?.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = document.querySelector<HTMLInputElement>('#transfer-name');
  if (!selectedId || !input) return;
  const result = store.requestTransfer(selectedId, input.value, Date.now());
  if (!result.ok) {
    note(result.error.replaceAll('_', ' '));
    return;
  }
  input.value = '';
  note(`Transfer to ${result.transfer.toName} is waiting for approval.`);
  void render();
});

document.querySelector('#scan-screen')?.addEventListener('click', () => {
  if (pass?.status === 'issued' && pass.code) {
    void submitCode(pass.code);
    return;
  }
  if (!selectedId) {
    void submitCode(null);
    return;
  }
  void store.codeAt(selectedId, stepAt(Date.now())).then((code) => submitCode(code));
});

document.querySelector('#scan-stale')?.addEventListener('click', async () => {
  if (!selectedId) return;
  const stale = await store.codeAt(selectedId, stepAt(Date.now()) - 3);
  await submitCode(stale);
});

document.querySelector('#camera')?.addEventListener('click', async () => {
  const state = document.querySelector('#camera-state');
  const button = document.querySelector<HTMLButtonElement>('#camera');
  if (!state || !button) return;
  button.disabled = true;
  try {
    const { Html5Qrcode } = await import('html5-qrcode');
    camera ??= new Html5Qrcode('reader');
    await camera.start(
      { facingMode: 'environment' },
      { fps: 8, qrbox: { width: 220, height: 220 } },
      (text) => { void submitCode(text); },
      () => {},
    );
    state.textContent = 'Camera on';
  } catch (error) {
    button.disabled = false;
    const message = error instanceof Error ? error.message : 'permission denied';
    state.textContent = `Camera unavailable (${message}). Use the button above.`;
  }
});

document.querySelector('#reset')?.addEventListener('click', () => {
  store.reset();
  selectedId = '';
  pass = null;
  reportImport(0, [], '');
  const report = document.querySelector('#import-report');
  if (report) report.textContent = '';
  showScanPlaceholder();
  note('Demo reset.');
  void render();
});

function showScanPlaceholder(): void {
  const box = document.querySelector('#result');
  const title = box?.querySelector('.result-title');
  const detail = box?.querySelector('.result-detail');
  if (!box || !title || !detail) return;
  box.className = 'result';
  title.textContent = 'Ready';
  detail.textContent = 'Scan a live code';
}

let refreshing = false;
function frame(): void {
  paintRing();
  const due = pass?.status === 'issued' && pass.stepEndsAt - Date.now() <= 40;
  if (due && !refreshing) {
    refreshing = true;
    void drawTicket().finally(() => {
      refreshing = false;
    });
  }
  requestAnimationFrame(frame);
}

void render();
requestAnimationFrame(frame);
