# Toyota — Event-Driven Fan-Out for AEM Assets

A runnable **Adobe App Builder / I/O Runtime** scaffold implementing the target
architecture from *Toyota AEM Assets Fan.docx*: a two-tier model where AEM owns
core asset processing and an **event-driven fan-out** runs the heavy downstream
integrations independently, with a per-asset processing ledger and an
observability layer.

It runs **locally with zero cloud setup** (in-memory store) for demos, and
deploys to Adobe I/O Runtime unchanged (`FANOUT_STORE=aio`).

```
   AEM Assets (core tier)                    App Builder fan-out tier
 ┌────────────────────────┐   completion   ┌──────────────────────────────────┐
 │ binary upload          │    event       │ ingest → normalize → fan-out     │
 │ Asset Compute / profiles│ ─────────────▶ │        ├─ workflow-sync          │
 │ dam:assetState=processed│               │        ├─ pim-sync               │
 └────────────────────────┘               │        ├─ metadata-enrichment    │
                                          │        ├─ dynamic-media-readiness│
   each branch: own queue · retry ·          │        ├─ via-indexing           │
   │        └─ mixed-media-set (optional)
   DLQ · idempotency · state              │  ledger (state model) · metrics  │
                                          └──────────────────────────────────┘
```

## Why this shape (mapped to the doc)

| Doc concern | Where it lives here |
|---|---|
| Core tier is a mandatory stage; a completion event ≠ ready (E-002364923) | `lib/normalize.js` only crosses the boundary on `processing_completed` |
| Independent branches: own queue/retry/DLQ/idempotency/state | `lib/branchRunner.js` + `actions/branches/*` |
| Business-readiness state model + correlation envelope | `lib/states.js`, `lib/correlation.js` |
| Per-asset processing ledger **outside AEM** | `lib/ledger.js`, `actions/ledger` |
| Observability: failures / queue depth / completion lenses | `lib/metrics.js`, `actions/metrics` |
| DM zero-results canary (E-002379359) | `lib/branchWork.js` → `dynamic-media-readiness` |
| Phase-5 pilot & failure tests | `scripts/simulate.js` |

## Run the demo locally (no Adobe account needed)

```bash
cd toyota-assets-fanout
npm run dashboard  # live visual demo → http://localhost:3000
npm test           # Mixed Media regressions + ingest one asset → READY_FOR_VIA
npm run simulate   # run all Phase-5 failure scenarios (headless)
```

### Dashboard (customer-facing)

`npm run dashboard` serves a single-page dashboard that drives the fan-out and
visualizes it live — the recommended way to present this to Toyota:

- **Three alerting-lens tiles** (failures / queue depth / completion state) that
  turn green→amber→red as you inject failures.
- **Pipeline view** — the AEM core tier feeding the five branches; each branch
  dot is green/blue/amber/red with a live `ok · DLQ · retry` count.
- **Business-readiness bar** — the per-asset ledger rolled up; mostly-green with
  a red sliver when an asset dead-letters.

Buttons: *1,000-asset burst*, *Ingest 1 asset*, *Inject PIM outage*, *Inject DM
zero-results*, *Replay dead-letter queue*. Demo flow: burst (all green) →
inject a failure (a branch goes red, Failures/Queue tick up) → replay (recovers
to all green). The dashboard talks to the same actions over a thin local HTTP
server (`scripts/server.js`); in a real deployment it would call the deployed
web-action URLs instead.

Individual scenarios:

```bash
node scripts/simulate.js burst   # 1,000-asset burst
node scripts/simulate.js pim     # PIM outage → DLQ → replay
node scripts/simulate.js dup     # duplicate completion event → idempotent no-op
node scripts/simulate.js dm      # Dynamic Media zero-results canary → replay
```

Each scenario prints the three alerting lenses (failures / queue depth /
completion state) and the readiness breakdown, so you can narrate the
observability story live.

## What the code does

- **`actions/ingest`** — consumer registered on the AEM Assets
  `asset.processing_completed` I/O Event. Normalizes and dispatches. Kept
  lightweight; no heavy work on the AEM completion path.
- **`lib/fanout.js`** — opens the ledger, dispatches required branches and
  optional integrations on independent execution paths.
