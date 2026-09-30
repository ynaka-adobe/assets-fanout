/*
 * Local demo server — exposes the App Builder actions over HTTP so the browser
 * dashboard (public/index.html) can drive the fan-out. Uses the same in-memory
 * store as the actions, so no cloud is required. NOT for production; in a real
 * deployment the dashboard would call the deployed web-action URLs instead.
 *
 *   node scripts/server.js            # http://localhost:3000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ingest = require('../actions/ingest');
const ledgerAction = require('../actions/ledger');
const metricsAction = require('../actions/metrics');
const dlqReplay = require('../actions/dlq-replay');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');

function makeEvent(overrides = {}, faults) {
  const id = `urn:aaid:aem:${crypto.randomUUID()}`;
  return {
    type: 'aem.assets.asset.processing_completed',
    source: 'dashboard',
    data: {
      assetId: id,
      assetPath: `/content/dam/via/${(overrides.folder || 'demo')}/${id.slice(-6)}.jpg`,
      assetVersion: crypto.randomBytes(6).toString('hex'),
      sourceSystem: 'toyota-pim',
      aemProgram: 'via',
      faults,
      ...overrides,
    },
  };
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

// Deployed Stage web actions. The dashboard can target these instead of the
// in-process actions; we proxy server-side so the browser never has to make a
// cross-origin request to adobeioruntime.net (no CORS headers needed there).
const STAGE_BASE =
  process.env.FANOUT_STAGE_BASE ||
  'https://332794-assetsfanout-stage.adobeioruntime.net/api/v1/web/toyota-assets-fanout';

const cloud = {
  async ingest(event) {
    const r = await fetch(`${STAGE_BASE}/ingest`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
    });
    return r.json();
  },
  async replay(branchId) {
    const r = await fetch(`${STAGE_BASE}/dlq-replay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ branchId }),
    });
    return r.json();
  },
  async metrics() { return (await fetch(`${STAGE_BASE}/metrics`)).json(); },
  async ledger() { return (await fetch(`${STAGE_BASE}/ledger`)).json(); },
};

const isStage = (t) => t === 'stage';

const routes = {
  // Ingest N assets, optionally with fault injection, bounded concurrency.
  // target=stage fans the same events at the deployed Stage actions (capped
  // smaller since each is a real cloud round-trip).
  async 'POST /api/ingest'(req, res) {
    const b = await readBody(req);
    const stage = isStage(b.target);
    const n = Math.min(Number(b.count || 1), stage ? 50 : 2000);
    const conc = stage ? 10 : 50;
    const events = Array.from({ length: n }, () => makeEvent(b.overrides || {}, b.faults));
    let ready = 0;
    for (let i = 0; i < events.length; i += conc) {
      const slice = events.slice(i, i + conc);
      const results = await Promise.all(
        slice.map((e) => (stage ? cloud.ingest(e) : ingest.main(e).then((r) => r.body)))
      );
      ready += results.filter((r) => r.readiness === 'READY_FOR_VIA').length;
    }
    json(res, 200, { ingested: n, ready, target: stage ? 'stage' : 'local' });
  },
  async 'POST /api/replay'(req, res) {
    const b = await readBody(req);
    const body = isStage(b.target)
      ? await cloud.replay(b.branchId)
      : (await dlqReplay.main({ branchId: b.branchId, faults: {} })).body;
    json(res, 200, body);
  },
  async 'GET /api/metrics'(req, res, url) {
    const body = isStage(url.searchParams.get('target'))
      ? await cloud.metrics()
      : (await metricsAction.main({})).body;
    json(res, 200, body);
  },
  async 'GET /api/ledger'(req, res, url) {
    const body = isStage(url.searchParams.get('target'))
      ? await cloud.ledger()
      : (await ledgerAction.main({})).body;
    json(res, 200, body);
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const routeKey = `${req.method} ${url.pathname}`;
    if (routes[routeKey]) return await routes[routeKey](req, res, url);

    // Static files from public/
    const file = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (filePath.startsWith(PUBLIC) && fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'text/plain';
      res.writeHead(200, { 'content-type': type });
      return res.end(fs.readFileSync(filePath));
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, () => {
  console.log(`▶  Fan-out demo dashboard: http://localhost:${PORT}`);
});
