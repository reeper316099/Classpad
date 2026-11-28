# Desktop app, packaging and releases

## How the desktop app is put together

- `cmd/classpad` is one Go program ([Wails 3](https://v3.wails.io)). It shows the web interface in the operating
  system's own web view: WebKit on macOS (WKWebView), WebView2 on Windows, WebKitGTK on Linux.
- The local API (`internal/server`) runs **in the same process**. The web view's requests go straight to the
  API's request handler, so nothing listens on a network port: no other program, and no web page, can reach the
  API. Every `/api` request still needs a random **per-launch token**, which is never written to disk.
- The built interface (`apps/web/dist`) is embedded in the program. `scripts/build-desktop.mjs` copies it into
  `cmd/classpad/web` and builds the binary.
- `cmd/classpad/bridge.js` gives the page `window.classpad`: the token, native-menu events, live updates, "show
  data folder", the folder picker, paste, the printable report (and printing it, where the system dialog can
  save a PDF) and exports through a native Save dialog. It is loaded before the app's own scripts.
- `CLASSPAD_SELFTEST=1` starts the app with a hidden window, checks the bridge, the API and its token, live
  updates, the interface, the editor core and the report, prints the result and quits. CI runs it on Linux,
  macOS and Windows.

## Security model

- **No network:** the page's Content-Security-Policy allows nothing but the app itself (`default-src 'self'`,
  `connect-src 'self'`, no remote images, fonts or frames). Links to `https:` and `mailto:` open in your browser or
  mail app; nothing navigates the app window away. There is no network port to reach.
- The API requires the bearer token on every `/api` route.
- Interface files are served traversal-safe with a strict Content-Security-Policy; the grade report has its own
  (`default-src 'none'`).
- Single instance: a second launch focuses the first window; the data folder also has a lock file.

## Data location

The data directory (override with `CLASSPAD_DATA_DIR`): `%APPDATA%\Classpad`,
`~/Library/Application Support/Classpad`, `$XDG_CONFIG_HOME|~/.config/Classpad`. The desktop app keeps its
window position in the `shell/` subfolder. Earlier versions (Electron) kept Chromium's files in `electron/` and
lock files (`lockfile`, `Singleton*`) next to your data; backups skip all of these.

## Commands

```bash
npm run desktop          # build the desktop app and open it (on your own data folder)
npm run desktop:dist     # installers for the current OS in ./release
npm run e2e              # end-to-end tests: the interface against the Go server in WebKit and Chromium
CLASSPAD_SELFTEST=1 CLASSPAD_DATA_DIR=/tmp/st ./build/classpad   # the desktop app's self-test
```

`npm run desktop:dist` runs `scripts/package-desktop.mjs`, which needs the Wails CLI
(`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`) and, on Windows, NSIS. Targets:

- **macOS:** `Classpad-<version>-mac-universal.dmg` with a universal (arm64 + x64) `Classpad.app`.
- **Windows:** `Classpad-<version>-win-x64-setup.exe` (installs for the current user, no administrator
  rights; adds the WebView2 runtime when Windows 10 lacks it) and `Classpad-<version>-win-x64-portable.exe`.
- **Linux:** `.deb`, `.rpm` and a `.tar.gz`; they need GTK 4, WebKitGTK 6.0 and the glibc the program was
  built against (2.38 when built on Ubuntu 24.04: Ubuntu 24.04+, Debian 13+, Fedora 39+). The packages declare
  that glibc version, read from the binary, so older systems refuse them instead of installing an app that cannot
  start.

Packaging files live in `packaging/` (Info.plist, the Windows manifest and installer script, the Linux
`.desktop` file and package description). Icons come from `packaging/icons`, made by
`node scripts/make-icon.mjs`.

## Releasing

Tag a commit `vX.Y.Z` and push the tag. `.github/workflows/release.yml` builds all three platforms and opens a
**draft** GitHub release with the installers and generated notes for you to review and publish. Running the
workflow by hand without a tag only builds the installers and keeps them as run artifacts.

## Unsigned builds (for now)

Builds are not code-signed, so operating systems show a first-run warning (see the release text for how to
proceed). The macOS app has an ad-hoc signature, which Apple silicon needs to run it at all. To add signing later:

- **macOS:** sign `Classpad.app` with a Developer ID (`codesign --options runtime`) instead of the ad-hoc
  signature in `scripts/package-desktop.mjs`, then notarize the `.dmg` (`xcrun notarytool`) and staple it.
- **Windows:** sign `Classpad.exe` and the installer with a code-signing certificate or Azure Trusted Signing
  (`signtool`), or use `wails3 tool sign`.
- Auto-update is intentionally not included (no network access).
