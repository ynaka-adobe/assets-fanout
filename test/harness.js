/*
 * Local simulation harness — runs the whole fan-out in-process against the
 * in-memory store, so the architecture can be demoed without deploying to
 * Adobe I/O Runtime. `npm test` runs a single happy-path asset and asserts it
 * reaches READY_FOR_VIA.
 */

const path = require('path');
const ingest = require('../actions/ingest');
const ledgerAction = require('../actions/ledger');
const metricsAction = require('../actions/metrics');
const sampleEvent = require('./events/sample-completed-event.json');

async function main() {
  console.log('▶  Ingesting sample asset-processing-completed event…\n');
  const res = await ingest.main(sampleEvent);
  console.log('ingest result:', JSON.stringify(res.body, null, 2), '\n');

  const assetId = sampleEvent.data.assetId;
  const led = await ledgerAction.main({ assetId });
  console.log('ledger record:', JSON.stringify(led.body, null, 2), '\n');

  const metrics = await metricsAction.main({});
  console.log('metrics/alerting:', JSON.stringify(metrics.body.alertingLenses, null, 2), '\n');

  const ok = res.body.readiness === 'READY_FOR_VIA';
  console.log(ok ? '✅ PASS — asset reached READY_FOR_VIA' : '❌ FAIL — asset not ready');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
