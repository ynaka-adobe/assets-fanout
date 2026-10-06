/*
 * Branch integration logic. Each function is the "heavy integration logic run
 * outside of AEM's OSGi processing" (doc, Executive Recommendation 1b) — the
 * work that used to live in serial AEM workflows now runs as an independent
 * App Builder action.
 *
 * For the demo these simulate the real downstream calls and honor fault
 * injection flags carried on the event (event.faults) so the Phase-5 failure
 * tests can be reproduced deterministically:
 *   faults.pimOutage        -> pim-sync fails until attempt >= faults.pimRecoverAtAttempt
 *   faults.dmDelayMs        -> dynamic-media-readiness is slow
 *   faults.dmZeroResults    -> dynamic-media-readiness fails (E-002379359 shape)
 *   faults.metadataConflict -> metadata-enrichment throws a contract violation
 */

const { observe, increment } = require('./metrics');
const path = require('path');
const { getStore } = require('./store');
const { getAssetProperties } = require('./aem');
const ims = require('./ims');
const scene7 = require('./scene7');

const MIXED_MEDIA_FOLDERS = Object.freeze(['/content/dam/brand/Brand 14/']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.tif', '.tiff', '.bmp', '.webp']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fault(env, name) {
  return (env && env.faults && env.faults[name]) || undefined;
}

// 1) Workflow synchronization — migrated first (Phase 4). Trigger custom
//    workflows off the completion event instead of a serial AEM launcher.
async function workflowSync(env) {
  await sleep(20);
  return { workflow: 'via-onboarding', step: 'terminal', assetId: env.assetId };
}

// 2) PIM synchronization — durable queue + retries + DLQ. A temporary PIM
//    outage must not stop AEM asset processing (doc: External PIM updates).
async function pimSync(env) {
  const recoverAt = fault(env, 'pimOutage') ? fault(env, 'pimRecoverAtAttempt') || Infinity : 0;
  if (env.attempt < recoverAt) {
    const e = new Error('PIM endpoint 503 (simulated outage)');
    e.code = 'PIM_UNAVAILABLE';
    throw e;
  }
  await sleep(30);
  return { pimRecordId: `pim-${env.assetId.slice(0, 8)}`, synced: true };
}

// 3) Metadata enrichment — nonessential enrichment moved off the upload path
//    (doc: Metadata enrichment recommendation).
async function metadataEnrichment(env) {
  if (fault(env, 'metadataConflict')) {
    increment('metadata_contract_violations', { branch: 'metadata-enrichment' });
    const e = new Error('dam:roles removed by uncoordinated update');
    e.code = 'METADATA_CONTRACT_VIOLATION';
    throw e;
  }
  await sleep(25);
  return { enriched: ['dc:title', 'toyota:modelYear', 'toyota:region'] };
}

// 4) Dynamic Media readiness + delivery validation — its own asynchronous
//    readiness branch; consumers must not synchronously wait for DM (doc:
//    Dynamic Media processing). Includes the canary search that would have
//    caught E-002379359 (HTTP 200 / zero results).
async function dynamicMediaReadiness(env) {
  const delay = fault(env, 'dmDelayMs') || 40;
  await sleep(delay);
  observe('dm_sync_latency_ms', delay, { branch: 'dynamic-media-readiness' });

  const canaryResults = fault(env, 'dmZeroResults') ? 0 : 1;
  increment('canary_search_result_count', { hits: String(canaryResults) });
  if (canaryResults === 0) {
    const e = new Error('DM OpenAPI search returned 200 with zero results');
    e.code = 'DM_ZERO_RESULTS';
    throw e; // retryable — DM may still be propagating
  }
  return { scene7FileStatus: 'PublishComplete', deliverable: true, canaryResults };
}

// 5) VIA indexing — final required branch; asset becomes READY_FOR_VIA only
//    after this succeeds (which requires all prior branches to have succeeded).
async function viaIndexing(env) {
  await sleep(15);
  return { viaIndexed: true, assetId: env.assetId };
}

function listProperty(value, propertyName) {
  if (value === undefined || value === null || value === '') return [];
  const entries = Array.isArray(value) ? value : [value];
  return entries.map((entry) => {
    if (typeof entry !== 'string' || !entry.trim() || entry.trim() !== entry) {
      throw new Error(`AEM metadata ${propertyName} must contain non-empty, unpadded strings`);
    }
    return entry;
  });
}

function mixedMediaSetNames(properties) {
  const values = [
    ...listProperty(properties.masterPartRecordKeys, 'masterPartRecordKeys'),
    ...listProperty(properties.businessUnitPartRecordKeys, 'businessUnitPartRecordKeys'),
  ];
  return [...new Set(values)];
}

