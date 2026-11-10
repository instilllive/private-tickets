const token = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
const eventName = document.querySelector('#event-name');
const whenEl = document.querySelector('#when');
const placeEl = document.querySelector('#place');
const guestName = document.querySelector('#guest-name');
const statusEl = document.querySelector('#status');
const qr = document.querySelector('#qr');
const remainEl = document.querySelector('#remain');
const codeEl = document.querySelector('#code');
const pendingEl = document.querySelector('#pending');
const holdEl = document.querySelector('#hold');
const form = document.querySelector('#transfer');
const errorEl = document.querySelector('#error');
const countdown = document.querySelector('#countdown');
const ring = document.querySelector('#ring');
const ringRadius = Number(ring?.getAttribute('r') || 54);
const ringLength = 2 * Math.PI * ringRadius;
if (ring) ring.style.strokeDasharray = `${ringLength} ${ringLength}`;
let stepMs = 5000;

let stepEndsAt = 0;
let skew = 0;
let status = '';
let fetching = false;
let nextFetchAt = 0;
let nextStatusAt = 0;

function localNow() {
  return Date.now() + skew;
}

async function load() {
  if (fetching) return;
  fetching = true;
  try {
    const res = await fetch(`/api/guest/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (res.status === 404) {
      eventName.textContent = 'Ticket not found';
      status = '';
      qr.hidden = true;
      form.hidden = true;
      countdown.hidden = true;
      return;
    }
    const data = await res.json();
    if (!res.ok) {
      errorEl.textContent = data.error || 'Could not load this ticket';
      return;
    }
    errorEl.textContent = '';
    skew = data.server_now - Date.now();
    stepEndsAt = data.step_ends_at;
    stepMs = data.step_ms || 5000;
    status = data.status;
    eventName.textContent = data.event.name;
    whenEl.textContent = new Date(data.event.starts_at).toLocaleString();
    placeEl.textContent = `${data.event.venue} · Host ${data.event.host}`;
    guestName.textContent = data.guest_name;
    statusEl.textContent = data.status.replaceAll('_', ' ');
    document.title = `${data.guest_name} · ${data.event.name}`;
    const live = data.status === 'issued' && data.qr_data_url;
    qr.hidden = !live;
    countdown.hidden = !live;
    holdEl.hidden = !live;
    codeEl.hidden = !live;
    if (live) {
      if (codeEl.textContent !== data.code) {
        qr.src = data.qr_data_url;
        codeEl.textContent = data.code;
      }
    } else {
      qr.removeAttribute('src');
      codeEl.textContent = '';
    }
    form.hidden = data.status !== 'issued';
    if (data.pending_transfer) {
      pendingEl.textContent = `Transfer to ${data.pending_transfer.to_name} is waiting for the host. Nothing changes until they approve.`;
    } else {
      pendingEl.textContent = '';
    }
    nextStatusAt = Date.now() + 1000;
  } catch (error) {
    errorEl.textContent = error.message;
  } finally {
    fetching = false;
  }
}

function frame() {
  const remain = stepEndsAt - localNow();
  remainEl.textContent = stepEndsAt ? Math.max(0, remain / 1000).toFixed(1) : '–';
  if (ring) {
    const fraction = stepEndsAt ? Math.max(0, Math.min(1, remain / stepMs)) : 0;
    ring.style.strokeDashoffset = String(ringLength * (1 - fraction));
    ring.classList.toggle('urgent', remain < 1000);
  }
  const dueForStep = status === 'issued' && stepEndsAt && remain <= 40 && Date.now() >= nextFetchAt;
  const dueForStatus = status === 'issued' && Date.now() >= nextStatusAt;
  if (dueForStep || dueForStatus) {
    nextFetchAt = Date.now() + 400;
    nextStatusAt = Date.now() + 1000;
    load();
  }
  requestAnimationFrame(frame);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const toName = new FormData(form).get('to_name');
  errorEl.textContent = '';
  const res = await fetch(`/api/guest/${encodeURIComponent(token)}/transfers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to_name: toName }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    errorEl.textContent = data.error || 'Transfer request failed';
    return;
  }
  form.reset();
  await load();
});

load();
requestAnimationFrame(frame);
