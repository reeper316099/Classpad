import os from 'node:os';
import path from 'node:path';
import { APP_NAME, DATA_DIR_ENV } from '@classpad/shared';

/** Default per-OS data directory; CLASSPAD_DATA_DIR overrides. */
export function defaultDataDir(env = process.env, platform = process.platform): string {
  if (env[DATA_DIR_ENV]) return path.resolve(env[DATA_DIR_ENV]!);
  const home = os.homedir();
  if (platform === 'win32')
    return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), APP_NAME);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME);
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), APP_NAME);
}