- **`actions/branches/*`** — five required branches and optional integrations.
  Each runs through
  `runBranch()`: retry with exponential backoff + jitter, dead-letter on
  budget exhaustion, idempotency key = `sha256(assetId:assetVersion:branch)`.
- **`mixed-media-set`** — reconciles eligible image membership in the Scene7
  sets named by AEM metadata. It is optional and does not gate readiness.
- **`actions/ledger`** — read the per-asset record: branch states, history, and
  derived business-readiness (`READY_FOR_VIA` only when all branches succeed).
- **`actions/metrics`** — metrics snapshot + the three alerting lenses.
- **`actions/dlq-replay`** — replay parked branch executions after a dependency
  recovers.

### Fault injection (for the demo only)

The branch logic honors flags on the event's `data.faults`, so failure modes
are deterministic and repeatable:

| Flag | Effect |
|---|---|
| `pimOutage` + `pimRecoverAtAttempt` | `pim-sync` fails until that attempt |
| `dmZeroResults` | `dynamic-media-readiness` returns HTTP 200 / zero hits |
| `dmDelayMs` | slow Dynamic Media propagation |
| `metadataConflict` | `metadata-enrichment` contract violation (`dam:roles`) |

Remove the whole `faults` block for real events.

### Optional Scene7 Mixed Media Set branch

The branch processes images under `/content/dam/brand/Brand 14/` and ignores
other paths and non-image assets. It unions the literal set names in AEM's
`masterPartRecordKeys` and `businessUnitPartRecordKeys` metadata properties.
Configure those properties in the AEM asset metadata schema and populate them
before using the integration. AEM metadata updates dispatch only this branch
when either exact, case-sensitive property changes; both `event:updated` and
`event:created` event fields are recognized. Completion events continue to
dispatch the five required branches and this optional branch.

Scene7 creates a missing set or adds the image only when it is absent from an
existing set. Repeated events leave existing memberships unchanged and do not
trigger redundant publishes. Only IPS fault `30000` with the Image Serving
Publish “already running” reason is treated as a successful publish; other
Scene7 errors remain retryable and can dead-letter.

Set `S7_SERVER`, `S7_COMPANY_HANDLE`, `S7_USER`, `S7_PASSWORD`,
`S7_SOURCE_IMAGE_FOLDER_PATH`, `S7_SET_SEARCH_FOLDER_PATH`, and
`S7_SET_FOLDER_PATH` in the ignored local `.env`; `app.config.yaml` maps these
values to action inputs. All three folder paths are required, company-relative,
and end in `/`. Source-image lookup, set search, and new-set destination are
separate settings. Leave them empty to safely skip the optional integration.
Keep real credentials out of source control and logs.

## Deploy to Adobe I/O Runtime

Prereqs: an App Builder project + workspace, `aio` CLI, the AEM Assets event
provider available in your org.

```bash
aio login
cp .env.example .env      # fill namespace/auth; keep FANOUT_STORE=aio
aio app deploy
```

Then register `ingest` as the webhook for AEM Assets
`asset.processing_completed`, and add `asset.metadata_updated` if using Mixed
Media Sets (Adobe Developer Console → your project → Events → add AEM Assets →
select each event → point the webhook at the deployed `ingest` URL). Web action
URLs are printed by `aio app deploy`; check the ledger and metrics with:

```bash
curl "$LEDGER_URL?assetId=<assetId>"
curl "$METRICS_URL"
```

### Branch dispatch modes

Dispatch is a seam (`lib/dispatch.js`). It **auto-detects**: a deployed action
(`__OW_ACTION_NAME` present) defaults to **async**; locally it is **direct**.
`DISPATCH_MODE=async|direct` overrides.

| Mode | Where | Behavior |
|---|---|---|
| `direct` | local harness / dashboard | Branches run in-process; `fanout()` awaits and returns final readiness. |
| `async` | Adobe I/O Runtime (default there) | `fanout()` **async-invokes each branch action** (`openwhisk`, `blocking:false`). `ingest` acks in ~0.8s (warm) / ~1.6s (cold) so the AEM I/O Events webhook does not time out; branches run in their own activations and drive the ledger to `READY_FOR_VIA` afterward. |

In async mode readiness is **eventual** — read it from `ledger` / `metrics`
(the dashboard polls them), not from the `ingest` response.

