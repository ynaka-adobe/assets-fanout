/*
 * Ledger read API — exposes the per-asset processing ledger outside AEM so
 * operators can answer "is this asset actually ready for VIA/dealers?" without
 * inspecting AEM internals.
 *
 * GET ?assetId=...  -> one record
 * GET (no assetId)  -> all records (demo scale only)
 */

const ledger = require('../../lib/ledger');
const { json, preflight } = require('../../lib/http');

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    if (params.assetId) {
      const record = await ledger.load(params.assetId);
      if (!record) return json(404, { error: 'not found', assetId: params.assetId });
      return json(200, record);
    }
    const records = await ledger.all();
    return json(200, { count: records.length, records });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
