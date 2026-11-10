import { beforeEach, describe, expect, it, vi } from 'vitest';

const compareSpy = vi.hoisted(() => vi.fn());

vi.mock('../src/codes', async () => {
  const actual = await vi.importActual<typeof import('../src/codes')>('../src/codes');
  compareSpy.mockImplementation((expected: Buffer, provided: Buffer) => actual.compareMacs(expected, provided));
  return { ...actual, compareMacs: compareSpy };
});

import { stepAt } from '../src/clock';
import { mintCode } from '../src/codes';
import { scanCode, snapshotTicket } from '../src/service';
import { seed, setup, T0 } from './helpers';

beforeEach(() => {
  compareSpy.mockClear();
});

describe('constant-time compare on the scan path', () => {
  it('compares the full tag for a parsed code', () => {
    const ctx = setup();
    const { event, ticket } = seed(ctx.db);
    const row = snapshotTicket(ctx.db, ticket.id);
    if (!row) throw new Error('missing ticket');
    const code = mintCode(row.secret, row.id, stepAt(T0));
    const tampered = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
    const result = scanCode(ctx.db, { eventId: event.id, code: tampered, nowMs: T0 });
    expect(result).toEqual({ result: 'reject', reason: 'invalid_code' });
    expect(compareSpy).toHaveBeenCalledTimes(1);
    const call = compareSpy.mock.calls[0];
    if (!call) throw new Error('compareMacs was not called');
    const expected = call[0] as Buffer;
    const provided = call[1] as Buffer;
    expect(expected).toHaveLength(16);
    expect(provided).toHaveLength(16);
    expect(Buffer.compare(expected, provided)).not.toBe(0);
    ctx.close();
  });
});
