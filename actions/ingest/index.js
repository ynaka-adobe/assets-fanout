/*
 * Ingest action — the event boundary entrypoint.
 *
 * Registered as the webhook/journal consumer for AEM Assets processing and
 * metadata events. Metadata edits dispatch only the optional Mixed Media branch.
 */

const { normalize, METADATA_UPDATED_EVENT_CODE } = require('../../lib/normalize');
const { fanout } = require('../../lib/fanout');
const { MIXED_MEDIA_SET_BRANCH } = require('../../lib/states');
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
    const options =
      assetEvent.eventType === METADATA_UPDATED_EVENT_CODE
        ? { branches: [MIXED_MEDIA_SET_BRANCH] }
        : undefined;
    const result = await fanout(assetEvent, options);
    return json(200, result);
  } catch (err) {
    await increment('ingest_errors');
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
