/*
 * IMS OAuth Server-to-Server token minting for durable AEM access.
 *
 * A service credential (client_id + client_secret) mints access tokens via the
 * client_credentials grant — no user/dev token, no 24h manual refresh. Tokens
 * are cached in state and reused until shortly before expiry so we mint rarely
 * (well within IMS limits) even though the poller runs every 60s.
 */

const crypto = require('crypto');

const DEFAULT_IMS = 'https://ims-na1.adobelogin.com';
const CACHE_KEY = 'aem:s2sToken';

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

/**
 * AEM Cloud Service Service Credentials use the JWT exchange flow: sign a JWT
 * with the credential's private key, then swap it at IMS for an access token.
 * These credentials are pre-authorized for the AEM environment (no allowlist).
 *
 * @param {object} c the `integration` object from the downloaded credentials
 */
async function mintJwt(c) {
  const imsHost = `https://${c.imsEndpoint || 'ims-na1.adobelogin.com'}`;
  const clientId = c.technicalAccount.clientId;
  const clientSecret = c.technicalAccount.clientSecret;
  const metascope = `${imsHost}/s/${c.metascopes}`;

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 300,
    iss: c.org,
    sub: c.id,
    aud: `${imsHost}/c/${clientId}`,
    [metascope]: true,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(c.privateKey);
  const jwt = `${signingInput}.${b64url(signature)}`;

  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, jwt_token: jwt });
  const res = await fetch(`${imsHost}/ims/exchange/jwt`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`JWT exchange failed: ${JSON.stringify(j).slice(0, 200)}`);
  // NOTE: /ims/exchange/jwt returns expires_in in MILLISECONDS (unlike
  // /ims/token/v3 which uses seconds). Do NOT multiply. Clamp defensively so a
  // bad value can never cache a token beyond its real ~24h life.
  const ttlMs = Math.min(Number(j.expires_in || 86400000), 24 * 60 * 60 * 1000);
  return { token: j.access_token, expiresAt: Date.now() + ttlMs };
}

async function mint({ clientId, clientSecret, scope, imsHost = DEFAULT_IMS }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });
  const res = await fetch(`${imsHost}/ims/token/v3`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await res.json();
  if (!j.access_token) throw new Error(`IMS mint failed: ${JSON.stringify(j).slice(0, 200)}`);
  return { token: j.access_token, expiresAt: Date.now() + Number(j.expires_in || 3600) * 1000 };
}

/**
 * Return a cached access token, minting a fresh one when near expiry. Handles
 * both credential shapes:
 *   - JWT service credential (has technicalAccount + privateKey) → mintJwt
 *   - OAuth S2S (clientId + clientSecret + scope) → mint (client_credentials)
 */
async function getToken(store, cred, { force = false } = {}) {
  const isJwt = Boolean(cred.privateKey && cred.technicalAccount);
  const id = isJwt ? cred.technicalAccount.clientId : cred.clientId;
  const cached = await store.get(CACHE_KEY);
  // Reject a cached token whose life exceeds 25h — guards against a bad
  // expires_in ever pinning a stale token (the Sept-3 bug).
  const maxSane = Date.now() + 25 * 60 * 60 * 1000;
  if (
    !force &&
    cached &&
    cached.clientId === id &&
    cached.expiresAt > Date.now() + 5 * 60 * 1000 &&
    cached.expiresAt <= maxSane
  ) {
    return cached.token;
  }
  const minted = isJwt ? await mintJwt(cred) : await mint(cred);
  await store.put(CACHE_KEY, { ...minted, clientId: id });
  return minted.token;
}

/** Drop the cached token so the next getToken re-mints (used on a 401). */
async function invalidate(store) {
  await store.delete(CACHE_KEY);
}

module.exports = { mint, mintJwt, getToken, invalidate };
