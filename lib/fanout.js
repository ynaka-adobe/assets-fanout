/*
 * Fan-out dispatcher (the event boundary, doc Phase 3 + Target Architecture
 * "Fan-out Tier"). Runs AFTER the AEM core asset-processing completion point.
 *
 * It opens the ledger for the asset, then dispatches each required branch on
 * its own independent execution path. A PIM failure never blocks Dynamic Media
 * (Design Principle 2). The doc's migration ORDER (states.REQUIRED_BRANCHES)
 * governs rollout, not runtime ordering — at steady state all branches are
 * dispatched together.
 *
 * Dispatch is delegated to lib/dispatch.js:
 *   - direct mode (local): branches run in-process; we await final readiness.
 *   - async mode (runtime): branches run as their own I/O Runtime activations;
 *     we return immediately after dispatch and the branch actions update the
 *     ledger. Readiness is then eventual — read it from the ledger/metrics.
 */

const { buildEnvelope, uuid } = require('./correlation');
const ledger = require('./ledger');
const { dispatch, dispatchMode } = require('./dispatch');
const { REQUIRED_BRANCHES } = require('./states');
const { increment } = require('./metrics');

/**
 * @param {object} assetEvent normalized Toyota asset event (see normalize.js)
 * @param {object} [opts] { branches?: string[] } restrict to a subset (canary)
 */
async function fanout(assetEvent, opts = {}) {
  const base = buildEnvelope(assetEvent);
  await ledger.open(base);
  await increment('fanout_dispatched', { program: base.aemProgram });

  const branches = opts.branches || REQUIRED_BRANCHES;
  const results = await Promise.all(
    branches.map((branchId) => {
      const env = {
        ...base,
        branchId,
        branchExecutionId: uuid(),
        eventId: uuid(),
        faults: assetEvent.faults, // fault-injection passthrough for pilot tests
      };
      return dispatch(branchId, env);
    })
  );

  const record = await ledger.load(base.assetId);
  return {
    assetId: base.assetId,
    dispatchMode: dispatchMode(),
    // In async mode readiness reflects only dispatch (BRANCH_PENDING/RUNNING);
    // the branch activations drive it to READY_FOR_VIA afterward.
    readiness: record.readiness,
    branches: results,
  };
}

module.exports = { fanout };
