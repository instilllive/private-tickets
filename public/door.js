const eventSelect = document.querySelector('#event');
const resultEl = document.querySelector('#result');
const cameraButton = document.querySelector('#camera');
const cameraState = document.querySelector('#camera-state');
const eventLock = document.querySelector('#event-lock');
const hostLink = document.querySelector('#host-link');
const params = new URLSearchParams(location.search);
const staffMatch = location.pathname.match(/^\/door\/s\/([^/]+)$/);
const staffToken = staffMatch ? decodeURIComponent(staffMatch[1]) : '';

let scanner = null;
let busy = false;

function show(kind, title, reason) {
  resultEl.className = `result ${kind}`;
  resultEl.replaceChildren();
  resultEl.append(title);
  if (reason) {
    const line = document.createElement('span');
    line.className = 'reason';
    line.textContent = reason;
    resultEl.append(line);
  }
}

const REASONS = {
  invalid_code: 'invalid code',
  expired: 'expired',
  wrong_event: 'wrong event',
  revoked: 'revoked',
  already_used: 'already used',
};

async function loadEvents() {
  if (staffToken) {
    const res = await fetch(`/api/staff/${encodeURIComponent(staffToken)}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    eventSelect.replaceChildren();
    if (!res.ok) {
      show('reject', 'REJECTED', 'this door link is not active');
      cameraButton.disabled = true;
      return;
    }
    const option = document.createElement('option');
    option.value = data.event.id;
    option.textContent = `${data.event.name} · ${data.event.venue}`;
    eventSelect.append(option);
    eventSelect.disabled = true;
    eventLock.hidden = false;
    eventLock.textContent = `${data.event.name} · scan only`;
    hostLink.hidden = true;
    return;
  }
  const res = await fetch('/api/events');
  const data = await res.json();
  eventSelect.replaceChildren();
  for (const event of data.events || []) {
    const option = document.createElement('option');
    option.value = event.id;
    option.textContent = `${event.name} · ${event.venue}`;
    eventSelect.append(option);
  }
  const wanted = params.get('event');
  if (wanted && [...eventSelect.options].some((option) => option.value === wanted)) {
    eventSelect.value = wanted;
  }
  if (!eventSelect.value && eventSelect.options.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No events yet';
    eventSelect.append(option);
  }
}

async function submit(code) {
  const eventId = eventSelect.value;
  if (!eventId) {
    show('reject', 'REJECTED', 'pick an event');
    return;
  }
  const res = await fetch(staffToken ? `/api/staff/${encodeURIComponent(staffToken)}/scan` : '/api/scan', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(staffToken ? { code } : { event_id: eventId, code }),
  });
  const data = await res.json();
  if (!res.ok) {
    show('reject', 'REJECTED', data.error || 'request failed');
    return;
  }
  if (data.result === 'admit') {
    show('admit', 'ADMIT', data.guest_name);
    return;
  }
  show('reject', 'REJECTED', REASONS[data.reason] || data.reason);
}

async function onCode(text) {
  if (busy) return;
  busy = true;
  if (scanner) {
    try { scanner.pause(true); } catch { /* already paused */ }
  }
  try {
    await submit(text);
  } catch (error) {
    show('reject', 'REJECTED', error.message);
  } finally {
    setTimeout(() => {
      busy = false;
      if (scanner) {
        try { scanner.resume(); } catch { /* camera stopped */ }
      }
    }, 1200);
  }
}

cameraButton.addEventListener('click', async () => {
  if (typeof Html5Qrcode === 'undefined') {
    cameraState.textContent = 'Scanner library failed to load. Paste a code instead.';
    return;
  }
  cameraButton.disabled = true;
  try {
    if (!scanner) scanner = new Html5Qrcode('reader');
    await scanner.start(
      { facingMode: 'environment' },
      { fps: 8, qrbox: { width: 240, height: 240 } },
      (text) => { onCode(text); },
      () => {},
    );
    cameraState.textContent = 'Camera on';
  } catch (error) {
    cameraButton.disabled = false;
    cameraState.textContent = `Camera unavailable (${error.message || 'permission denied'}). Paste a code instead.`;
  }
});

document.querySelector('#manual').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = new FormData(event.currentTarget).get('code');
  if (typeof code !== 'string' || code.trim() === '') return;
  try {
    await submit(code.trim());
  } catch (error) {
    show('reject', 'REJECTED', error.message);
  }
});

loadEvents().catch((error) => {
  cameraState.textContent = error.message;
});
