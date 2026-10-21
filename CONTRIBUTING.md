# Contributing

Thanks for helping! Requirements: Node 22+, npm 10+.

1. `npm install` (also installs the pre-commit guard via `npx simple-git-hooks`).
2. Make changes with tests. `npm run lint && npm run typecheck && npm test` must pass.
3. Grade math must use exact decimals (`decimal.js`) and return a step-by-step breakdown.
4. Never commit real student data, third-party template content, or branding. Use
   `fixtures/synthetic/` only. See `docs/CONTRIBUTING-DEV.md`.
5. Open a PR using the template. Be kind: see the Code of Conduct.

Good first issues: new letter-scale presets, CSV templates, additional Markdown note templates.
