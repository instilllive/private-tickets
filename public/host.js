const tokenInput = document.querySelector('#token');
const authState = document.querySelector('#auth-state');
const flash = document.querySelector('#flash');
const eventSelect = document.querySelector('#event');
const guestsBody = document.querySelector('#guests');
const transfersEl = document.querySelector('#transfers');
const issuedLink = document.querySelector('#issued-link');
const doorLink = document.querySelector('#door-link');
const tallyCount = document.querySelector('#tally-count');
const tallyLabel = document.querySelector('#tally-label');
const importReport = document.querySelector('#import-report');
const staffLinks = document.querySelector('#staff-links');

const TOKEN_KEY = 'private-tickets-host-token';
const EVENT_KEY = 'private-tickets-event';

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function say(message) {
  flash.textContent = message || '';
}

async function api(method, path, body) {
  const headers = { authorization: `Bearer ${token()}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) {
    authState.textContent = 'Token rejected';
  } else if (token()) {
    authState.textContent = 'Token ready';
  }
  if (!res.ok) {
    const error = data && data.error ? data.error : `HTTP ${res.status}`;
    throw new Error(error);
  }
  return data;
}

function selectedEventId() {
  return eventSelect.value;
}

async function fillEvents(preferId) {
  const res = await fetch('/api/events');
  const data = await res.json();
  const events = data.events || [];
  eventSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = events.length ? 'Select an event' : 'No events yet';
  eventSelect.append(placeholder);
  for (const event of events) {
    const option = document.createElement('option');
    option.value = event.id;
    option.textContent = `${event.name} · ${event.venue}`;
    eventSelect.append(option);
  }
  const wanted = preferId || sessionStorage.getItem(EVENT_KEY) || selectedEventId();
  if (wanted && [...eventSelect.options].some((option) => option.value === wanted)) {
    eventSelect.value = wanted;
  } else {
    const first = [...eventSelect.options].find((option) => option.value);
    if (first) eventSelect.value = first.value;
  }
  updateDoorLink();
}

function updateDoorLink() {
  const id = selectedEventId();
  if (id) sessionStorage.setItem(EVENT_KEY, id);
  doorLink.href = id ? `/door?event=${encodeURIComponent(id)}` : '/door';
}

function linkLine(path, label) {
  const a = document.createElement('a');
  a.href = path;
  a.textContent = label;
  a.target = '_blank';
  a.rel = 'noreferrer';
  return a;
}

async function refresh() {
  const eventId = selectedEventId();
  guestsBody.replaceChildren();
  transfersEl.replaceChildren();
  updateDoorLink();
  if (!eventId) return;
  if (!token()) {
    say('Set the host token to see the guest list.');
    return;
  }
  const [ticketData, transferData] = await Promise.all([
    api('GET', `/api/host/events/${eventId}/tickets`),
    api('GET', `/api/host/events/${eventId}/transfers`),
  ]);
  const checkedIn = ticketData.tickets.filter((ticket) => ticket.status === 'checked_in').length;
  tallyCount.textContent = String(checkedIn);
  tallyLabel.textContent = `of ${ticketData.tickets.length} checked in`;
  await renderStaff(eventId);
  if (ticketData.tickets.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 4;
    td.className = 'muted';
    td.textContent = 'No guests yet.';
    tr.append(td);
    guestsBody.append(tr);
  }
  for (const ticket of ticketData.tickets) {
    const tr = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = ticket.guest_name;
    const extra = [ticket.email, ticket.handle].filter(Boolean).join(' · ');
    if (extra) {
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.textContent = extra;
      name.append(sub);
    }
    const status = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = `pill ${ticket.status}`;
    pill.textContent = ticket.status.replaceAll('_', ' ');
    status.append(pill);
    const link = document.createElement('td');
    link.append(linkLine(ticket.guest_path, 'Open ticket'));
    const actions = document.createElement('td');
    if (ticket.status !== 'revoked') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.textContent = 'Revoke';
      button.addEventListener('click', async () => {
        try {
          await api('POST', `/api/host/tickets/${ticket.id}/revoke`);
          say(`Revoked ${ticket.guest_name}`);
          await refresh();
        } catch (error) {
          say(error.message);
        }
      });
      actions.append(button);
    }
    tr.append(name, status, link, actions);
    guestsBody.append(tr);
  }
  const pending = transferData.transfers.filter((transfer) => transfer.status === 'pending');
  if (pending.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No pending transfers.';
    transfersEl.append(empty);
  }
  for (const transfer of pending) {
    const row = document.createElement('div');
    row.className = 'row';
    const text = document.createElement('span');
    text.textContent = `${transfer.from_name} → ${transfer.to_name}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Approve';
    button.addEventListener('click', async () => {
      try {
        const data = await api('POST', `/api/host/transfers/${transfer.id}/approve`);
        issuedLink.replaceChildren();
        issuedLink.append('New guest link: ');
        issuedLink.append(linkLine(data.guest_path, data.guest_path));
        say(`Approved transfer to ${transfer.to_name}. The old code is dead.`);
        await refresh();
      } catch (error) {
        say(error.message);
      }
    });
    row.append(text, button);
    transfersEl.append(row);
  }
}

