import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STEP_MS, stepAt } from '../src/clock';
import { MAC_BYTES, compareMacs, computeMac, mintCode, newSecret, parseCode, stepWithinWindow } from '../src/codes';
import { T0 } from './helpers';

describe('rotating codes', () => {
  it('uses a 5 second step', () => {
    expect(STEP_MS).toBe(5_000);
    expect(stepAt(T0)).toBe(T0 / STEP_MS);
    expect(stepAt(T0 + STEP_MS - 1)).toBe(stepAt(T0));
    expect(stepAt(T0 + STEP_MS)).toBe(stepAt(T0) + 1);
  });

  it('rotates the code on each step and keeps it stable inside a step', () => {
    const secret = newSecret();
    const ticketId = crypto.randomUUID();
    const step = stepAt(T0);
    const current = mintCode(secret, ticketId, step);
    const again = mintCode(secret, ticketId, step);
    const next = mintCode(secret, ticketId, step + 1);
    expect(current).toBe(again);
    expect(next).not.toBe(current);
    expect(parseCode(current)?.step).toBe(step);
    expect(parseCode(next)?.step).toBe(step + 1);
  });

  it('is HMAC-SHA256 of ticket id and step, truncated, and does not carry the secret', () => {
    const secret = newSecret();
    const ticketId = crypto.randomUUID();
    const step = 356_000_000;
    const code = mintCode(secret, ticketId, step);
    const mac = createHmac('sha256', secret)
      .update(`${ticketId}|${step}`)
      .digest()
      .subarray(0, MAC_BYTES)
      .toString('hex');
    expect(code).toBe(`pt1.${ticketId}.${step}.${mac}`);
    expect(mac).toHaveLength(MAC_BYTES * 2);
    expect(code).not.toContain(secret.toString('hex'));
    expect(code).not.toContain(secret.toString('base64'));
    expect(code).not.toContain(secret.toString('base64url'));
  });

  it('compares tags with timingSafeEqual', () => {
    expect(compareMacs.toString()).toContain('timingSafeEqual');
    const secret = newSecret();
    const ticketId = crypto.randomUUID();
    const mac = computeMac(secret, ticketId, 10);
    const copy = Buffer.from(mac);
    const flipped = Buffer.from(mac);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 0x01;
    expect(compareMacs(mac, copy)).toBe(timingSafeEqual(mac, copy));
    expect(compareMacs(mac, flipped)).toBe(false);
    expect(compareMacs(mac, Buffer.alloc(8))).toBe(false);
  });

  it('accepts only the current step and one step of skew', () => {
    const step = stepAt(T0);
    expect(stepWithinWindow(step, T0)).toBe(true);
    expect(stepWithinWindow(step - 1, T0)).toBe(true);
    expect(stepWithinWindow(step + 1, T0)).toBe(true);
    expect(stepWithinWindow(step - 2, T0)).toBe(false);
    expect(stepWithinWindow(step + 2, T0)).toBe(false);
    expect(stepWithinWindow(step - 3, T0)).toBe(false);
  });
});
