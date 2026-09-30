/*
 * HTTP helpers for web actions. The hosted static dashboard (web-src/) calls
 * these actions cross-origin (adobeio-static.net → adobeioruntime.net), so they
 * must return CORS headers and answer the browser's OPTIONS preflight. Enable
 * per-action OPTIONS handling with the `web-custom-options: true` annotation in
 * app.config.yaml.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/** Standard JSON response with CORS headers. */
function json(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }, body };
}

/** If this invocation is a CORS preflight, return the 204 response (else null). */
function preflight(params) {
  if (params && params.__ow_method === 'options') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  return null;
}

module.exports = { json, preflight, CORS_HEADERS };
