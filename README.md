# cv.haegele.dev

Private, token-gated CV and cover letter tailoring workspace.

## Features

- Access by 90-day invite token generated through GitHub Actions.
- Optional moatshift.com/Clerk session verification when Clerk settings are configured.
- Cloudflare D1 knowledge-base storage with 30-day retention.
- Immediate server-side deletion for removed files and "delete all data".
- Markdown knowledge-base uploads, max 1 MB per workspace.
- Allowlisted public profile import for GitHub, LinkedIn, Xing, and x.com.
- GitHub import includes profile metadata, public repositories, and README excerpts.
- Arbitrary HTTPS company/careers URL fetch with basic SSRF protections and stored summary.
- Workers AI-backed gap analysis, tailoring plan, Markdown CV, and Markdown cover letter generation.
- Generated CVs and cover letters are session-only and downloaded as Markdown.

## Local Development

```bash
npm ci
npm run db:migrate:local
npm run dev
```

Open:

```text
http://127.0.0.1:8787
```

Create a local token:

```bash
TOKEN="localtest-$(openssl rand -hex 12)"
HASH="$(printf '%s' "$TOKEN" | sha256sum | awk '{print $1}')"
NOW="$(node -e 'console.log(Date.now())')"
EXPIRES="$(node -e 'console.log(Date.now() + 90 * 86400000)')"
npx wrangler d1 execute recruiting-haegele-dev --local \
  --command "INSERT INTO cv_auth_tokens (id, token_hash, label, created_at, expires_at) VALUES ('tok_local', '$HASH', 'local-test', $NOW, $EXPIRES);"
echo "http://127.0.0.1:8787?token=$TOKEN"
```

## Cloudflare Setup

Required services:

- Cloudflare Workers
- Cloudflare D1
- Workers AI
- A Cloudflare-managed zone for the custom domain

`wrangler.toml` configures:

```toml
routes = [
  { pattern = "cv.haegele.dev", custom_domain = true }
]

[[d1_databases]]
binding = "DB"
database_name = "recruiting-haegele-dev"
database_id = "332a9525-1d29-44b9-9ead-2568e67acdc8"

[ai]
binding = "AI"
```

The hosted deployment uses `cv_`-prefixed tables in the existing `recruiting-haegele-dev` D1 database. The deploy workflow resolves that database, applies `src/db/schema.sql`, and deploys the Worker. For a fully separate self-hosted installation, create your own D1 database and update `wrangler.toml` plus the workflow database names.

## GitHub Actions Secrets

Required repository secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Worker, create D1, apply schema, configure custom domain |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account |

Optional repository secrets/variables for moatshift login:

| Name | Type | Purpose |
|---|---|---|
| `CLERK_JWKS_URL` | secret | Clerk JWKS endpoint used to verify moatshift session JWTs |
| `CLERK_FRONTEND_API` | variable | Optional frontend Clerk configuration |
| `CLERK_PUBLISHABLE_KEY` | variable | Optional frontend Clerk configuration |

Set secrets with GitHub CLI:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/cv-haegele-dev
gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/cv-haegele-dev
gh secret set CLERK_JWKS_URL --repo <owner>/cv-haegele-dev
```

## Token Generation

Run the manual workflow:

```text
Actions -> Create access tokens -> Run workflow
```

Defaults:

- `count`: `5`
- `label`: `invite`
- `expires_days`: `90`

The workflow stores only SHA-256 token hashes in D1 and prints usable links in the workflow summary:

```text
https://cv.haegele.dev?token=<raw-token>
```

## Deployment

Push to `main` or `master`, or run:

```text
Actions -> Deploy to Cloudflare -> Run workflow
```

Verify:

```bash
npm run smoke
SMOKE_TOKEN=<raw-token> npm run smoke
```

## Privacy Model

This app stores uploaded knowledge-base files in Cloudflare D1 for 30 days. Removing a file deletes it immediately. The "Delete all data" action deletes the full workspace knowledge base and fetched company sources immediately. Generated CVs and cover letters are not persisted by the app.
