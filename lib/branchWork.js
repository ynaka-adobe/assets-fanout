/*
 * Branch integration logic. Each function is the "heavy integration logic run
 * outside of AEM's OSGi processing" (doc, Executive Recommendation 1b) — the
 * work that used to live in serial AEM workflows now runs as an independent
 * App Builder action.
 *
 * For the demo these simulate the real downstream calls and honor fault
 * injection flags carried on the event (event.faults) so the Phase-5 failure
 * tests can be reproduced deterministically:
 *   faults.pimOutage        -> pim-sync fails until attempt >= faults.pimRecoverAtAttempt
 *   faults.dmDelayMs        -> dynamic-media-readiness is slow
 *   faults.dmZeroResults    -> dynamic-media-readiness fails (E-002379359 shape)
 *   faults.metadataConflict -> metadata-enrichment throws a contract violation
 */

const { observe, increment } = require('./metrics');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fault(env, name) {
  return (env && env.faults && env.faults[name]) || undefined;
}

// 1) Workflow synchronization — migrated first (Phase 4). Trigger custom
//    workflows off the completion event instead of a serial AEM launcher.
async function workflowSync(env) {
  await sleep(20);
  return { workflow: 'via-onboarding', step: 'terminal', assetId: env.assetId };
}

// 2) PIM synchronization — durable queue + retries + DLQ. A temporary PIM
//    outage must not stop AEM asset processing (doc: External PIM updates).
async function pimSync(env) {
  const recoverAt = fault(env, 'pimOutage') ? fault(env, 'pimRecoverAtAttempt') || Infinity : 0;
  if (env.attempt < recoverAt) {
    const e = new Error('PIM endpoint 503 (simulated outage)');
    e.code = 'PIM_UNAVAILABLE';
    throw e;
  }
  await sleep(30);
  return { pimRecordId: `pim-${env.assetId.slice(0, 8)}`, synced: true };
}

// 3) Metadata enrichment — nonessential enrichment moved off the upload path
//    (doc: Metadata enrichment recommendation).
async function metadataEnrichment(env) {
  if (fault(env, 'metadataConflict')) {
    increment('metadata_contract_violations', { branch: 'metadata-enrichment' });
    const e = new Error('dam:roles removed by uncoordinated update');
    e.code = 'METADATA_CONTRACT_VIOLATION';
    throw e;
  }
  await sleep(25);
  return { enriched: ['dc:title', 'toyota:modelYear', 'toyota:region'] };
}

// 4) Dynamic Media readiness + delivery validation — its own asynchronous
//    readiness branch; consumers must not synchronously wait for DM (doc:
//    Dynamic Media processing). Includes the canary search that would have
//    caught E-002379359 (HTTP 200 / zero results).
async function dynamicMediaReadiness(env) {
  const delay = fault(env, 'dmDelayMs') || 40;
  await sleep(delay);
  observe('dm_sync_latency_ms', delay, { branch: 'dynamic-media-readiness' });

  const canaryResults = fault(env, 'dmZeroResults') ? 0 : 1;
  increment('canary_search_result_count', { hits: String(canaryResults) });
  if (canaryResults === 0) {
    const e = new Error('DM OpenAPI search returned 200 with zero results');
    e.code = 'DM_ZERO_RESULTS';
    throw e; // retryable — DM may still be propagating
  }
  return { scene7FileStatus: 'PublishComplete', deliverable: true, canaryResults };
}

// 5) VIA indexing — final required branch; asset becomes READY_FOR_VIA only
//    after this succeeds (which requires all prior branches to have succeeded).
async function viaIndexing(env) {
  await sleep(15);
  return { viaIndexed: true, assetId: env.assetId };
}

const WORK = {
  'workflow-sync': workflowSync,
  'pim-sync': pimSync,
  'metadata-enrichment': metadataEnrichment,
  'dynamic-media-readiness': dynamicMediaReadiness,
  'via-indexing': viaIndexing,
};

module.exports = { WORK };