Async is safe because the ledger stores each branch's state under its own key
(`branch:<assetId>:<branchId>`), so branches in separate containers never
contend — no lock or transaction needed (`lib/ledger.js`).

**Why async matters (learned from a live test):** with direct dispatch the
deployed `ingest` took ~5.5s (synchronous fan-out); Adobe I/O Events timed out
the webhook and recorded response `604` + retried. Async + memoizing the
`aio-lib-state` client (it was re-`init()`-ing on every op — the real cold-start
cost) brought deliveries to a clean `200`.

### Deployed environment (Stage)

Live on App Builder project **assetsFanout**, workspace **Stage**, namespace
`332794-assetsfanout-stage`. Web action base URL:

```
https://332794-assetsfanout-stage.adobeioruntime.net/api/v1/web/toyota-assets-fanout
```

`ingest` (POST), `ledger` (GET `?assetId=`), `metrics` (GET), `dlq-replay`
(POST). Deployed with durable `aio-lib-state` and **direct** dispatch (see
below). Redeploy with `aio app deploy`.

**AEM Assets event registration (live).** The Stage workspace subscribes I/O
Management API + I/O Events (OAuth S2S credential) and has a verified webhook
registration ("Toyota Assets Fanout Ingest", `9e294965-…`) delivering
`aem.assets.asset.processing_completed` from the org's AEM Assets provider
`8aeed5e6-…` (`demo-sandbox-prod`, program 154856 / env 1944736) to the `ingest`
URL as CloudEvents v1. `ingest` echoes the raw I/O Events challenge for
verification; `lib/normalize.js` reads the real payload shape (`data.assetId`,
`data.repositoryMetadata['repo:path']` / `['repo:version']`). Manage with
`aio event registration list|get|delete`.

**Hosted dashboard (shareable).** The static UI in `web-src/` is deployed to the
App Builder CDN and is the customer-facing demo URL:

```
https://332794-assetsfanout-stage.adobeio-static.net/index.html
```

It calls the web actions via a relative same-origin base (the CDN host proxies
`/api/v1/web/*` to the runtime), so it is namespace-agnostic — the same build
works on Prod. The actions also return CORS headers (`lib/http.js`,
`web-custom-options: true`) so the UI works cross-origin if embedded elsewhere.
Buttons drive real cloud ingests, fault injection, and DLQ replay.

**Local dev dashboard.** `npm run dashboard` (`scripts/server.js` + `public/`)
runs a Local/Stage toggle for offline development; Stage proxies to the deployed
actions server-side.

Runtime gotchas handled (aio-lib-state): keys must match
`^[a-zA-Z0-9-_.]{1,1024}$` (URNs are encoded in `lib/store.js`); TTL is capped
at 365 days and infinite TTL is rejected (we use the max). Manifest `inputs:`
arrive as action **params, not env vars**, so store/dispatch mode are
auto-detected from `__OW_API_KEY` / `__OW_ACTION_NAME` instead.

### Production notes (still to wire for a real deploy)

- **Async dispatch is off in the deployed app on purpose.** Across separate
  branch containers the shared-ledger read-modify-write races (aio-lib-state has
  no transactions), which makes end-state flaky. Direct dispatch (single
  container + in-process lock) is reliable for the demo. Enable async only after
  the concurrency fix below.
- **Ledger concurrency** uses an in-process lock. Across separate invocations,
  `aio-lib-state` has no transactions — use optimistic concurrency
  (version/etag check + retry) or a store that supports conditional writes.
- **Webhook auth** — verify the Adobe I/O Events signature on `ingest` before
  trusting a payload.
- **Metrics** — forward `lib/metrics` counters to your monitoring stack (New
  Relic / CloudWatch / Grafana) and wire the three lenses to real alerts.

## Layout

```
app.config.yaml          # I/O Runtime manifest (actions, event consumer)
actions/
  ingest/                # event boundary entrypoint
  branches/*/            # five required and optional Mixed Media branches
  ledger/  metrics/  dlq-replay/
lib/
  states.js  correlation.js  normalize.js  fanout.js
  branchRunner.js  branchWork.js  ledger.js  dlq.js  store.js  metrics.js
scripts/simulate.js      # Phase-5 pilot & failure scenarios
test/mixed-media-set.js  # optional Mixed Media branch regression coverage
test/harness.js          # happy-path end-to-end
```
