import { describe, expect, it } from 'vitest';
import { stepAt } from '../src/clock';
import { mintCode } from '../src/codes';
import { approveTransfer, guestView, requestTransfer, scanCode, snapshotTicket } from '../src/service';
import { seed, setup, T0 } from './helpers';

describe('transfers', () => {
  it('does not change the ticket until the host approves', async () => {
    const ctx = setup();
    const { event, ticket, accessToken } = seed(ctx.db);
    const before = snapshotTicket(ctx.db, ticket.id);
    if (!before) throw new Error('missing ticket');
    const code = mintCode(before.secret, before.id, stepAt(T0));

    const requested = requestTransfer(ctx.db, {
      accessToken,
      toName: 'Grace Hopper',
      nowMs: T0,
    });
    expect(requested.ok).toBe(true);

    const after = snapshotTicket(ctx.db, ticket.id);
    expect(after?.guest_name).toBe(before.guest_name);
    expect(after?.status).toBe('issued');
    expect(after?.access_token).toBe(before.access_token);
    expect(after?.secret.equals(before.secret)).toBe(true);

    const view = await guestView(ctx.db, accessToken, T0);
    expect(view?.guest_name).toBe('Ada Lovelace');
    expect(view?.pending_transfer?.to_name).toBe('Grace Hopper');
    expect(view?.code).toBe(code);

    expect(scanCode(ctx.db, { eventId: event.id, code, nowMs: T0 })).toMatchObject({
      result: 'admit',
      guest_name: 'Ada Lovelace',
    });
    ctx.close();
  });

  it('rejects the old codes after approval and admits codes from the new secret', async () => {
    const ctx = setup();
    const { event, ticket, accessToken } = seed(ctx.db);
    const before = snapshotTicket(ctx.db, ticket.id);
    if (!before) throw new Error('missing ticket');
    const oldCode = mintCode(before.secret, before.id, stepAt(T0));
    const requested = requestTransfer(ctx.db, {
      accessToken,
      toName: 'Grace Hopper',
      nowMs: T0,
    });
    if (!requested.ok) throw new Error(requested.error);

    const approved = approveTransfer(ctx.db, requested.transfer.id, T0);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;

    const after = snapshotTicket(ctx.db, ticket.id);
    expect(after?.guest_name).toBe('Grace Hopper');
    expect(after?.status).toBe('issued');
    expect(after?.secret.equals(before.secret)).toBe(false);
    expect(after?.access_token).not.toBe(before.access_token);
    expect(approved.ticket.guest_path).toBe(`/t/${after?.access_token}`);

    expect(await guestView(ctx.db, accessToken, T0)).toBeNull();
    const fresh = await guestView(ctx.db, approved.accessToken, T0);
    expect(fresh?.guest_name).toBe('Grace Hopper');
    expect(fresh?.code).toBeTruthy();
    expect(fresh?.code).not.toBe(oldCode);

    expect(scanCode(ctx.db, { eventId: event.id, code: oldCode, nowMs: T0 })).toEqual({
      result: 'reject',
      reason: 'invalid_code',
    });
    expect(scanCode(ctx.db, { eventId: event.id, code: fresh?.code ?? '', nowMs: T0 })).toMatchObject({
      result: 'admit',
      guest_name: 'Grace Hopper',
    });
    ctx.close();
  });
});
