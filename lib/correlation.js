/*
 * Correlation and traceability contract (architecture doc, "Correlation and
 * traceability contract"). Every asset-processing attempt carries a common
 * correlation envelope so each fan-out branch can be traced end to end and
 * deduplicated by asset id + revision.
 */

const crypto = require('crypto');

function uuid() {
  return crypto.randomUUID();
}

/**
 * Build the correlation envelope for one processing attempt of one asset.
 * Fields map 1:1 to the doc; unknown AEM job ids are left null so downstream
 * dashboards can distinguish "not applicable" from "missing".
 *
 * @param {object} assetEvent Normalized asset event
 * @param {object} [overrides] Optional field overrides (branchId, attempt, ...)
 */
function buildEnvelope(assetEvent, overrides = {}) {
  const {
    assetId,
    assetPath,
    assetVersion,
    sourceSystem = 'aem-ui',
    aemEnvironment = 'production',
    aemProgram = 'via',
    processingProfile = null,
    aemProcessingId = null,
    importJobId = null,
    asyncJobId = null,
    dynamicMediaRequestId = null,
    dynamicMediaBatchId = null,
  } = assetEvent;

  return {
    assetId,
    assetPath,
    assetVersion,
    sourceSystem,
    aemEnvironment,
    aemProgram,
    processingProfile,
    aemProcessingId,
    importJobId,
    asyncJobId,
    dynamicMediaRequestId,
    dynamicMediaBatchId,
    fanoutId: overrides.fanoutId || uuid(), // stable id for this processing attempt
    branchId: overrides.branchId || null, // pim|metadata|dynamic-media|workflow-sync|via
    branchExecutionId: overrides.branchExecutionId || null, // unique per branch attempt
    eventId: overrides.eventId || uuid(),
    attempt: overrides.attempt || 1,
    ...overrides,
  };
}

/**
 * Idempotency key: asset id + asset revision + branch. Guarantees that a
 * duplicate completion event (Toyota pilot test case) is a no-op per branch.
 */
function idempotencyKey(envelope, branchId) {
  const raw = `${envelope.assetId}:${envelope.assetVersion}:${branchId}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

module.exports = { buildEnvelope, idempotencyKey, uuid };
