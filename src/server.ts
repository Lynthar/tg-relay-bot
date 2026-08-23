import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildApp } from './index';
import { parseHostConfig, type Env } from './config';
import { SqliteKvStore } from './kv/sqlite';

function readEnv(): Env {
  const required = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`missing env ${name}`);
    return v;
  };
  // KV backend is constructed below; placeholder satisfies the Env type.
  return {
    nfd: undefined as unknown as Env['nfd'],
    ENV_MANAGER_BOT_TOKEN: required('ENV_MANAGER_BOT_TOKEN'),
    ENV_HOST_UID: required('ENV_HOST_UID'),
    ENV_MASTER_ENC_KEY: required('ENV_MASTER_ENC_KEY'),
    ENV_PUBLIC_BASE_URL: required('ENV_PUBLIC_BASE_URL'),
    ENV_ADMIN_SECRET: process.env.ENV_ADMIN_SECRET,
    ENV_DEBUG: process.env.ENV_DEBUG,
  };
}

async function main(): Promise<void> {
  const env = readEnv();

  const dbPath = process.env.DATA_DIR
    ? `${process.env.DATA_DIR.replace(/\/+$/, '')}/db.sqlite`
    : '/data/db.sqlite';
  mkdirSync(dirname(dbPath), { recursive: true });
  const kv = new SqliteKvStore(dbPath);
  env.nfd = kv;

  // parseHostConfig validates ENV_PUBLIC_BASE_URL format; any failure aborts startup.
  const host = await parseHostConfig(env);
  const app = buildApp({ env, host });

  const port = Number(process.env.PORT ?? 8080);
  const server = serve({ fetch: app.fetch, port }, (info) => {
    console.log(`listening on :${info.port} (public base ${host.publicBaseUrl})`);
  });

  const shutdown = (signal: string): void => {
    console.log(`received ${signal}, shutting down`);
    server.close(() => {
      try {
        kv.close();
      } catch (e) {
        console.error('error closing kv:', e);
      }
      process.exit(0);
    });
    // Force exit if close hangs past the Docker SIGKILL grace window.
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  console.error('fatal:', e instanceof Error ? e.message : e);
  process.exit(1);
});
