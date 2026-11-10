# Private tickets

A small invite-only ticketing app for a private event. Guests are named. There is no payment, no resale marketplace, and the app never messages anyone. The door code rotates every few seconds, in the same spirit as Ticketmaster SafeTix: a screenshot goes stale, and a code that already admitted someone cannot be used again.

## How a code works

Each ticket has a secret of 32 random bytes that stays on the server. The guest page polls the server and shows a QR code. The payload is:

```text
pt1.<ticket_id>.<step>.<mac>
```

- `step` is `floor(unix_ms / 5000)`, so the code changes every 5 seconds.
- `mac` is the first 16 bytes of `HMAC-SHA256(ticket_secret, ticket_id + "|" + step)`, written as hex.
- The payload includes the ticket id and the step. It does not include the secret, so someone who photographs the QR still cannot mint the next code.

The guest link is a separate random access token (`/t/<token>`). That token is how the phone asks the server for a fresh code. It is not inside the QR.

The door accepts the current step and one step on either side, for clock skew. A code two or more steps away is rejected as expired. A screenshot that is about 15 seconds old (3 steps) always fails. One step is 5 seconds, so a code is never honored once it is two steps out of date.

Comparison of the HMAC tag uses `crypto.timingSafeEqual`.

A successful scan runs in a SQLite `BEGIN IMMEDIATE` transaction and updates the ticket from `issued` to `checked_in` only if it is still `issued`. Inside that transaction the door reads the secret again and checks the tag, so a transfer approved in the same moment cannot be admitted on the old code. A second scan of that ticket, including a concurrent double-scan of the same live code, is rejected as already used. The ticket is single-use, not just the string.

Check order at the door:

1. Missing or tampered HMAC: `invalid code` (an unknown ticket id is the same answer).
2. Outside the ±1 step window: `expired`, including when the ticket was already used. A stale screenshot is not described as a replay.
3. Ticket belongs to a different event: `wrong event`. The ticket stays issued.
4. Revoked, and the code is still inside the window: `revoked`.
5. Otherwise claim the ticket, or reject `already used`.

## Transfers

A guest can ask to transfer their ticket to a new name. That request does nothing to the name, the secret, or the codes until the host approves it.

On approval the same ticket gets the new name, a new 32-byte secret, and a new guest link. Codes minted with the old secret no longer verify. The old link 404s. The host copies the new link and gives it to the new guest. This app does not send that message.

## Threat model

What rotating codes actually stop:

- Forwarding a screenshot or a copied payload. It dies within about 10 seconds, and by 15 seconds it is three steps old and always rejected.
- Replaying a code that the door already accepted. The ticket is checked in, and another presentation is rejected.
- Guessing a code. The tag is 128 bits of HMAC, and the secret never leaves the server.
- A guest handing their link to a friend and still using the old code after the host approves a transfer. Approval replaces the secret.

What they do not stop:

- Someone holding the live phone, or anyone who has the guest link open, can keep showing fresh codes. That is the same limit as SafeTix. The rotation proves the phone is talking to the server right now. It does not prove who is holding the phone.
- The host token is a single shared bearer secret. Anyone who has it can issue, revoke, and approve. It is not an account system.
- The door endpoint is not separately authenticated. Anyone who can reach the server and knows an event id can submit codes. That fits a door device on a trusted network. It is not a production perimeter.
- Event name, venue, and start time are readable without the host token so the door page can list them. The guest list and ticket links are not.
- There is one SQLite file and one process. This is not a multi-node deployment.

## Run locally

Node.js 20 or newer.

```bash
cp .env.example .env
# Put a real token in .env. Generate one with: openssl rand -hex 32
npm install
npm start
```

`.env` is loaded if it is present. Values already set in the environment win. The sample token in `.env.example` is a placeholder, not a secret, and it is not loaded on its own.

Open:

- http://localhost:3000/host — create an event, issue a ticket, copy the guest link, revoke, approve transfers. Paste the host token into the page. It is kept in `sessionStorage` for that tab.
- `http://localhost:3000/t/<token>` — the guest ticket. The QR re-renders every step, with a countdown.
- http://localhost:3000/door — pick the event, start the camera (html5-qrcode), or paste a payload. The page shows `ADMIT` or `REJECTED` and the reason.

`PORT` defaults to 3000. `DATABASE_PATH` defaults to `./data/tickets.db`.

The host API takes `Authorization: Bearer <HOST_TOKEN>`.

## Demo

`npm run demo` issues a ticket against an in-memory server, mints a live code and a code from 15 seconds earlier, then scans them:

```bash
npm run demo
```

You should see `ADMIT`, then `REJECTED: already used`, then `REJECTED: expired`. The script exits non-zero if those three results are not what came back.

## Tests

```bash
npm run typecheck
npm test
```

Vitest covers rotation, the ±1 step window, one-time admit, replay, stale codes, a tampered HMAC, revoked tickets, the wrong event, transfers before and after approval, and a real multi-connection race on the check-in update. The clock is injected, and one test also drives the guest endpoint with fake timers.

GitHub Actions runs typecheck and the tests on Node 20 and Node 22.

## What this is not

No payments, no marketplace, no guest messaging, no production deploy, no multi-user accounts.
