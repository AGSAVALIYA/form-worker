# Security

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/AGSAVALIYA/form-worker/security/advisories/new) instead, with
steps to reproduce and the impact you expect.

## Deployment checklist

- Protect `/admin` with Cloudflare Access, or use a long random `ADMIN_PASSWORD`.
- Store `SMTP_PASS`, `ADMIN_PASSWORD` and `TURNSTILE_SECRET_KEY` as Worker **secrets**, never in `wrangler.jsonc`.
- Give each site its own form so API keys can be rotated independently.
- Set a retention period on every form that matches the site's privacy policy.
