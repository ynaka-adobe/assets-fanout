/*
 * Storage abstraction for the processing ledger and metrics.
 *
 * In an App Builder runtime this is backed by @adobe/aio-lib-state (a durable,
 * region-local key/value store). For local simulation (test/harness.js) there
 * is a zero-dependency in-memory fallback so the whole fan-out can be exercised
 * without deploying to Adobe I/O Runtime.
 */

const MAX_TTL = 31536000; // 365 days — aio-lib-state's maximum
let _memory = null; // shared in-process map for the local fallback

function memoryStore() {
  if (!_memory) _memory = new Map();
  return {
    async get(key) {
      const v = _memory.get(key);
      return v === undefined ? undefined : JSON.parse(v);
    },
    async put(key, value) {
      _memory.set(key, JSON.stringify(value));
    },
    async delete(key) {
      _memory.delete(key);
    },
    async list(prefix) {
      const out = [];
      for (const k of _memory.keys()) if (k.startsWith(prefix)) out.push(k);
      return out;
    },
  };
}

/**
 * Decide which store to use.
 *
 * IMPORTANT: Adobe I/O Runtime delivers manifest `inputs:` as action PARAMETERS
 * (in `main(params)`), NOT as environment variables — so we cannot rely on a
 * FANOUT_STORE env input inside a deployed action. Instead we auto-detect the
 * runtime: inside a real activation __OW_API_KEY is always set, so default to
 * durable aio-lib-state there. Locally (harness/dashboard) it is absent, so we
 * use the in-memory fallback. FANOUT_STORE can still force either explicitly.
 */
function useAioStore() {
  if (process.env.FANOUT_STORE === 'memory') return false;
  if (process.env.FANOUT_STORE === 'aio') return true;
  return Boolean(process.env.__OW_API_KEY);
}

let _aioStorePromise = null; // memoized per container — init() is a network call

async function getStore() {
  if (!useAioStore()) return memoryStore();
  // Reuse the initialized client across all ops in this container. Previously
  // init() ran on every getStore() call (6+ per ingest), which dominated cold
  // starts (tens of seconds). Memoizing collapses that to a single init.
  if (!_aioStorePromise) _aioStorePromise = buildAioStore();
  return _aioStorePromise;
}

async function buildAioStore() {
  // Lazy-require so the harness never needs the dependency installed.
  const stateLib = require('@adobe/aio-lib-state');
  const state = await stateLib.init();

  // aio-lib-state keys must match ^[a-zA-Z0-9-_.]{1,1024}$ — our keys use ':'
  // and asset ids are URNs ("urn:aaid:aem:..."). Encode each disallowed char to
  // "-<hexcode>". The output uses only allowed chars, so encoding is idempotent
  // (safe to re-apply to keys returned by list) and prefix-preserving (a shared
  // raw prefix still shares an encoded prefix).
  const enc = (key) => String(key).replace(/[^a-zA-Z0-9_.-]/g, (c) => '-' + c.charCodeAt(0).toString(16));

  return {
    async get(key) {
      const res = await state.get(enc(key));
      return res && res.value ? JSON.parse(res.value) : undefined;
    },
    async put(key, value) {
      // aio-lib-state caps TTL at 365 days and rejects infinite (< 0) TTLs, so
      // use the max. For a permanent ledger, refresh on write (every update
      // re-puts) or back it with a store that supports no-expiry in production.
      await state.put(enc(key), JSON.stringify(value), { ttl: MAX_TTL });
    },
    async delete(key) {
      await state.delete(enc(key));
    },
    async list(prefix) {
      const out = [];
      for await (const { keys } of state.list({ match: `${enc(prefix)}*` })) {
        out.push(...keys);
      }
      return out;
    },
  };
}

module.exports = { getStore };
