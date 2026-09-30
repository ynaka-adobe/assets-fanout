/*
 * Metrics endpoint — the observability strategy's scrape target (doc: "Increase
 * Observability"). Also computes the three alerting lenses so the demo can show
 * a threshold breach without a full monitoring stack:
 *   1. Failures      — branch_failure_count / dead_letter_count
 *   2. Queue depth   — assets not yet READY_FOR_VIA
 *   3. Completion    — assets stuck without expected state transitions
 */

const { snapshot } = require('../../lib/metrics');
const ledger = require('../../lib/ledger');
const { READINESS } = require('../../lib/states');
const { json, preflight } = require('../../lib/http');

const STUCK_AFTER_MS = Number(process.env.STUCK_AFTER_MS || 5 * 60 * 1000);

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    const metrics = await snapshot();
    const records = await ledger.all();
    const now = Date.now();

    const notReady = records.filter((r) => r.readiness !== READINESS.READY_FOR_VIA);
    const stuck = notReady.filter((r) => now - new Date(r.updatedAt).getTime() > STUCK_AFTER_MS);
    const deadLettered = records.filter((r) => r.readiness === READINESS.BRANCH_TERMINAL_FAILURE);
    // Core tier: assets modeled as still processing in AEM (before the event
    // boundary) — the backlog that the Toyota E-002364923 incident represents.
    const coreProcessing = records.filter((r) => r.readiness === READINESS.CORE_PROCESSING);

    return json(200, {
      metrics,
      alertingLenses: {
        failures: { deadLetteredAssets: deadLettered.length },
        queueDepth: { assetsNotReadyForVia: notReady.length },
        coreProcessing: { assetsInCoreProcessing: coreProcessing.length },
        completionState: { stuckAssets: stuck.length, thresholdMs: STUCK_AFTER_MS },
      },
      readinessBreakdown: countBy(records, 'readiness'),
    });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

function countBy(arr, field) {
  return arr.reduce((acc, x) => ((acc[x[field]] = (acc[x[field]] || 0) + 1), acc), {});
}

exports.main = main;
