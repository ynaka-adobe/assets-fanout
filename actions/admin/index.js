/*
 * Admin / maintenance action (demo convenience — NOT for production).
 *
 * POST { op: "reset", confirm: "yes" }  → wipes all app state (ledger, branch
 * keys, metrics, DLQ, idempotency) via aio-lib-state deleteAll(), giving a clean
 * slate for a demo run. Guarded by an explicit confirm to avoid accidents.
 */

const { json, preflight } = require('../../lib/http');
const { getStore } = require('../../lib/store');
const ledger = require('../../lib/ledger');

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    if (params.op === 'setAemConfig') {
      if (!params.aemHost) return json(400, { error: 'provide aemHost' });
      const store = await getStore();
      const prev = (await store.get('config:aem')) || {};
      const cfg = {
        host: params.aemHost.replace(/\/$/, ''),
        path: params.aemPath || prev.path || '/content/dam',
        // Dev token (optional): short-lived fallback that works before the S2S
        // client ID is allowlisted in AEM.
        token: params.aemToken || prev.token,
        // S2S service credential (optional): durable, auto-minted (see core-poll).
        s2s:
          params.clientId && params.clientSecret
            ? {
                clientId: params.clientId,
                clientSecret: params.clientSecret,
                scope: params.scope || 'openid,AdobeID,aem.folders,aem.assets.author',
                imsHost: params.imsHost || 'https://ims-na1.adobelogin.com',
              }
            : prev.s2s,
        // AEM Service Credential (JWT flow): pass the `integration` object.
        // Durable (~1yr), pre-authorized for the environment, no allowlisting.
        jwt: params.jwt || prev.jwt,
      };
      await store.put('config:aem', cfg);
      return json(200, {
        ok: true,
        has: { devToken: !!cfg.token, s2s: !!(cfg.s2s && cfg.s2s.clientId), jwt: !!cfg.jwt },
      });
    }

    // Full wipe (including AEM config) — use deliberately.
    if (params.op === 'reset') {
      if (params.confirm !== 'yes') return json(400, { error: 'set confirm:"yes" to wipe all state' });
      const stateLib = require('@adobe/aio-lib-state');
      const state = await stateLib.init();
      await state.deleteAll();
      return json(200, { ok: true, message: 'all app state cleared (incl. AEM config)' });
    }

    // Demo reset — clears ledger/metrics/DLQ/idempotency but PRESERVES the AEM
    // config + token cache so the core poller keeps working. This is what the
    // dashboard "Reset view" button calls.
    if (params.op === 'resetDemo') {
      const store = await getStore();
      const prefixes = ['ledger:', 'branch:', 'metric:', 'dlq:', 'idem:'];
      let deleted = 0;
      for (const p of prefixes) {
        const keys = await store.list(p);
        for (const k of keys) {
          await store.delete(k);
          deleted += 1;
        }
      }
      return json(200, { ok: true, deleted, preserved: 'config:aem, token cache' });
    }

    // Backfill the denormalized readiness onto every existing ledger record so
    // the list endpoints read 1 key/record. Bounded concurrency; runs
    // server-side within the (raised) action timeout — no data loss.
    if (params.op === 'backfill') {
      const store = await getStore();
      const keys = await store.list('ledger:');
      let updated = 0;
      const CONC = 6;
      for (let i = 0; i < keys.length; i += CONC) {
        await Promise.all(
          keys.slice(i, i + CONC).map(async (k) => {
            const main = await store.get(k);
            if (!main) return;
            const full = await ledger.load(main.assetId); // reads branch keys, derives readiness
            if (full && full.readiness !== main.readiness) {
              await store.put(k, { ...main, readiness: full.readiness });
              updated += 1;
            }
          })
        );
      }
      return json(200, { ok: true, records: keys.length, updated });
    }

    return json(400, { error: 'unknown op; use {op:"backfill"} or {op:"reset",confirm:"yes"}' });
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
