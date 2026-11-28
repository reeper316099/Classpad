#!/usr/bin/env node
// Packages the Wails desktop app (cmd/classpad) for the system it runs on, into release/:
//   macOS    Classpad-<v>-mac-universal.dmg (a universal arm64 + x64 Classpad.app)
//   Windows  Classpad-<v>-win-x64-setup.exe (per-user installer) and Classpad-<v>-win-x64-portable.exe
//   Linux    Classpad-<v>-linux-amd64.deb, Classpad-<v>-linux-x86_64.rpm and a .tar.gz
// Needs Go and the wails3 CLI (go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0); Windows
// also needs NSIS (makensis), Linux GTK 4 and WebKitGTK 6.0 development files. Nothing is signed.
//
//   node scripts/package-desktop.mjs [--version 1.2.3] [--skip-web]
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const version = arg('version') ?? '0.1.0';
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`version must be x.y.z, got ${version}`);
const release = path.join(root, 'release');
const work = path.join(release, '.work');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

const run = (cmd, args, opts = {}) => {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  if (r.error || r.status !== 0) {
    console.error(`✖ ${cmd} failed${r.error ? `: ${r.error.message}` : ''}`);
    process.exit(r.status ?? 1);
  }
};
const fill = (file, out, more = {}) => {
  let text = readFileSync(path.join(root, file), 'utf8')
    .replaceAll('{{VERSION4}}', `${version}.0`)
    .replaceAll('{{VERSION}}', version);
  for (const [k, v] of Object.entries(more)) text = text.replaceAll(`{{${k}}}`, v);
  writeFileSync(out, text);
};

/** The newest glibc symbol version a Linux binary needs (for example 2.38). */
function glibcNeeded(binary) {
  let best = [2, 17];
  for (const m of readFileSync(binary)
    .toString('latin1')
    .matchAll(/GLIBC_(\d+)\.(\d+)/g)) {
    const v = [Number(m[1]), Number(m[2])];
    if (v[0] > best[0] || (v[0] === best[0] && v[1] > best[1])) best = v;
  }
  return best.join('.');
}
let webBuilt = process.argv.includes('--skip-web');
const build = (out, env = {}) => {
  run(
    process.execPath,
    [
      'scripts/build-desktop.mjs',
      '--out',
      out,
      '--version',
      version,
      ...(webBuilt ? ['--skip-web'] : []),
    ],
    { env: { ...process.env, ...env } },
  );
  webBuilt = true;
};

// icons from the one source image
const icon = path.join(root, 'packaging/icons/icon.png');
const icns = path.join(work, 'icon.icns');
const ico = path.join(work, 'icon.ico');
run('wails3', ['generate', 'icons', '-input', icon, '-macfilename', icns, '-windowsfilename', ico]);

const name = (os, arch, ext) => path.join(release, `Classpad-${version}-${os}-${arch}.${ext}`);

if (process.platform === 'darwin') {
  const arm = path.join(work, 'classpad-arm64');
  const x64 = path.join(work, 'classpad-amd64');
  build(arm, { GOARCH: 'arm64', CGO_ENABLED: '1' });
  build(x64, { GOARCH: 'amd64', CGO_ENABLED: '1' });
  const stage = path.join(work, 'dmg');
  const app = path.join(stage, 'Classpad.app');
  mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  mkdirSync(path.join(app, 'Contents/Resources'), { recursive: true });
  run('lipo', ['-create', '-output', path.join(app, 'Contents/MacOS/Classpad'), arm, x64]);
  fill('packaging/darwin/Info.plist', path.join(app, 'Contents/Info.plist'));
  copyFileSync(icns, path.join(app, 'Contents/Resources/icon.icns'));
  // ad-hoc signature: not a Developer ID (see docs/PACKAGING.md), but a sealed bundle Apple silicon runs
  run('codesign', ['--force', '--deep', '--sign', '-', app]);
  symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmg = name('mac', 'universal', 'dmg');
  rmSync(dmg, { force: true });
  run('hdiutil', [
    'create',
    '-volname',
    'Classpad',
    '-srcfolder',
    stage,
    '-fs',
    'HFS+',
    '-format',
    'UDZO',
    '-ov',
    dmg,
  ]);
  console.log('Packaged', dmg);
} else if (process.platform === 'win32') {
  // the icon, version details and manifest go into the program as a Windows resource (.syso)
  const syso = path.join(root, 'cmd/classpad/rsrc_windows_amd64.syso');
  fill('packaging/windows/classpad.exe.manifest', path.join(work, 'classpad.exe.manifest'));
  fill('packaging/windows/info.json', path.join(work, 'info.json'));
  run('wails3', [
    'generate',
    'syso',
    '-arch',
    'amd64',
    '-icon',
    ico,
    '-manifest',
    path.join(work, 'classpad.exe.manifest'),
    '-info',
    path.join(work, 'info.json'),
    '-out',
    syso,
  ]);
  const exe = path.join(work, 'Classpad.exe');
  try {
    build(exe, { GOARCH: 'amd64' });
  } finally {
    rmSync(syso, { force: true });
  }
  copyFileSync(exe, name('win', 'x64-portable', 'exe'));
  run('wails3', ['generate', 'webview2bootstrapper', '-dir', work]);
  const setup = name('win', 'x64-setup', 'exe');
  run('makensis', [
    `/DVERSION=${version}`,
    `/DEXE=${exe}`,
    `/DOUT=${setup}`,
    `/DICON=${ico}`,
    `/DWEBVIEW2=${path.join(work, 'MicrosoftEdgeWebview2Setup.exe')}`,
    path.join(root, 'packaging/windows/installer.nsi'),
  ]);
  console.log('Packaged', setup);
} else {
  const stage = path.join(work, 'linux');
  mkdirSync(stage, { recursive: true });
  build(path.join(stage, 'classpad'), { GOARCH: 'amd64', CGO_ENABLED: '1' });
  chmodSync(path.join(stage, 'classpad'), 0o755);
  copyFileSync(path.join(root, 'packaging/icons/icon-256.png'), path.join(stage, 'classpad.png'));
  copyFileSync(
    path.join(root, 'packaging/linux/classpad.desktop'),
    path.join(stage, 'classpad.desktop'),
  );
  const glibc = glibcNeeded(path.join(stage, 'classpad'));
  console.log(`The program needs glibc ${glibc} or newer`);
  fill('packaging/linux/nfpm.yaml', path.join(stage, 'nfpm.yaml'), { GLIBC: glibc });
  for (const format of ['deb', 'rpm'])
    run(
      'wails3',
      [
        'tool',
        'package',
        '-name',
        'classpad',
        '-format',
        format,
        '-config',
        'nfpm.yaml',
        '-out',
        work,
      ],
      { cwd: stage },
    );
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(work)) {
    if (f.endsWith('.deb')) copyFileSync(path.join(work, f), name('linux', 'amd64', 'deb'));
    if (f.endsWith('.rpm')) copyFileSync(path.join(work, f), name('linux', 'x86_64', 'rpm'));
  }
  const tarDir = path.join(work, `Classpad-${version}`);
  mkdirSync(tarDir);
  for (const f of ['classpad', 'classpad.png', 'classpad.desktop'])
    cpSync(path.join(stage, f), path.join(tarDir, f));
  run('tar', ['-czf', name('linux', 'x86_64', 'tar.gz'), '-C', work, `Classpad-${version}`]);
  console.log('Packaged deb, rpm and tar.gz into', release);
}
rmSync(work, { recursive: true, force: true });
