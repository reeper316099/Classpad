# Classpad

A calm, fast, open-source student workspace that runs entirely on your machine: classes,
assignments, a serious grade calculator, Markdown notes, and a planner. Local-first, no accounts,
no telemetry, no network calls.

> Status: early development. Built so far: grade engine, storage + API, importers/exporters, UI, notes, planner & study, desktop app.

## Develop

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## Run it

```bash
npm run dev       # API + web UI in your browser (http://127.0.0.1:5173)
npm run dev:stop  # stop leftover dev servers if a port is busy
npm run desktop   # the Electron desktop app
npm run e2e       # end-to-end tests on the built app
```

See `docs/PACKAGING.md` for installers and releases.

## Layout

- `packages/grades` – pure, exact-decimal grade and GPA engine
- `packages/jsonstore` – standalone atomic JSON/Markdown storage engine
- `packages/shared` – Zod schemas and shared types
- `packages/server` – local Fastify API
- `packages/importers` – Notion/CSV/ICS/Markdown importers
- `apps/web` – React UI · `apps/desktop` – Electron shell
- `fixtures/synthetic` – generated fake data (public)

Your own data never belongs in this repo: `private-fixtures/` is gitignored and a guard
(`npm run guard`) blocks private exports from being committed.

Licensed under MIT.
