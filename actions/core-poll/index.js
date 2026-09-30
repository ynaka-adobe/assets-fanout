/*
 * core-poll — low-impact AEM core-tier probe.
 *
 * AEM emits no event when an asset enters or fails processing, so core-tier
 * backlog is only visible by querying dam:assetState. To keep load off AEM
 * author (the doc's own principle), this action:
 *   - refresh (invoked by a 60s alarm trigger): runs ONE set of count-only
 *     QueryBuilder calls and writes the result to the state cache.
 *   - read (web GET from the dashboard): returns the cached counts, no AEM call.
 *
 * So AEM sees ~3 lightweight index queries/minute total, no matter how many
 * dashboards are open. Config (host + token) is stored in state via
 * admin op=setAemConfig; the dev token is short-lived (demo only).
 */

const { getStore } = require('../../lib/store');
const { coreCounts } = require('../../lib/aem');
const ims = require('../../lib/ims');
const { json, preflight } = require('../../lib/http');

const CONFIG_KEY = 'config:aem';
const CACHE_KEY = 'aem:coreCounts';

async function main(params) {
  const pre = preflight(params);
  if (pre) return pre;
  try {
    const store = await getStore();

    // Diagnostic: list the most-recently-modified assets with their raw
    // dam:assetState so we can see what value "processing error" maps to.
    if (params.diag) {
      const cfg = await store.get(CONFIG_KEY);
      const durable = cfg.jwt || cfg.s2s;
      const tok = durable ? await ims.getToken(store, durable, { force: true }) : cfg.token;

      // Ad-hoc lookup by node name (e.g. a Mixed Media Set) anywhere under a
      // path, or by a jcr:content property/value (e.g. dam:s7damType=MixedMediaSet).
      // Returns a list of matching paths (not just the first hit).
      if (params.find || params.prop) {
        const base = params.path || cfg.path || '/content/dam';
        const qs = new URLSearchParams({
          path: base,
          'p.limit': '40',
          'p.hits': 'selective',
          'p.properties': 'jcr:path jcr:content/dam:s7damType jcr:content/jcr:title',
        });
        if (params.find) {
          qs.set('nodename', params.find);
        }
        if (params.prop) {
          qs.set('1_property', `jcr:content/${params.prop}`);
          qs.set('1_property.value', params.val || '');
        }
        const url = `${cfg.host}/bin/querybuilder.json?${qs.toString()}`;
        const rr = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
        const b = await rr.json();
        const hits = (b.hits || []).map((h) => ({
          path: h['jcr:path'],
          s7damType: h['jcr:content'] && h['jcr:content']['dam:s7damType'],
          title: h['jcr:content'] && h['jcr:content']['jcr:title'],
        }));
        return json(200, { status: rr.status, total: b.total, hits });
      }

      // Inspect one asset's full node via QueryBuilder (AEMaaCS blocks the
      // default node .json servlet, but QueryBuilder works).
      if (params.path) {
        const durablP = cfg.jwt || cfg.s2s;
        const tokP = durablP ? await ims.getToken(store, durablP, { force: true }) : cfg.token;
        const u =
          `${cfg.host}/bin/querybuilder.json?path=${encodeURIComponent(params.path)}` +
          `&p.limit=10&p.hits=full&p.nodedepth=6`;
        const rr = await fetch(u, { headers: { Authorization: `Bearer ${tokP}` } });
        const b = await rr.json();
        const hits = b.hits || [];
        // Find the asset's jcr:content node and return ALL its scalar props
        // (unfiltered) + metadata scalars — to spot whatever drives the UI badge.
        const jcNode = hits.find((h) => /\/jcr:content$/.test(h['jcr:path'])) || hits[0] || {};
        const scalars = (o) =>
          Object.fromEntries(
            Object.entries(o || {}).filter(([, v]) => v === null || typeof v !== 'object')
          );
        return json(200, {
          total: b.total,
          contentProps: scalars(jcNode),
          metadataProps: scalars(jcNode.metadata),
        });
      }

      const orderby = params.orderby === 'modified' ? 'jcr:content/jcr:lastModified' : 'jcr:content/jcr:created';
      const url =
        `${cfg.host}/bin/querybuilder.json?path=${encodeURIComponent(cfg.path || '/content/dam')}` +
        `&type=dam:Asset&p.limit=30&orderby=@${encodeURIComponent(orderby)}&orderby.sort=desc` +
        `&p.hits=selective&p.properties=${encodeURIComponent('jcr:path jcr:content/dam:assetState jcr:content/jcr:created jcr:content/dam:sha1')}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
      const b = await r.json();
      const hits = (b.hits || []).map((h) => ({
        path: h['jcr:path'],
        state: (h['jcr:content'] && h['jcr:content']['dam:assetState']) || null,
        created: h['jcr:content'] && h['jcr:content']['jcr:created'],
        hasBinary: !!(h['jcr:content'] && h['jcr:content']['dam:sha1']),
      }));
      const byState = hits.reduce((a, h) => ((a[h.state || 'null'] = (a[h.state || 'null'] || 0) + 1), a), {});
      return json(200, { status: r.status, total: b.total, orderby, byState, recent: hits.slice(0, 18) });
    }

    if (params.refresh) {
      const cfg = await store.get(CONFIG_KEY);
      if (!cfg || !cfg.host) return json(200, { refreshed: false, reason: 'AEM not configured' });

      // Auth preference: durable JWT service credential → OAuth S2S → dev token.
      // Each falls back to the next so the poller keeps working through setup.
      let counts;
      let auth;
      const durable = cfg.jwt || cfg.s2s;
      if (durable) {
        try {
          let tok = await ims.getToken(store, durable);
          try {
            counts = await coreCounts(cfg.host, tok, cfg.path);
          } catch (e1) {
            // Token likely stale/expired → drop cache, re-mint once, retry.
            if (e1.status === 401 || e1.status === 403) {
              await ims.invalidate(store);
              tok = await ims.getToken(store, durable, { force: true });
              counts = await coreCounts(cfg.host, tok, cfg.path);
            } else {
              throw e1;
            }
          }
          auth = cfg.jwt ? 'service-credential (jwt)' : 's2s';
        } catch (e) {
          if (!cfg.token) throw e;
          counts = await coreCounts(cfg.host, cfg.token, cfg.path);
          auth = `devtoken (durable failed: ${e.status || e.message})`;
        }
      } else if (cfg.token) {
        counts = await coreCounts(cfg.host, cfg.token, cfg.path);
        auth = 'devtoken';
      } else {
        return json(200, { refreshed: false, reason: 'no AEM credential configured' });
      }

      const result = { ...counts, auth };
      await store.put(CACHE_KEY, result);
      return json(200, { refreshed: true, ...result });
    }

    // Default: return cached counts (no AEM call).
    const cached = (await store.get(CACHE_KEY)) || { configured: false };
    return json(200, cached);
  } catch (err) {
    return json(500, { error: String(err.message || err) });
  }
}

exports.main = main;
