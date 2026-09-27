# Contributing

Thanks for helping improve Form Worker.

## Getting started

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev        # http://localhost:8787/admin
```

Before opening a pull request:

```bash
npm run typecheck   # generates worker-configuration.d.ts from wrangler.jsonc and .dev.vars, then runs tsc
npm test
```

To try Turnstile locally, put `TURNSTILE_SECRET_KEY` in `.dev.vars`. Cloudflare's test secret `1x0000000000000000000000000000000AA` always passes.

## Guidelines

- **Stay on the free plan.** Features must work on Cloudflare's Workers Free plan without extra services.
- **Keep it small.** No frontend framework or build step for the dashboard; plain HTML, CSS and JavaScript in `src/admin/ui/`.
- **Schema changes** go in a new numbered file in `migrations/`. Never edit an existing migration.
- **Spam rules** live in `src/spam.ts`. Add a test in `test/spam.test.ts` for every new signal, including one showing a genuine message is not flagged.
- **Security:** insert user data with `textContent` in the UI, never `innerHTML`; keep secrets out of code and config.

## Reporting bugs

Open an issue with steps to reproduce, what you expected and what happened. For security issues, see [SECURITY.md](SECURITY.md).
