/** Door codes rotate on this interval. One step of clock skew is accepted on either side. */
export const STEP_MS = 5_000;

export type Clock = () => number;

export function systemClock(): number {
  return Date.now();
}

export function stepAt(nowMs: number): number {
  if (!Number.isFinite(nowMs)) {
    throw new Error('clock returned a non-finite time');
  }
  return Math.floor(nowMs / STEP_MS);
}

export function stepEndsAt(step: number): number {
  return (step + 1) * STEP_MS;
}
