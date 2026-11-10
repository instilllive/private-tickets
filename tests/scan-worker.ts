import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../src/db';
import { scanCode } from '../src/service';

type Job = {
  dbPath: string;
  eventId: string;
  code: string;
  nowMs: number;
};

const job = workerData as Job;
const db = openDatabase(job.dbPath);

parentPort?.postMessage({ ready: true });

parentPort?.once('message', (message: unknown) => {
  if (message !== 'go') {
    parentPort?.postMessage({ error: 'expected go' });
    db.close();
    return;
  }
  try {
    const result = scanCode(db, {
      eventId: job.eventId,
      code: job.code,
      nowMs: job.nowMs,
    });
    parentPort?.postMessage({ result });
  } catch (error) {
    parentPort?.postMessage({ error: error instanceof Error ? error.message : 'scan failed' });
  } finally {
    db.close();
  }
});
