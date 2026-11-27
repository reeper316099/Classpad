import { APP_NAME, DATA_DIR_ENV } from '@classpad/shared';
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** Default per-OS data directory; CLASSPAD_DATA_DIR overrides it (the same rule as the server). */
export function defaultDataDir(env = process.env, platform = process.platform): string {
  if (env[DATA_DIR_ENV]) return path.resolve(env[DATA_DIR_ENV]!);
  const home = os.homedir();
  if (platform === 'win32')
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}

/**
 * Where the bundle put the Go server. Packaged, it sits in app.asar.unpacked (a program can't run from
 * inside the archive).
 */
export function serverBinary(dir = __dirname): string {
  const name = process.platform === 'win32' ? 'classpad-server.exe' : 'classpad-server';
  return path.join(dir, 'bin', name).replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

export interface Server {
  url: string;
  close(): Promise<void>;
  /** Called if the server stops on its own (it crashed, or was killed). */
  onExit(fn: (message: string) => void): void;
}

export interface ServerOptions {
  dataDir: string;
  token: string;
  staticDir: string;
  watch?: boolean;
}

/**
 * Starts the Go API server as a child process. The token goes in the environment, never on the
 * command line (other users can read that). The server prints one JSON line when it is ready and
 * stops when its stdin closes, so it never outlives the app, even if the app is killed.
 */
export async function startServer(o: ServerOptions): Promise<Server> {
  const child: ChildProcess = spawn(
    serverBinary(),
    [
      '--data-dir',
      o.dataDir,
      '--static',
      o.staticDir,
      `--watch=${o.watch !== false}`,
      '--exit-with-stdin',
    ],
    {
      env: { ...process.env, CLASSPAD_TOKEN: o.token },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (d: string) => {
    stderr = (stderr + d).slice(-4000);
    process.stderr.write(d);
  });
  const lastError = () =>
    stderr
      .trim()
      .split('\n')
      .pop()
      ?.replace(/^classpad-server:\s*/, '') ?? '';

  const url = await new Promise<string>((resolve, reject) => {
    const fail = (why: string) => reject(new Error(lastError() || why));
    child.once('error', (e) => reject(e));
    child.once('exit', (code) => fail(`the server stopped while starting (exit code ${code})`));
    createInterface({ input: child.stdout! }).once('line', (line) => {
      try {
        const ready = JSON.parse(line) as { ready?: boolean; url?: string };
        if (ready.ready && ready.url) resolve(ready.url);
        else fail('the server did not report its address');
      } catch {
        fail('the server did not report its address');
      }
    });
  });
  child.removeAllListeners('exit');

  let closing = false;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let onExit: ((message: string) => void) | null = null;
  void exited.then(() => {
    if (!closing) onExit?.(lastError() || 'The Classpad server stopped unexpectedly.');
  });
  return {
    url,
    onExit: (fn) => {
      onExit = fn;
    },
    async close() {
      if (closing) return exited;
      closing = true;
      child.stdin!.end(); // a clean stop: it releases the data folder lock and flushes its writes
      const timer = setTimeout(() => child.kill(), 10_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
