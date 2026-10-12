# Architecture

The backend owns the contracts, limits, tool registry, skills, credits, and durable state. The frontend is a separate repository and imports the Zod contracts through `pnpm contracts:sync`. That command copies them with a content hash, and `contracts:check` fails if the copy has drifted.

## Request path

1. The frontend sends the Clerk session token as `Authorization: Bearer`.
2. `proxy.ts` adds a request id and allows only `FRONTEND_ORIGIN`.
3. `route()` authenticates, validates with Zod, and turns every thrown error into `{ error: { code, message, retryable, traceId } }`. Unexpected errors do not return their message.
4. `sendMessage` locks the chat row, then either replays a duplicate `clientMessageId` or returns `409 RUN_ACTIVE` with the existing run id. Attachments must be the user's own assets with unique positions.
5. One transaction writes the user message, attachments, the assistant message, the run, and a refundable credit hold.
6. Trigger.dev receives `agent-turn` with idempotency key `runId`. If dispatch fails, the run stays `queued` and the reconciler retries it with the same key.

## Agent turn

`executeAgentTurn` loads the newest 100 messages, adds the user's attachments to the prompt in order, restores the run's loaded skills from `RunSkill`, and calls `runAgentLoop`. The loop talks to OpenRouter only through `openrouter/free`. The request has no `models` fallback, and the routed model name is stored on the run.

Every tool comes from one registry, which defines its label, renderer key, billing flag, Zod input and output, credit estimate, and execution mode. `GET /v1/tools` serves those descriptors.

- `inline` tools (`load_skill`, `read_skill_asset`) run in parallel.
- `durable` tools (Crop Image, GPT Image 2, and Merge Videos) run as one `batchTriggerAndWait`. Results are saved in tool-call order.
- Approvals are not tools. Plan mode and the credit threshold open a Trigger.dev waitpoint from the loop. Trigger.dev allows one wait at a time, so those waits happen before the batch.

Policies run before any credit is held:

- **Plan mode.** A run started in plan mode cannot use a billable tool until a `plan` waitpoint in that run is approved.
- **Credit approval.** A billable tool whose estimate is at least `CREDIT_APPROVAL_THRESHOLD_MICROCREDITS` opens a `credit` waitpoint. A decline becomes a tool error that the model can see.
- **Expired waitpoint.** The run ends `cancelled` with `WAITPOINT_EXPIRED`, and a `system` message tells the user to send a message to continue.

## Magica

1. Each call checks its input against the live schema from `GET /v1/models/{id}/schema`, cached for 10 minutes.
2. It then calls `POST /v1/nodes/{nodeType}/run` and saves the returned `runId` before polling `GET /v1/nodes/runs/{runId}`.
3. A retry that already has a `runId` does not POST again.

Two things are fixed locally: the complete crop rectangle the spec requires, and which GPT Image 2 mode to use (edit when `uploadedImages` is present). Every other field comes from the live schema.

Magica does not document an idempotency key. A crash between the POST and the save can therefore still create a second provider run.

Every generated image, video, or audio URL is saved as an `Asset` with `source = generated`, and appears in the media library.

## Credits

Credits are stored in microcredits; Magica's estimate docs divide by 1,000,000. Holds are taken before billable work, captures use a unique ledger key, and the unused hold is released once when the run finishes. OpenRouter token usage gets a zero-credit ledger row.

## Uploads

1. `POST /v1/uploads/assemblies` validates the declared files: media type, a 500 MB per-file cap, and at most 8 files.
2. It reserves those bytes against the 5 GB monthly budget, which is shared by the whole Transloadit account.
3. It returns Assembly params signed with HMAC-SHA384, plus the upload id in `fields`. The secret never leaves the server.

Completion arrives two ways, and both end in the same idempotent `applyAssemblyStatus`:

- Transloadit's signed `notify_url` POST, verified with HMAC-SHA1 over the raw `transloadit` field.
- The client's `POST /v1/uploads/:id/complete`. The server re-reads the Assembly status from Transloadit instead of trusting the client.

Only `ASSEMBLY_COMPLETED` creates assets. A repeat delivery does not change state again.

Result URLs from the configured `TRANSLOADIT_RESULT_STEP` are stored. If that step is unset, or Transloadit marks a URL as temporary, the asset is flagged `isTemporaryUrl`. The template must store files in S3-compatible storage for permanent URLs.

## Realtime

Postgres is the source of truth. Trigger streams carry Zod-checked text and thinking chunks (`agentChunkSchema`). Run metadata (`runMetadataSchema`) carries the status, active tools, and any pending waitpoint. `GET /runs/:id` returns the same waitpoint shape for the REST fallback.

Cancelling does three things: it sets `stopping`, releases any pending waitpoint, and sends the `cancel` input stream. The loop also checks the database flag at each step.

The reconciler runs every minute. It dispatches runs that were saved but never sent to Trigger.dev, clears locks held by finished runs, and expires stale waitpoints. It also finalizes runs whose Trigger.dev run has ended without writing back.

## Skills

`agent-skills/<name>/SKILL.md` is scanned once per process. The base prompt receives only names and descriptions. Bodies are returned only by `load_skill`, and the run stores each body by its content hash.

On a retry, `load_skill` returns the recorded body even if the file has changed. Asset reads are resolved with `realpath` and confined to the skill directory.
