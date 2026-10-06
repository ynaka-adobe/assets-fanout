/*
 * Per-asset processing ledger — "Maintain a per-asset processing ledger outside
 * AEM" (architecture doc, Troubleshooting recommendation).
 *
 * The ledger is the source of truth for business-readiness. AEM only knows
 * dam:assetState; readiness for VIA/dealers is derived here from the independent
 * branch outcomes.
 *
 * CONCURRENCY: with async dispatch each branch runs in its own I/O Runtime
 * activation (separate container). To avoid lost updates on a shared record,
 * each branch's state lives under its OWN key (`branch:<assetId>:<branchId>`)
 * and the asset-level key (`ledger:<assetId>`) holds only immutable facts. No
 * two writers ever touch the same key, so no lock or transaction is needed.
 * Overall readiness is DERIVED on read by gathering the branch keys.
 */

const { getStore } = require('./store');
const { READINESS, BRANCH, REQUIRED_BRANCHES, OPTIONAL_BRANCHES } = require('./states');

const assetKey = (assetId) => `ledger:${assetId}`;
const branchKey = (assetId, branchId) => `branch:${assetId}:${branchId}`;

/**
 * Create the asset-level record and initialize per-branch keys to PENDING when
 * the core-processing-completed event is first received. Idempotent: a duplicate
 * event (I/O Events retry) finds the existing record and does NOT reset branch
 * state that may already be progressing.
 */
async function open(envelope) {
  const store = await getStore();
  const existing = await store.get(assetKey(envelope.assetId));
  const now = new Date().toISOString();

  // If the asset is already tracked (e.g. it sat in the modeled CORE_PROCESSING
  // phase, or this is an I/O Events retry), upgrade it to the fan-out phase
  // without resetting any branch progress.
  if (existing) {
    if (existing.phase !== 'fanout') {
      await store.put(assetKey(envelope.assetId), {
        ...existing,
        phase: 'fanout',
        readiness: READINESS.CORE_COMPLETE,
      });
      await initBranchKeys(store, envelope.assetId, now);
    }
    return load(envelope.assetId);
  }

  await store.put(assetKey(envelope.assetId), {
    assetId: envelope.assetId,
    assetPath: envelope.assetPath,
    assetVersion: envelope.assetVersion,
    fanoutId: envelope.fanoutId,
    createdAt: now,
    phase: 'fanout',
    readiness: READINESS.CORE_COMPLETE, // denormalized cache (see updateBranch/all)
  });
  // Initialize branch keys BEFORE branches are dispatched (fanout awaits open()).
  await initBranchKeys(store, envelope.assetId, now);
  return load(envelope.assetId);
}

async function initBranchKeys(store, assetId, now) {
  await Promise.all(
    REQUIRED_BRANCHES.map((b) =>
      store.put(branchKey(assetId, b), {
        state: BRANCH.PENDING,
        attempts: 0,
        lastError: null,
        updatedAt: now,
      })
    )
  );
}

/**
 * Model the AEM CORE tier (doc: core processing happens before the event
 * boundary). Creates the asset record in CORE_PROCESSING with NO branch keys —
 * it counts as "queued / not ready" until open() upgrades it to the fan-out
 * phase. Used by the sim-upload action to make the core backlog visible; real
 * AEM assets skip this (they arrive already processed).
 */
async function openCore(envelope) {
  const store = await getStore();
  const existing = await store.get(assetKey(envelope.assetId));
  if (existing) return load(envelope.assetId);
  const now = new Date().toISOString();
  await store.put(assetKey(envelope.assetId), {
    assetId: envelope.assetId,
    assetPath: envelope.assetPath,
    assetVersion: envelope.assetVersion,
    fanoutId: envelope.fanoutId,
    createdAt: now,
    phase: 'core',
    readiness: READINESS.CORE_PROCESSING,
  });
  return load(envelope.assetId);
}

