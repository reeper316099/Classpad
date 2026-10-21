# Classpad

A calm, fast, open-source student workspace that runs entirely on your machine: classes,
assignments, a serious grade calculator, Markdown notes, and a planner. Local-first, no accounts,
no telemetry, no network calls.

> Status: early development (M0–M2: scaffold, grade engine, storage + API).

## Develop

```bash
npm install
npm test
npm run typecheck
npm run lint
```

## Layout

- `packages/grades` – pure, exact-decimal grade and GPA engine
- `packages/jsonstore` – standalone atomic JSON/Markdown storage engine
- `packages/shared` – Zod schemas and shared types
- `packages/server` – local Fastify API
- `fixtures/synthetic` – generated fake data (public)

Your own data never belongs in this repo: `private-fixtures/` is gitignored and a guard
(`npm run guard`) blocks private exports from being committed.

Licensed under MIT.
