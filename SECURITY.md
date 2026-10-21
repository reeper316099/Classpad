# Security Policy

## Reporting

Classpad is local-first with no network access in v1. Report vulnerabilities privately through
GitHub Security Advisories on this repository (do not open public issues for them). We aim to
acknowledge reports within 7 days. Supported: the latest release.

## Threat model

Classpad protects against: other websites or local processes talking to its API, malicious content in
imported files and notes, and someone casually reading your files or using your unlocked screen.
It does **not** defend against malware running as your user, or someone with your passphrase.

## What we do

- **No network.** No telemetry, accounts, updates checks or AI calls. The Electron session cancels any
  request that is not the local server.
- **Local API hardened.** Loopback only, random per-launch bearer token, `Host` header allow-list, strict
  Content-Security-Policy, request size limits, schema validation on every write.
- **Renderer isolation.** Sandbox, context isolation, no Node integration, no popups or webviews,
  navigation locked, only a narrow preload bridge.
- **Untrusted content.** Raw HTML in Markdown is never rendered; imports are previewed before anything is written; file
  paths are confined to the data folder.
- **No secrets in logs.** Logs never include note, journal or grade content.

## App lock and encryption

Optional. A passphrase locks the window (and the API with `423 LOCKED`). You may also encrypt chosen
collections on disk with **AES-256-GCM**, key derived by **scrypt (N=32768)**; each file's path is
authenticated data. The passphrase is verified with a separate salted hash, wrong guesses are
rate-limited (5 failures, then exponential back-off up to 5 minutes), and the key is dropped from
memory on lock.

Know the limits:

- **A lost passphrase cannot be recovered.** There is no reset and no backdoor.
- **Attachment files** (PDFs, images) are not encrypted. Do not attach what you would not leave on disk.
- Turning encryption on removes older plaintext backups and takes a fresh encrypted one. Copies you
  made yourself (exports, your own backups) are not touched.
- Locked data is protected at rest, not against malware that can read process memory while unlocked.
- Search and other derived indexes live in memory only and are never written to disk.

## Releases

Builds are currently **unsigned**; your OS will warn on first launch. Verify downloads against the
checksums in the release notes.
