![CV Workspace](docs/logo.svg)

AI-assisted CV and cover letter tailoring workspace on Cloudflare Workers.

Live demo: [cv.haegele.dev](https://cv.haegele.dev)

![CV Workspace screenshot](docs/CV%20tailoring%20workspace.png)

## How it works

A single chat window where the AI agent leads you through the CV tailoring process:

1. **Build your knowledge base** — upload Markdown files or import a GitHub/LinkedIn/Xing profile via URL
2. **Provide the job description** — upload a `.md`/`.txt` file or paste a URL; the agent fetches and stores it
3. **Company research** — the agent searches the company site for hiring signals and AI usage policy
4. **Gap analysis** — identifies skills to emphasise or fill
5. **Tailoring plan → CV → Cover letter** — heavy generation runs as Cloudflare Workflows (up to 4 min per step); results stream back to your browser

The collapsible sidebar manages your knowledge base files. Outputs are rendered as Markdown and downloadable.

## Features

- Chat-first UI with clickable choice chips guiding each step
- Cloudflare Durable Objects for per-workspace session state (WebSocket hibernation)
- Cloudflare Workflows for long-running AI generation (retries, memoised steps)
- Cloudflare D1 knowledge-base storage with 30-day retention
- Immediate server-side deletion for removed files and "delete all data"
- Markdown knowledge-base uploads, max 1 MB per workspace
- Allowlisted public profile import: GitHub (with README excerpts), LinkedIn, Xing, X
- Company AI usage policy detection; defaults to [Anthropic candidate AI guidance](https://www.anthropic.com/candidate-ai-guidance)
- CV language auto-detected from the job description (English/German)
- Daily token budget enforced via D1 counter
- Marked.js for Markdown rendering; no external UI framework

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

## Cloudflare Setup

Required services:

- Cloudflare Workers
- Cloudflare D1
- Workers AI
- Cloudflare Durable Objects
- Cloudflare Workflows
- A Cloudflare-managed zone for the custom domain

`wrangler.toml` configures all bindings. For a self-hosted installation, create your own D1 database and update `wrangler.toml`.

## GitHub Actions Secrets

Required repository secrets:

| Secret | Purpose |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy Worker, create D1, apply schema, configure custom domain |
| `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account |

Set secrets with GitHub CLI:

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo <owner>/cv-haegele-dev
gh secret set CLOUDFLARE_ACCOUNT_ID --repo <owner>/cv-haegele-dev
```

## Deployment

Push to `main` or `master`, or run:

```text
Actions -> Deploy to Cloudflare -> Run workflow
```

Verify:

```bash
npm run smoke
```

## Privacy Model

Uploaded knowledge-base files are stored in Cloudflare D1 for 30 days. Removing a file deletes it immediately. "Delete all data" deletes the full workspace knowledge base immediately. Generated CVs and cover letters are not persisted server-side; they are rendered in-browser and downloaded as Markdown.

## License

MIT
