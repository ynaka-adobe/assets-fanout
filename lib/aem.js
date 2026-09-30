/*
 * AEM core-tier query client. AEM emits no event when an asset ENTERS or FAILS
 * processing, so the only way to observe the core tier is to query the
 * repository for dam:assetState (doc: "Assets currently in processing → Detect
 * backlog"). This covers both Toyota incidents' blind spots:
 *   - stuck in processing / customWorkflowProcessing (E-002364923)
 *   - failed processing (no completion event ever fires)
 *
 * Uses the AEM QueryBuilder JSON servlet with an IMS bearer token.
 */

// Core-tier states we care about. `processed` is terminal (handed to the event
// boundary); the rest are in-flight or failed and only visible via query.
const CORE_STATES = ['processing', 'customWorkflowProcessing', 'failed'];

async function countByState(host, token, state, path = '/content/dam') {
  const url =
    `${host}/bin/querybuilder.json?path=${encodeURIComponent(path)}` +
    `&type=dam:Asset&1_property=jcr:content/dam:assetState&1_property.value=${state}` +
    // Exclude cq:discarded (deleted/versioned) assets so the backlog is accurate.
    `&excludepaths=${encodeURIComponent('.*/cq:discarded/.*')}` +
    `&p.limit=0&p.guessTotal=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`AEM query ${state} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.json();
  return Number(body.total || 0);
}

/** Total dam:Asset under `path` (excluding cq:discarded) = total uploaded. */
async function countTotal(host, token, path = '/content/dam') {
  const url =
    `${host}/bin/querybuilder.json?path=${encodeURIComponent(path)}&type=dam:Asset` +
    `&excludepaths=${encodeURIComponent('.*/cq:discarded/.*')}` +
    `&p.limit=0&p.guessTotal=true`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const err = new Error(`AEM total query → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return Number((await res.json()).total || 0);
}

/**
 * Return live core-tier counts from AEM.
 * @returns {{processing:number, customWorkflowProcessing:number, failed:number, backlog:number, total:number, ts:string}}
 */
async function coreCounts(host, token, path) {
  const counts = {};
  await Promise.all([
    ...CORE_STATES.map(async (s) => {
      counts[s] = await countByState(host, token, s, path);
    }),
    (async () => {
      counts.total = await countTotal(host, token, path);
    })(),
  ]);
  // Backlog = everything not yet handed to the fan-out (in-flight core work).
  counts.backlog = counts.processing + counts.customWorkflowProcessing;
  counts.ts = new Date().toISOString();
  return counts;
}

module.exports = { coreCounts, countByState, CORE_STATES };
