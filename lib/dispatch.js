/*
 * Branch dispatch abstraction — the seam between the demo and a real deploy.
 *
 *   DISPATCH_MODE=direct (default)  Run the branch work in-process. Used by the
 *                                   local harness, simulator, and dashboard so
 *                                   the whole flow runs in one Node process with
 *                                   no cloud. fanout() awaits and returns final
 *                                   readiness.
 *
 *   DISPATCH_MODE=async  (runtime)  Asynchronously invoke each deployed branch
 *                                   ACTION on Adobe I/O Runtime (openwhisk async
 *                                   invoke). Each branch runs in its own
 *                                   activation with its own scaling and failure
 *                                   domain — this is the architecture the doc
 *                                   prescribes ("run heavy integration logic
 *                                   outside AEM… independent branches"). fanout()
 *                                   returns immediately with activation ids; the
 *                                   branch actions update the ledger themselves.
 */

const { runBranch } = require('./branchRunner');
const { WORK } = require('./branchWork');
const { increment } = require('./metrics');

/*
 * Default to async INSIDE a deployed runtime so the webhook (ingest) acks fast
 * and does not synchronously wait for the fan-out — Adobe I/O Events times out
 * slow webhooks (~a few seconds) and retries, which is exactly what the
 * architecture doc says to avoid. Locally (harness/dashboard) there is no
 * __OW_ACTION_NAME, so we stay direct and fanout() returns final readiness.
 * DISPATCH_MODE overrides either way.
 */
function mode() {
  if (process.env.DISPATCH_MODE === 'async') return 'async';
  if (process.env.DISPATCH_MODE === 'direct') return 'direct';
  return process.env.__OW_ACTION_NAME ? 'async' : 'direct';
}

/**
 * Package that hosts the branch actions. Prefer the ACTUAL package of the
 * currently-running action (__OW_ACTION_NAME = "/namespace/package/action"), so
 * branch invokes always target siblings in the same deployed package regardless
 * of naming. FANOUT_PACKAGE is an explicit override; the literal is a last
 * resort for local/unit contexts.
 */
function packageName() {
  const parts = (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2];
  return process.env.FANOUT_PACKAGE || 'toyota-assets-fanout';
}

let _ow;
function ow() {
  // Lazy require so DISPATCH_MODE=direct never needs the dependency installed.
  // Inside a runtime activation openwhisk() auto-configures from __OW_API_HOST
  // and __OW_API_KEY.
  if (!_ow) _ow = require('openwhisk')();
  return _ow;
}

async function dispatchDirect(branchId, env) {
  return runBranch(branchId, env, WORK[branchId]);
}

async function dispatchAsync(branchId, env) {
  const res = await ow().actions.invoke({
    name: `${packageName()}/${branchId}`,
    params: env, // the branch action receives the correlation envelope as params
    blocking: false, // fire-and-forget — the branch owns its own retry/DLQ/state
  });
  await increment('branch_dispatch_count', { branch: branchId, mode: 'async' });
  return { branchId, status: 'DISPATCHED', activationId: res.activationId || null };
}

async function dispatch(branchId, env) {
  return mode() === 'async' ? dispatchAsync(branchId, env) : dispatchDirect(branchId, env);
}

module.exports = { dispatch, dispatchMode: mode };
