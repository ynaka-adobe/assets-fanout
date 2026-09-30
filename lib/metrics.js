/*
 * Lightweight metrics collection backing the observability strategy (doc:
 * "Increase Observability" — Failures, Queue depth, Completion state).
 *
 * Counters/histograms are persisted to the store so they survive across
 * stateless action invocations and can be scraped by the /metrics web action.
 * In production you would forward these to New Relic / CloudWatch / Grafana;
 * here they are aggregated in the same durable store as the ledger.
 */

const { getStore } = require('./store');

const dimKey = (dims) =>
  Object.keys(dims || {})
    .sort()
    .map((k) => `${k}=${dims[k]}`)
    .join(',') || '_';

async function increment(name, dims = {}, by = 1) {
  const store = await getStore();
  const k = `metric:counter:${name}:${dimKey(dims)}`;
  const cur = (await store.get(k)) || { name, dims, value: 0 };
  cur.value += by;
  await store.put(k, cur);
}

async function observe(name, value, dims = {}) {
  const store = await getStore();
  const k = `metric:hist:${name}:${dimKey(dims)}`;
  const cur = (await store.get(k)) || { name, dims, count: 0, sum: 0, min: value, max: value };
  cur.count += 1;
  cur.sum += value;
  cur.min = Math.min(cur.min, value);
  cur.max = Math.max(cur.max, value);
  await store.put(k, cur);
}

/** Snapshot all metrics for the /metrics endpoint. */
async function snapshot() {
  const store = await getStore();
  const counters = {};
  const histograms = {};
  for (const key of await store.list('metric:counter:')) {
    const m = await store.get(key);
    (counters[m.name] = counters[m.name] || []).push({ dims: m.dims, value: m.value });
  }
  for (const key of await store.list('metric:hist:')) {
    const m = await store.get(key);
    (histograms[m.name] = histograms[m.name] || []).push({
      dims: m.dims,
      count: m.count,
      avg: Math.round(m.sum / m.count),
      min: m.min,
      max: m.max,
    });
  }
  return { counters, histograms };
}

module.exports = { increment, observe, snapshot };
