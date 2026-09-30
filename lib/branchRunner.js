/*
 * Branch execution wrapper. Every fan-out branch runs through this so they all
 * share the same operational contract (Design Principle 2): its own retry
 * policy, dead-letter handling, idempotency key, and success/failure state —
 * recorded in the ledger, not in AEM.
 */

const { getStore } = require('./store');
const { idempotencyKey } = require('./correlation');
const ledger = require('./ledger');
const dlq = require('./dlq');
const { BRANCH } = require('./states');
const { increment, observe } = require('./metrics');

const DEFAULT_MAX_ATTEMPTS = Number(process.env.BRANCH_MAX_ATTEMPTS || 3);
const DEFAULT_BASE_BACKOFF_MS = Number(process.env.BRANCH_BASE_BACKOFF_MS || 200);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Has this (asset, revision, branch) already succeeded? Duplicate = no-op. */
async function alreadyProcessed(envelope, branchId) {
  const store = await getStore();
  const k = `idem:${idempotencyKey(envelope, branchId)}`;
  return Boolean(await store.get(k));
}

async function markProcessed(envelope, branchId) {
  const store = await getStore();
  await store.put(`idem:${idempotencyKey(envelope, branchId)}`, {
    at: new Date().toISOString(),
    branchExecutionId: envelope.branchExecutionId,
  });
}

/**
 * Run one branch's business logic with retry + DLQ + idempotency.
 *
 * @param {string} branchId   e.g. 'pim-sync'
 * @param {object} envelope   correlation envelope for this branch attempt
 * @param {(env)=>Promise} work  the branch's actual integration logic
 * @param {object} [opts]     { maxAttempts, baseBackoffMs }
 */
async function runBranch(branchId, envelope, work, opts = {}) {
  const maxAttempts = opts.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const baseBackoff = opts.baseBackoffMs || DEFAULT_BASE_BACKOFF_MS;

  increment('branch_dispatch_count', { branch: branchId });

  if (await alreadyProcessed(envelope, branchId)) {
    increment('idempotency_conflicts', { branch: branchId });
    return { branchId, status: BRANCH.SUCCEEDED, deduped: true };
  }

  await ledger.updateBranch(envelope.assetId, branchId, { state: BRANCH.RUNNING });

  let attempt = 0;
  let lastError = null;
  const startedAt = Date.now();

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const result = await work({ ...envelope, attempt });
      await markProcessed(envelope, branchId);
      await ledger.updateBranch(envelope.assetId, branchId, {
        state: BRANCH.SUCCEEDED,
        attempts: attempt,
        lastError: null,
      });
      increment('branch_success_count', { branch: branchId });
      observe('branch_latency_ms', Date.now() - startedAt, { branch: branchId });
      return { branchId, status: BRANCH.SUCCEEDED, attempts: attempt, result };
    } catch (err) {
      lastError = err;
      increment('retry_count', { branch: branchId, reason: err.code || 'error' });
      await ledger.updateBranch(envelope.assetId, branchId, {
        state: BRANCH.RETRYABLE_FAILURE,
        attempts: attempt,
        lastError: String(err.message || err),
      });
      if (attempt < maxAttempts) {
        // Exponential backoff with jitter — "retry count and backoff duration".
        const backoff = baseBackoff * 2 ** (attempt - 1) + Math.floor(Math.random() * baseBackoff);
        await sleep(backoff);
      }
    }
  }

  // Retry budget exhausted → dead-letter for manual intervention / replay.
  await dlq.park(branchId, { ...envelope, attempt }, lastError);
  await ledger.updateBranch(envelope.assetId, branchId, {
    state: BRANCH.DEAD_LETTER,
    attempts: attempt,
    lastError: String(lastError && lastError.message ? lastError.message : lastError),
  });
  increment('branch_failure_count', { branch: branchId });
  increment('dead_letter_count', { branch: branchId });
  return { branchId, status: BRANCH.DEAD_LETTER, attempts: attempt, error: String(lastError) };
}

module.exports = { runBranch };