document.querySelector('#save-token').addEventListener('click', async () => {
  sessionStorage.setItem(TOKEN_KEY, tokenInput.value.trim());
  tokenInput.value = '';
  authState.textContent = token() ? 'Token saved in this tab' : 'Token cleared';
  try {
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

document.querySelector('#event-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  if (body.starts_at) body.starts_at = new Date(body.starts_at).toISOString();
  try {
    const data = await api('POST', '/api/host/events', body);
    form.reset();
    say(`Created ${data.event.name}`);
    await fillEvents(data.event.id);
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

document.querySelector('#issue-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const eventId = selectedEventId();
  if (!eventId) {
    say('Create or select an event first.');
    return;
  }
  const form = event.currentTarget;
  const guestName = new FormData(form).get('guest_name');
  try {
    const data = await api('POST', `/api/host/events/${eventId}/tickets`, { guest_name: guestName });
    form.reset();
    issuedLink.replaceChildren();
    issuedLink.append(`Ticket for ${data.ticket.guest_name}: `);
    issuedLink.append(linkLine(data.guest_path, data.guest_path));
    say('Ticket issued. Copy the link to the guest. This app does not message them.');
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

async function renderStaff(eventId) {
  staffLinks.replaceChildren();
  const data = await api('GET', `/api/host/events/${eventId}/staff`);
  const active = data.staff.filter((staff) => !staff.revoked_at);
  if (active.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No door link yet.';
    staffLinks.append(empty);
    return;
  }
  for (const staff of active) {
    const row = document.createElement('div');
    row.className = 'row';
    const link = linkLine(staff.door_path, `${staff.label}: ${staff.door_path}`);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Revoke';
    button.addEventListener('click', async () => {
      try {
        await api('POST', `/api/host/staff/${staff.id}/revoke`, {});
        say(`Revoked the ${staff.label} link`);
        await refresh();
      } catch (error) {
        say(error.message);
      }
    });
    row.append(link, button);
    staffLinks.append(row);
  }
}

document.querySelector('#csv-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files && event.currentTarget.files[0];
  if (!file) return;
  document.querySelector('#csv-text').value = await file.text();
});

document.querySelector('#import-csv').addEventListener('click', async () => {
  const eventId = selectedEventId();
  if (!eventId) {
    say('Create or select an event first.');
    return;
  }
  const csv = document.querySelector('#csv-text').value;
  if (!csv.trim()) {
    say('Paste a CSV or choose a file.');
    return;
  }
  try {
    const data = await api('POST', `/api/host/events/${eventId}/import`, { csv });
    importReport.replaceChildren();
    const summary = document.createElement('p');
    summary.textContent = `${data.created.length} guests added. ${data.errors.length} rows need a fix.`;
    importReport.append(summary);
    for (const error of data.errors) {
      const line = document.createElement('p');
      line.textContent = `Line ${error.line}: ${error.reason}`;
      importReport.append(line);
    }
    say('Import finished. Copy each guest link yourself. This app does not message anyone.');
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

document.querySelector('#staff-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const eventId = selectedEventId();
  if (!eventId) {
    say('Create or select an event first.');
    return;
  }
  const label = new FormData(event.currentTarget).get('label');
  try {
    const data = await api('POST', `/api/host/events/${eventId}/staff`, { label: label || 'Door' });
    event.currentTarget.reset();
    say(`Door link ready: ${data.staff.door_path}`);
    await refresh();
  } catch (error) {
    say(error.message);
  }
});

eventSelect.addEventListener('change', () => {
  refresh().catch((error) => say(error.message));
});

if (token()) authState.textContent = 'Token saved in this tab';
fillEvents()
  .then(() => refresh())
  .catch((error) => say(error.message));

setInterval(() => {
  if (!selectedEventId() || !token()) return;
  refresh().catch(() => {});
}, 3000);