function isAllowedMixedMediaPath(assetPath) {
  return typeof assetPath === 'string' &&
    MIXED_MEDIA_FOLDERS.some((folder) => assetPath.startsWith(folder) && assetPath.length > folder.length);
}

function isSupportedImage(assetPath) {
  const extension = path.posix.extname(assetPath).toLowerCase();
  return IMAGE_EXTENSIONS.has(extension);
}

async function aemAccessToken(store, config) {
  const durable = config.jwt || config.s2s;
  const token = durable ? await ims.getToken(store, durable) : config.token;
  if (!token) throw new Error('AEM credential is not configured');
  return { token, durable };
}

async function readMixedMediaProperties(store, config, assetPath) {
  let { token, durable } = await aemAccessToken(store, config);
  try {
    return await getAssetProperties(config.host, token, assetPath);
  } catch (error) {
    if (!durable || (error.status !== 401 && error.status !== 403)) throw error;
    await ims.invalidate(store);
    token = await ims.getToken(store, durable, { force: true });
    return getAssetProperties(config.host, token, assetPath);
  }
}

async function mixedMediaSet(env, scene7Config) {
  if (!isAllowedMixedMediaPath(env.assetPath)) {
    return { skipped: true, reason: 'asset is outside the Brand 14 allowlist' };
  }
  if (!isSupportedImage(env.assetPath)) {
    return { skipped: true, reason: 'only image assets are supported in v1' };
  }

  const store = await getStore();
  const aemConfig = await store.get('config:aem');
  if (!aemConfig || !aemConfig.host) return { skipped: true, reason: 'AEM is not configured' };
  if (
    !scene7Config ||
    [
      'server',
      'companyHandle',
      'user',
      'password',
      'sourceImageFolderPath',
      'setSearchFolderPath',
      'setFolderPath',
    ].some((key) => typeof scene7Config[key] !== 'string' || !scene7Config[key])
  ) {
    return { skipped: true, reason: 'Scene7 action inputs are not configured' };
  }
  scene7.normalizeFolderPath(scene7Config.sourceImageFolderPath);
  scene7.normalizeFolderPath(scene7Config.setSearchFolderPath);
  scene7.normalizeFolderPath(scene7Config.setFolderPath);

  const properties = await readMixedMediaProperties(store, aemConfig, env.assetPath);
  const setNames = mixedMediaSetNames(properties);
  if (!setNames.length) return { skipped: true, reason: 'asset has no mixed-media set names' };

  const image = await scene7.findImage(scene7Config, scene7.imageNameFromAssetPath(env.assetPath));
  const member = scene7.imageMemberDefinition(image.assetHandle);
  const pendingKey = `scene7:publishPending:${env.assetId}:${env.assetVersion}`;
  const markPublishPending = () => store.put(pendingKey, { at: new Date().toISOString() });
  let folderHandlePromise = null;
  const getFolderHandle = () => {
    folderHandlePromise = folderHandlePromise ||
      scene7.resolveFolderHandle(scene7Config, scene7Config.setFolderPath);
    return folderHandlePromise;
  };
  const created = [];
  const updated = [];
  const unchanged = [];
  let publishResult = { published: false, jobHandle: null };

  try {
    for (const setName of setNames) {
      const result = await scene7.ensureSetMember(
        scene7Config, setName, member, markPublishPending, getFolderHandle
      );
      if (result.status === 'created') created.push(setName);
      else if (result.status === 'updated') updated.push(setName);
      else unchanged.push(setName);
    }
  } catch (error) {
    try {
      publishResult = await scene7.publishIfPending(scene7Config, store, pendingKey);
    } catch (publishError) {
      const combined = new Error(
        `${error.message || error}; incremental publish also failed: ${publishError.message || publishError}`
      );
      combined.cause = error;
      throw combined;
    }
    throw error;
  }

  publishResult = await scene7.publishIfPending(scene7Config, store, pendingKey);
  return {
    skipped: false,
    setNames,
    created,
    updated,
    unchanged,
    published: publishResult.published,
    jobHandle: publishResult.jobHandle,
    ...(publishResult.alreadyRunning ? { publishAlreadyRunning: true } : {}),
  };
}

const WORK = {
  'workflow-sync': workflowSync,
  'pim-sync': pimSync,
  'metadata-enrichment': metadataEnrichment,
  'dynamic-media-readiness': dynamicMediaReadiness,
  'via-indexing': viaIndexing,
  'mixed-media-set': mixedMediaSet,
};

module.exports = { WORK, mixedMediaSet, mixedMediaSetNames, isAllowedMixedMediaPath };
