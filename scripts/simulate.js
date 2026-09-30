/*
 * Pilot & failure-testing simulator (architecture doc, Phase 5).
 *
 * Reproduces the doc's failure test cases against the in-memory store and
 * prints the observability lenses after each, so the fan-out behavior is
 * visible in a terminal during a customer demo. No cloud required.
 *
 *   node scripts/simulate.js            # run all scenarios
 *   node scripts/simulate.js burst      # run one by name
 */

const crypto = require('crypto');
const ingest = require('../actions/ingest');
const metricsAction = require('../actions/metrics');
const dlqReplay = require('../actions/dlq-replay');

function makeEvent(overrides = {}, faults) {
  const id = `urn:aaid:aem:${crypto.randomUUID()}`;
  return {
    type: 'aem.assets.asset.processing_completed',
    source: 'sim',
    data: {
      assetId: id,
      assetPath: `/content/dam/via/sim/${id.slice(-6)}.jpg`,
      assetVersion: crypto.randomBytes(6).toString('hex'),
      sourceSystem: 'toyota-pim',
      aemProgram: 'via',
      faults,
      ...overrides,
    },
  };
}

async function lenses(label) {
  const m = await metricsAction.main({});
  console.log(`   ${label}:`, JSON.stringify(m.body.alertingLenses));
  console.log('   readiness:', JSON.stringify(m.body.readinessBreakdown));
}

const scenarios = {
  // 1,000-asset burst — downstream branches throttle independently.
  async burst() {
    console.log('\n=== Scenario: 1,000-asset burst ===');
    const N = Number(process.env.BURST_N || 1000);
    const t0 = Date.now();
    let ready = 0;
    // Bounded concurrency so we don't spawn 1000 promise chains at once.
    const CONC = 50;
    const events = Array.from({ length: N }, () => makeEvent());
    for (let i = 0; i < events.length; i += CONC) {
      const slice = events.slice(i, i + CONC);
      const results = await Promise.all(slice.map((e) => ingest.main(e)));
      ready += results.filter((r) => r.body.readiness === 'READY_FOR_VIA').length;
    }
    console.log(`   ${ready}/${N} assets READY_FOR_VIA in ${Date.now() - t0}ms`);
    await lenses('after burst');
  },

  // PIM outage — durable queue + retry + DLQ; AEM processing is unaffected.
  async pimOutage() {
    console.log('\n=== Scenario: PIM outage (recovers on attempt 5 = never within budget) ===');
    const e = makeEvent({}, { pimOutage: true, pimRecoverAtAttempt: 5 });
    const res = await ingest.main(e);
    console.log('   readiness:', res.body.readiness, '(pim-sync should be DEAD_LETTER)');
    await lenses('during outage');

    console.log('   → PIM recovers; replaying dead-letter queue…');
    const replay = await dlqReplay.main({ branchId: 'pim-sync', faults: {} });
    console.log('   replay:', JSON.stringify(replay.body));
    await lenses('after replay');
  },

  // Duplicate completion event — idempotency key makes the second a no-op.
  async duplicate() {
    console.log('\n=== Scenario: Duplicate completion event ===');
    const e = makeEvent();
    const first = await ingest.main(e);
    const second = await ingest.main(e); // same assetId + version
    const deduped = second.body.branches.every((b) => b.deduped);
    console.log('   first readiness:', first.body.readiness);
    console.log('   second all deduped:', deduped);
  },

  // Dynamic Media zero-results — the E-002379359 shape; retryable, then recovers.
  async dmZeroResults() {
    console.log('\n=== Scenario: Dynamic Media zero-results canary (E-002379359) ===');
    const e = makeEvent({}, { dmZeroResults: true });
    const res = await ingest.main(e);
    const dm = res.body.branches.find((b) => b.branchId === 'dynamic-media-readiness');
    console.log('   dynamic-media-readiness status:', dm.status, '→ readiness:', res.body.readiness);
    await lenses('dm failed');
    console.log('   → DM propagation completes; replaying…');
    await dlqReplay.main({ branchId: 'dynamic-media-readiness', faults: {} });
    await lenses('after dm replay');
  },
};

async function main() {
  const only = process.argv[2];
  const names = only ? [aliasToName(only)] : Object.keys(scenarios);
  for (const n of names) {
    if (!scenarios[n]) {
      console.error(`unknown scenario: ${only}. options: ${Object.keys(scenarios).join(', ')}`);
      process.exit(1);
    }
    await scenarios[n]();
  }
  console.log('\n✅ simulation complete');
}

function aliasToName(a) {
  const map = { burst: 'burst', pim: 'pimOutage', dup: 'duplicate', duplicate: 'duplicate', dm: 'dmZeroResults' };
  return map[a] || a;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
