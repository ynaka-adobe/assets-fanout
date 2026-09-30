/*
 * sim-upload — models an AEM upload so the CORE tier is visible in the demo.
 *
 * AEM emits no per-asset event until processing COMPLETES, so real in-processing
 * assets are invisible to the event-driven layer. This action models that core
 * tier for demo purposes only:
 *
 *   stage=start (default): create the asset in CORE_PROCESSING (queued) and
 *     return immediately, then async-invoke itself with stage=complete. The
 *     asset now counts toward queue depth while it "processes".
 *   stage=complete: wait the modeled core-processing time, then run the normal
 *     fan-out (which upgrades the record from the core phase to the fan-out
 *     phase and dispatches the branches).
 *
 * Real AEM events still go straight to /ingest and enter at CORE_COMPLETE.
 */

const ledger = require('../../lib/ledger');
const { buildEnvelope } = require('../../lib/correlation');
const { fanout } = require('../../lib/fanout');
const { json, preflight } = require('../../lib/http');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function selfName() {
  const parts = (process.env.__OW_ACTION_NAME || '').split('/').filter(Boolean);
  const pkg = parts.length >= 3 ? parts[parts.length - 2] : 'toyota-assets-fanout';
  return `${pkg}/sim-upload`;
}

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    const assetEvent = {
      assetId: params.assetId,
      assetPath: params.assetPath,
      assetVersion: params.assetVersion || 'v1',
      sourceSystem: 'sim',
      aemProgram: 'via',
      faults: params.faults,
    };
    // Modeled AEM core-processing time (how long the asset shows as queued).
    const coreMs = Number(params.coreMs != null ? params.coreMs : 3000 + Math.floor(Math.random() * 6000));

    if (params.stage === 'complete') {
      await sleep(coreMs);
      const result = await fanout(assetEvent); // upgrades core → fan-out, dispatches branches
      return json(200, { stage: 'complete', assetId: assetEvent.assetId, readiness: result.readiness });
    }

    // stage=start: queue in the core tier, then hand off to the delayed completion.
    const base = buildEnvelope(assetEvent);
    await ledger.openCore(base);

    // Fire-and-forget the completion. In a deployed runtime, invoke async; the
    // local harness/dashboard runs it inline (no openwhisk).
    if (process.env.__OW_ACTION_NAME) {
      const ow = require('openwhisk')();
      await ow.actions.invoke({
        name: selfName(),
        params: { ...params, stage: 'complete', coreMs },
        blocking: false,
      });
    } else {
      // Local: kick off completion now (stage=complete does the coreMs wait),
      // matching the deployed async-invoke path.
      setTimeout(() => main({ ...params, stage: 'complete', coreMs }).catch(() => {}), 0);
    }
    return json(200, { stage: 'start', assetId: assetEvent.assetId, queued: true, coreMs });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
