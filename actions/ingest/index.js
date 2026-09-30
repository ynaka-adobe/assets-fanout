/*
 * Ingest action — the event boundary entrypoint.
 *
 * Registered as the webhook/journal consumer for the AEM Assets
 * `asset.processing_completed` I/O Event. It normalizes the event and hands it
 * to the fan-out dispatcher. This action is deliberately lightweight (doc:
 * "Keep AEM post-processing steps lightweight") — all heavy integration work
 * happens in the branch actions.
 */

const { normalize } = require('../../lib/normalize');
const { fanout } = require('../../lib/fanout');
const { increment } = require('../../lib/metrics');
const { json, preflight } = require('../../lib/http');

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    // Adobe I/O Events webhook verification: echo the raw challenge value back
    // as the response body (plain text), not wrapped in JSON.
    if (params.challenge) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: String(params.challenge),
      };
    }

    const assetEvent = normalize(params);
    if (assetEvent.ignored) {
      await increment('events_ignored');
      return json(200, { ignored: true, reason: assetEvent.reason });
    }

    await increment('events_received');
    const result = await fanout(assetEvent);
    return json(200, result);
  } catch (err) {
    await increment('ingest_errors');
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
