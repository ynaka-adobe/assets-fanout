# Toyota AEM Assets Fan-Out — Handoff / Pick-up-later

Last updated: 2026-09-01. Everything below is **built, deployed to Stage, and verified live** unless marked TODO.

## What this is
Event-driven fan-out post-processing for AEM Assets, from *Toyota AEM Assets Fan.docx*
(two-tier model: AEM core processing → completion event boundary → independent fan-out
branches, plus observability). Runs locally with zero cloud setup AND deployed to a real
App Builder project wired to a live AEM environment.

## Live endpoints (Stage)
- **Hosted dashboard (demo URL):** https://332794-assetsfanout-stage.adobeio-static.net/index.html
- **Web actions base:** https://332794-assetsfanout-stage.adobeioruntime.net/api/v1/web/toyota-assets-fanout
  - `POST /ingest` — AEM event webhook target (fast async ack)
  - `GET /ledger` / `GET /ledger?assetId=` — per-asset processing ledger
  - `GET /metrics` — readiness breakdown + alerting lenses
  - `POST /dlq-replay` — replay dead-lettered branches
  - `GET /core-poll` (cache read) / `GET /core-poll?refresh=1` (queries AEM) — real AEM core-tier counts
  - `POST /admin` — `{op:"resetDemo"}` (clears ledger, keeps AEM config) · `{op:"reset",confirm:"yes"}` (full wipe) · `{op:"setAemConfig",...}` · `{op:"backfill"}`
  - `POST /sim-upload` — models an upload through the core tier (demo only)

## App Builder / Console
- Org: **Adobe Customer Solutions Services Marketing** (332794)
- Project: **assetsFanout** ("AEM Assets Fan Out"), workspace **Stage**
- Runtime namespace: `332794-assetsfanout-stage`
- Local wiring: `.aio` + `.env` present. Redeploy: `aio app deploy` from this dir.
- 12 actions deployed. Alarm trigger `fanoutCorePoll` (60s) + rule `fanoutCorePollRule` → core-poll refresh.

## AEM environment
- **demo-sandbox-prod**, program **154856**, env **1944736**, author instance
- Author host: `https://author-p154856-e1944736.adobeaemcloud.com`
- Delivery host: `https://delivery-p154856-e1944736.adobeaemcloud.com`

## What works end-to-end (verified with real uploads)
1. **Event registration** "Toyota Assets Fanout Ingest" (`9e294965-…`) — verified webhook, delivers
   `aem.assets.asset.processing_completed` (CloudEvents) from AEM Assets provider `8aeed5e6-…`.
   Real Toyota uploads flowed → all reached `READY_FOR_VIA`. Trace returns 200.
2. **Async fan-out** — ingest acks in <1s; 5 branches run as independent I/O Runtime activations;
   per-branch ledger keys (no lost updates). Retry + DLQ + idempotency all work.
3. **Real AEM core-tier poller** — queries `dam:assetState` (processing / customWorkflowProcessing /
   failed) + total, excludes `cq:discarded`. 60s alarm caches to state; dashboard reads cache
   (low-impact: ~3 AEM queries/min regardless of viewers). Core tile shows live backlog + sub-values
   `X processing · Y workflow · Z failed · N total uploaded`.
4. **Durable AEM auth** — AEM Developer Console **Service Credentials** (JWT flow, valid to
   **2027-09-02**). Poller auth preference: `jwt → s2s → devtoken` (falls back). Verified
   `auth: "service-credential (jwt)"`.
5. **Dashboard** — Simulate uploads, DM zero-results, Replay DLQ, **Reset demo data** (clears
   ledger, preserves AEM config). PIM-outage button removed.

## Credentials (in scratchpad — SESSION-LOCAL, will not persist)
- `aem-service-credentials.json` — the durable JWT service cred (also stored in app state `config:aem`)
- `aem-token.txt` — the ~24h dev token (fallback; likely expired by next session)
- `332794-assetsFanout-Stage.json` — workspace config incl. OAuth S2S secret
> The durable JWT cred is in app state, so the poller keeps working across sessions. If you need
> the files again, re-download from AEM Dev Console → Integrations. Cert refresh via "Add certificate".

## Known limitations / notes
- **Core-processing count only shows non-zero when assets genuinely linger** in processing. Fast/small
  uploads go processing→processed faster than the poll interval, so the count reads 0 (not a bug).
  To SEE it move: large batch (50+), heavy files, or the stuck/failed case (the real incident story).
- **List endpoints are KV list-scans** — fine at demo scale; a production build needs a DB. If accumulated
  test data ever breaks the read endpoints (60s web-action cap), use `admin resetDemo`.
- **Manifest `inputs:` are action params, not env vars** — runtime behavior auto-detects
  (`__OW_API_KEY`, `__OW_ACTION_NAME`).

## Open decisions / TODO (where we stopped)
1. **Dynamic Media branch** — DECISION REACHED: keep DM in the fan-out but as a **readiness/verification
   branch**, not a trigger (AEM auto-syncs to Scene7; DM has no per-asset event). Real impl = poll
   `dam:scene7FileStatus` until `PublishComplete` + delivery canary (catches E-002379359). NOT yet built.
   - First check if Scene7 mode is active on the env: query assets for `dam:scene7RequestID` /
     `dam:scene7FileStatus`. If OpenAPI-only instead, use the approval + search/delivery API.
2. **DM OpenAPI** — confirmed live on the env; author `POST /adobe/assets/search` accepts the service
   token (need correct body schema); delivery needs `x-api-key` = the DM OpenAPI Client ID Adobe shared
   (get this from Yuji). Delivery URL: `.../adobe/assets/{assetId}/original/as/{seoName}`. Only **approved**
   assets are served.
3. **Prod hardening** — webhook signature verification on ingest (x-adobe-digital-signature headers arrive);
   forward metrics to a monitoring stack; confirm `dam:assetState` Oak index on large repos.
4. **Prod workspace deploy** — same app.config works on the Production workspace (UI is namespace-agnostic).

## How to resume
- Redeploy after edits: `aio app deploy`
- Reset demo state for a clean run: `POST /admin {op:"resetDemo"}` (or the Reset button)
- Confirm poller auth: `GET /core-poll?refresh=1` → look at `auth`
- The full running notes are also in Claude memory (`toyota-assets-fanout`).
