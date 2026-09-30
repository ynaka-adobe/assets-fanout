/*
 * Dead-letter queue. A branch that exhausts its retry budget is parked here for
 * manual intervention or replay ("Replay from the dead-letter queue", Phase 5
 * failure test). Each required branch has its own DLQ so a PIM outage never
 * blocks Dynamic Media delivery (Design Principle 2).
 */

const { getStore } = require('./store');

const key = (branchId, id) => `dlq:${branchId}:${id}`;

async function park(branchId, envelope, error) {
  const store = await getStore();
  const entry = {
    branchId,
    envelope,
    error: String(error && error.message ? error.message : error),
    parkedAt: new Date().toISOString(),
  };
  await store.put(key(branchId, envelope.branchExecutionId), entry);
  return entry;
}

async function list(branchId) {
  const store = await getStore();
  const prefix = branchId ? `dlq:${branchId}:` : 'dlq:';
  const keys = await store.list(prefix);
  return Promise.all(keys.map((k) => store.get(k)));
}

async function remove(branchId, branchExecutionId) {
  const store = await getStore();
  await store.delete(key(branchId, branchExecutionId));
}

module.exports = { park, list, remove };
