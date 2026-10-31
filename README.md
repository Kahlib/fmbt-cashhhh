# FMBT Cashhhh

A private tracker for Premier League and Champions League moneyline parlays. Bets are encrypted in the browser before they're saved, so the server only ever stores ciphertext.

- React and TypeScript, built with Vite and served by Cloudflare as static files
- Supabase for sign-in and storage, locked down with row-level security
- AES-256-GCM through the browser's Web Crypto API, with keys derived from the user's password

## Running it

```
npm ci
npm run check   # lint, database tests, then build
npm run dev
```

## Security

- `public/_headers` holds the security headers, including a strict content security policy with Trusted Types.
- `supabase/migrations` holds the database. `npm run test:schema` runs 73 tests that try to break its access rules.
- `.npmrc` refuses package versions less than 3 days old and blocks install scripts.
