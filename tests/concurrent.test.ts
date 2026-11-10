import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { stepAt } from '../src/clock';
import { mintCode } from '../src/codes';
import { openDatabase } from '../src/db';
import { type ScanResult } from '../src/format';
import { snapshotTicket } from '../src/service';
import { seed, T0 } from './helpers';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type WorkerMessage = { ready?: true; result?: ScanResult; error?: string };

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function scanInWorker(job: { dbPath: string; eventId: string; code: string; nowMs: number }): {
  ready: Promise<void>;
  go: () => void;
  done: Promise<ScanResult>;
} {
  const worker = new Worker(new URL('./scan-worker.ts', import.meta.url), {
    execArgv: ['--import', 'tsx'],
    workerData: job,
  });
  const ready = deferred<void>();
  const done = deferred<ScanResult>();
  let finished = false;
  worker.on('message', (message: WorkerMessage) => {
    if (message.ready) ready.resolve();
    if (message.error) {
      finished = true;
      done.reject(new Error(message.error));
    }
    if (message.result) {
      finished = true;
      done.resolve(message.result);
    }
  });
  worker.on('error', (error) => {
    finished = true;
    ready.reject(error);
    done.reject(error);
  });
  worker.on('exit', (code) => {
    if (!finished) {
      const error = new Error(`scan worker exited ${code} before returning a result`);
      ready.reject(error);
      done.reject(error);
    }
  });
  return {
    ready: ready.promise,
    go() {
      worker.postMessage('go');
    },
    done: done.promise,
  };
}

async function doubleScan(workers: number): Promise<ScanResult[]> {
  const dir = mkdtempSync(join(tmpdir(), 'private-tickets-'));
  dirs.push(dir);
  const dbPath = join(dir, 'door.db');
  const db = openDatabase(dbPath);
  const { event, ticket } = seed(db);
  const row = snapshotTicket(db, ticket.id);
  if (!row) throw new Error('missing ticket');
  const code = mintCode(row.secret, row.id, stepAt(T0));
  db.close();

  const jobs = Array.from({ length: workers }, () =>
    scanInWorker({ dbPath, eventId: event.id, code, nowMs: T0 }),
  );
  await Promise.all(jobs.map((job) => job.ready));
  for (const job of jobs) job.go();
  return Promise.all(jobs.map((job) => job.done));
}

describe('concurrent scans', () => {
  it('admits a double-scan only once', async () => {
    const results = await doubleScan(2);
    const admits = results.filter((result) => result.result === 'admit');
    const rejects = results.filter((result) => result.result === 'reject');
    expect(admits).toHaveLength(1);
    expect(rejects).toEqual([{ result: 'reject', reason: 'already_used' }]);
  }, 20_000);

  it('admits only once when several scanners race the same code', async () => {
    const results = await doubleScan(6);
    expect(results.filter((result) => result.result === 'admit')).toHaveLength(1);
    expect(results.filter((result) => result.result === 'reject')).toHaveLength(5);
    for (const result of results) {
      if (result.result === 'reject') expect(result.reason).toBe('already_used');
    }
  }, 20_000);
});