/** Read the asset record plus all branch keys and derive readiness. */
async function load(assetId) {
  const store = await getStore();
  const main = await store.get(assetKey(assetId));
  if (!main) return null;

  // Core phase (modeled AEM processing): no branch keys yet; the asset is
  // queued/not-ready until it upgrades to the fan-out phase.
  if (main.phase === 'core') {
    const pending = {};
    for (const b of REQUIRED_BRANCHES) pending[b] = { state: BRANCH.PENDING, attempts: 0 };
    return { ...main, branches: pending, readiness: main.readiness || READINESS.CORE_PROCESSING };
  }

  // Backward compatibility: records written before the per-branch-key refactor
  // embedded branch state directly in the record. Use it as-is.
  if (main.branches) {
    const branches = { ...main.branches };
    await Promise.all(
      OPTIONAL_BRANCHES.map(async (b) => {
        const value = await store.get(branchKey(assetId, b));
        if (value) branches[b] = value;
      })
    );
    return { ...main, branches, readiness: deriveReadiness(branches) };
  }

  const branches = {};
  await Promise.all(
    [...REQUIRED_BRANCHES, ...OPTIONAL_BRANCHES].map(async (b) => {
      const value = await store.get(branchKey(assetId, b));
      if (OPTIONAL_BRANCHES.includes(b) && !value) return;
      branches[b] = value || {
        state: BRANCH.PENDING,
        attempts: 0,
        lastError: null,
      };
    })
  );
  return { ...main, branches, readiness: deriveReadiness(branches) };
}

/**
 * Record a branch state transition. Writes ONLY this branch's key, so
 * concurrent branches (separate containers) never contend. No lock needed.
 */
async function updateBranch(assetId, branchId, patch) {
  const store = await getStore();
  const cur = (await store.get(branchKey(assetId, branchId))) || { attempts: 0 };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await store.put(branchKey(assetId, branchId), next);

  // Maintain a denormalized readiness on the asset record so the list endpoints
  // read 1 key/record instead of 6. Terminal values (READY_FOR_VIA /
  // BRANCH_TERMINAL_FAILURE) are only ever written when truly reached, so they
  // are always trustworthy; a stale NON-terminal value is reconciled on read by
  // all(). Concurrent writers are fine — last write wins and read-time
  // reconciliation covers any in-flight staleness.
  try {
    const branches = {};
    await Promise.all(
      REQUIRED_BRANCHES.map(async (b) => {
        branches[b] = (await store.get(branchKey(assetId, b))) || { state: BRANCH.PENDING };
      })
    );
    const main = await store.get(assetKey(assetId));
    if (main) await store.put(assetKey(assetId), { ...main, readiness: deriveReadiness(branches) });
  } catch (_) {
    /* denormalization is best-effort; load()/all() reconcile from branch keys */
  }
  return next;
}

const TERMINAL = new Set([READINESS.READY_FOR_VIA, READINESS.BRANCH_TERMINAL_FAILURE]);

/**
 * Roll the per-branch states up into a single business-readiness state.
 * READY_FOR_VIA only when every required branch has SUCCEEDED.
 */
function deriveReadiness(branches) {
  const states = REQUIRED_BRANCHES.map((b) => branches[b]?.state || BRANCH.PENDING);
  if (states.some((s) => s === BRANCH.DEAD_LETTER)) return READINESS.BRANCH_TERMINAL_FAILURE;
  if (states.every((s) => s === BRANCH.SUCCEEDED)) return READINESS.READY_FOR_VIA;
  if (states.some((s) => s === BRANCH.RETRYABLE_FAILURE)) return READINESS.BRANCH_RETRYABLE_FAILURE;
  if (states.some((s) => s === BRANCH.RUNNING)) return READINESS.BRANCH_RUNNING;
  if (states.some((s) => s === BRANCH.SUCCEEDED)) return READINESS.PARTIALLY_READY;
  return READINESS.BRANCH_PENDING;
}

/**
 * List all ledger records (used by the metrics/ledger endpoints). Each record
 * now costs several branch-key reads, so we bound concurrency to avoid
 * overwhelming aio-lib-state (which throttles large concurrent bursts).
 */
async function all() {
  const store = await getStore();
  const keys = await store.list('ledger:');
  const out = [];
  const CONC = 8;
  for (let i = 0; i < keys.length; i += CONC) {
    const batch = await Promise.all(
      keys.slice(i, i + CONC).map(async (k) => {
        const main = await store.get(k);
        if (!main) return null;
        // Old embedded-branches records: derive directly (1 get).
        if (main.branches) return load(main.assetId);
        // Core phase: no branch keys; trust the denormalized readiness (1 get).
        if (main.phase === 'core') return main;
        // Fast path: trust a terminal denormalized readiness (1 get).
        if (TERMINAL.has(main.readiness)) return main;
        // In-flight or unknown: reconcile accurately from branch keys.
        return load(main.assetId);
      })
    );
    out.push(...batch.filter(Boolean));
  }
  return out;
}

module.exports = { open, openCore, load, updateBranch, deriveReadiness, all };
