/*
 * Dead-letter replay action (doc Phase 5 failure test: "Replay from the
 * dead-letter queue"). Re-runs parked branch executions once the underlying
 * dependency (e.g. PIM) has recovered. Idempotency keys make replay safe even
 * if the original attempt partially succeeded.
 *
 * POST { branchId?, faults? }  faults lets the demo clear the injected outage.
 */

const dlq = require('../../lib/dlq');
const { runBranch } = require('../../lib/branchRunner');
const { WORK } = require('../../lib/branchWork');
const { json, preflight } = require('../../lib/http');

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    const entries = await dlq.list(params.branchId);
    const replayed = [];

    for (const entry of entries) {
      const { branchId, envelope } = entry;
      // Clear the injected fault on replay so a recovered dependency succeeds.
      const env = { ...envelope, faults: params.faults || {}, attempt: 0 };
      const result = await runBranch(branchId, env, WORK[branchId]);
      if (result.status === 'SUCCEEDED') {
        await dlq.remove(branchId, envelope.branchExecutionId);
      }
      replayed.push({ assetId: env.assetId, branchId, status: result.status });
    }

    return json(200, { replayedCount: replayed.length, replayed });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
