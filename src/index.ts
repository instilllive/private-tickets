import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { openDatabase } from './db';
import { loadEnvFile } from './env';

loadEnvFile(resolve(process.cwd(), '.env'));

const hostToken = process.env.HOST_TOKEN;
if (!hostToken) {
  console.error('HOST_TOKEN is required. Copy .env.example to .env and set a long random value.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535');
  process.exit(1);
}

const databasePath = process.env.DATABASE_PATH ?? './data/tickets.db';
const db = openDatabase(databasePath === ':memory:' ? databasePath : resolve(databasePath));
const app = createApp({ db, hostToken });

serve({ fetch: app.fetch, port }, () => {
  console.log(`private-tickets listening on http://localhost:${port}`);
});
