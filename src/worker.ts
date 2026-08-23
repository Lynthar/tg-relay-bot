import type { Hono } from 'hono';
import { parseHostConfig, type Env } from './config';
import { buildApp } from './index';
import { logError } from './security';

// The KV binding satisfies KvStore structurally (the interface is a subset of
// KVNamespace), so the Worker env doubles as the app Env with no adapter.
interface WorkerEnv extends Omit<Env, 'nfd'> {
  nfd: KVNamespace;
}

let appPromise: Promise<Hono> | null = null;

async function init(env: WorkerEnv): Promise<Hono> {
  const appEnv: Env = env;
  const host = await parseHostConfig(appEnv);
  return buildApp({ env: appEnv, host });
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    let app: Hono;
    try {
      appPromise ??= init(env);
      app = await appPromise;
    } catch (e) {
      // Bad config must make the whole webhook surface look nonexistent, and must
      // not stick: clear the memo so the next request re-reads the (fixed) env.
      appPromise = null;
      logError('config', e);
      return new Response('Not found', { status: 404 });
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
