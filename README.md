# FMBT Cashhhh

A private tracker for Premier League and Champions League moneyline parlays. Bets are encrypted in the browser before they're saved, so the server only ever stores ciphertext.

- React and TypeScript, built with Vite and served by Cloudflare as static files
- Supabase for sign-in and storage, locked down with row-level security
- AES-256-GCM through the browser's Web Crypto API, with keys derived from the user's password

## Running it

```
npm ci
npm run check   # lint, env check, database tests, unit tests, then build
npm run dev     # needs .env.development.local with the dev project's two values
```

## Security

- `public/_headers` holds the security headers, including a strict content security policy with Trusted Types.
- `supabase/migrations` holds the database. `npm run test:schema` runs every migration in order, then 77 tests that try to break its access rules.
- `.npmrc` refuses package versions less than 3 days old and blocks install scripts.
- `scripts/check-env.ts` makes sure the only values a build can see are production's address and publishable key, which are public.
- `supabase/functions/recover` is the Forgot password server function. It checks a recovery proof and sets the new password, and gives the same answer to every failure.
