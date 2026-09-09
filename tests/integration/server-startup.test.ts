import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Boots the real Node entry the way the image does (Dockerfile CMD). Everything below
// runs only at startup — env validation, SQLite open, /healthz, SIGTERM shutdown — so
// without this it is covered by no test in either lane.
const START_ARGV = ['--import', 'tsx', 'src/server.ts'];

const BASE_ENV: Record<string, string> = {
  ENV_MANAGER_BOT_TOKEN: '123456:startup-test',
  ENV_HOST_UID: '1',
  ENV_MASTER_ENC_KEY: `${'A'.repeat(43)}=`,
  ENV_PUBLIC_BASE_URL: 'https://startup.invalid',
  PORT: '0',
};

let child: ChildProcess | null = null;
let dataDir: string | null = null;

afterEach(() => {
  child?.kill('SIGKILL');
  child = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

function start(overrides: Record<string, string> = {}): ChildProcess {
  return spawn(process.execPath, START_ARGV, {
    env: { ...process.env, ...BASE_ENV, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitForLine(proc: ChildProcess, re: RegExp, timeoutMs: number): Promise<RegExpMatchArray> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${re}; output so far:\n${seen}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString();
      const m = seen.match(re);
      if (!m) return;
      clearTimeout(timer);
      resolve(m);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('close', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited with ${code} before matching ${re}:\n${seen}`));
    });
  });
}

function collectUntilExit(proc: ChildProcess): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString()));
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString()));
    proc.on('close', (code) => resolve({ code, out }));
  });
}

describe('Node entry point', () => {
  it('boots, serves /healthz, and exits cleanly on SIGTERM', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-relay-startup-'));
    child = start({ DATA_DIR: dataDir });

    const listening = await waitForLine(child, /listening on :(\d+)\b/, 20_000);
    const res = await fetch(`http://127.0.0.1:${listening[1]}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(join(dataDir, 'db.sqlite'))).toBe(true);

    const exited = new Promise<number | null>((r) => child?.on('close', r));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 30_000);

  it('refuses to start when a required variable is missing', async () => {
    child = start({ ENV_MASTER_ENC_KEY: '' });
    const { code, out } = await collectUntilExit(child);
    expect(code).toBe(1);
    expect(out).toMatch(/missing env ENV_MASTER_ENC_KEY/);
  }, 30_000);
});
