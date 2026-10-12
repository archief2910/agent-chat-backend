# Agent Chat backend

API and agent runtime for the Galaxy Agent Chat work trial. The frontend lives in a separate repository.

## Status

Backend features in this repo:

- Versioned REST routes for chats, messages, runs, cancel, realtime tokens, approvals, uploads, the media library, credits, tools, models, and config
- Prisma schema and SQL migrations, with cursor indexes, full-text search, and non-negative credit and byte checks
- One active run per chat, idempotent sends, and a reconciler for undispatched runs, stale locks, expired approvals, and lost workers
- An OpenRouter Free streaming loop with no paid fallback
- One tool registry that drives discovery, validation, credit estimates, execution mode, and renderer keys
- On-demand skills; a retry replays the recorded skill body
- Crop Image, GPT Image 2, and Merge Videos called through Magica, checked against the live model schema
- Plan mode and credit approval are waitpoints the run loop opens itself. They are not model tools. The waitpoint registry still validates options, plan, credit, and media answers.
- Transloadit signed uploads, plan limits, the monthly budget, verified notifications, and idempotent completion
- Generated and uploaded media stored as assets
- Zod contracts for realtime chunks and run metadata, plus a contracts sync script for the frontend
- Global API errors, request ids, and structured logs

The public API adds `POST /api/v1/chat/completions`, `POST /api/v1/tools/{name}/runs`, API keys, and signed outbound webhooks. Mintlify source is in `mintlify/`. Deploy that folder to Mintlify to get a hosted URL. A live Magica success run is `pnpm test:live` with `MAGICA_LIVE=1` and `MAGICA_API_KEY` set. The default test suite does not call Magica.

## Setup

Requirements: Node 24, pnpm 10 (`corepack pnpm`), Docker, and accounts for Clerk, Trigger.dev, OpenRouter, and Magica.

```bash
docker compose up -d
cp .env.example .env
corepack pnpm install
corepack pnpm db:deploy
corepack pnpm dev
corepack pnpm trigger:dev
```

The API listens on port 3001. `OPENROUTER_MODEL` must be the literal `openrouter/free`. The process refuses any other value.

Tests:

```bash
corepack pnpm test
corepack pnpm typecheck
```

## Credit unit

Magica's estimate endpoint documents microcredits, and one credit is 1,000,000 microcredits. The ledger stores microcredits. The admission hold defaults to 5,000, which is the public catalog estimate for one Crop Image. A new user receives 10 credits once.

## Architecture overview

Postgres is the source of truth for chats, messages, runs, tool results, skills, credits, assets, and approvals. Trigger.dev runs the turn, streams text, and holds waitpoint tokens. A reload reads the database. The stream is only the live view.

One registry owns every model-visible tool: `load_skill`, `read_skill_asset`, Crop Image, GPT Image 2, and Merge Videos. `GET /api/v1/tools` returns that same list. The three Magica tools are the only billable ones, and they run as one `batchTriggerAndWait` because Trigger.dev allows a single wait at a time.

The frontend is a separate app. It consumes `src/contracts` through `pnpm contracts:sync`. Longer notes on the request path are in `docs/architecture.md`.

## Design decisions and trade-offs

- **Approvals stay out of the tool list.** Plan mode and the credit threshold pause the run from the loop. A declined plan or credit charge becomes a tool error the model can read. Options and media remain valid waitpoint kinds for the respond API, but the loop does not open them, because that would have required another model-visible tool.
- **Postgres over the stream.** Checkpoints, tool rows, and the credit ledger survive a worker crash. The reconciler redispatches a queued run with the same Trigger idempotency key, clears a stale chat lock, and expires a waitpoint that outlived its token.
- **One Magica batch.** Parallel `triggerAndWait` calls are rejected by Trigger.dev. Interactive waits therefore happen before the batch, one at a time.
- **Crop geometry is local. GPT fields are live.** The crop input requires exactly one complete rectangle, which is what the spec asks for. GPT Image 2 only fixes `prompt` and optional `uploadedImages`; every other field is checked against the live schema for the text or edit submodel.
- **Credits are microcredits.** One credit is 1,000,000 microcredits, matching Magica's estimate endpoint. The ledger never stores a negative balance. The approval threshold defaults to 1 credit and is a placeholder you can set to 0.
- **OpenRouter Free has no paid fallback.** The model id is a Zod literal. A 429 retries three times only before any visible text, then the run fails as `MODEL_RATE_LIMITED`.
- **Uploads are signed, not proxied.** The browser uploads to Transloadit with Uppy. This server signs the params and checks the result. The template's store step, named by `TRANSLOADIT_RESULT_STEP`, is what lands the file in storage.
- **Skill text is snapshotted.** A retry replays the body recorded on the run, even if the file changed later.
- **History is the newest 100 messages**, then reversed into chronological order. Taking the oldest 100 would drop the current turn in a long chat.

## What I would improve with more time

- Match the live Galaxy chat pixel for pixel: tool cards, streaming chrome, approval overlays, and the artifact panel. The current shell follows screenshots already provided. It is not a measured copy.
- Run Crop Image, Merge Videos, and a generate-then-crop conversation against the real Magica key. GPT Image 2 has completed live. The default test suite uses fixtures.
- Put uploads in a bucket. The browser already signs and uploads through Uppy and Transloadit. `TRANSLOADIT_RESULT_STEP` is empty, so a result URL can still expire.
- Host the Mintlify docs and deploy both apps. Local Postgres already has the migrations applied. A public deploy needs a hosted database.
- Replace step-count progress with a provider percent if Magica ever returns one.
- Persist the Magica `runId` in the same step as the POST. Magica documents no idempotency key, so a crash between those two steps can still start a second provider run.

## Layout

- `src/app/api/v1` routes
- `src/lib` env, errors, logging, auth, and the route wrapper
- `src/server` chats, turns, credits, the agent loop, skills, and Magica
- `src/trigger` durable tasks
- `agent-skills` on-demand guidance
- `prisma/migrations` executable SQL
