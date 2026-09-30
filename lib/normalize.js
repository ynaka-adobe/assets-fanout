/*
 * Normalize a raw AEM "asset processing completed" I/O Event into a Toyota
 * asset event (doc Phase 3: "Consume the asset processing-completed event.
 * Normalize it into a Toyota asset event. Add correlation ID, asset revision,
 * and source system.").
 *
 * Accepts the CloudEvents envelope AEM Assets emits over Adobe I/O Events.
 * Only asset processing-COMPLETED events cross the boundary; an asset merely
 * accepted by Asset Compute is NOT ready (doc Design Principle 1 — the exact
 * gap that caused Toyota incident E-002364923).
 */

const COMPLETED_EVENT_CODES = new Set([
  'aem.assets.asset.processing_completed',
  'aem.assets.asset.processed',
]);

function normalize(rawEvent) {
  // Adobe I/O Events wraps AEM events as CloudEvents; payload is under `data`.
  const data = rawEvent && rawEvent.data ? rawEvent.data : rawEvent || {};
  const type = rawEvent && (rawEvent.type || rawEvent.event_code);

  if (type && !COMPLETED_EVENT_CODES.has(type)) {
    return { ignored: true, reason: `not a completion event: ${type}` };
  }

  // Real AEM cloud-native events nest repo fields under `repositoryMetadata`;
  // our test fixtures use flat fields. Support both.
  const repo = data.repositoryMetadata || {};

  const assetId = data.assetId || repo['repo:id'] || data['repo:id'] || data['xdm:assetId'];
  const assetPath = data.assetPath || repo['repo:path'] || data['repo:path'] || data.path;
  if (!assetId || !assetPath) {
    return { ignored: true, reason: 'missing assetId/assetPath' };
  }

  return {
    assetId,
    assetPath,
    // Content-hash or version id → the revision half of the idempotency key.
    // Prefer repo:version, then the binary sha1, then flat fallbacks.
    assetVersion:
      data.assetVersion ||
      repo['repo:version'] ||
      repo['dam:sha1'] ||
      data['repo:etag'] ||
      data.etag ||
      'v0',
    sourceSystem: data.sourceSystem || rawEvent.source || 'aem-ui',
    aemEnvironment: data.aemEnvironment || 'production',
    aemProgram: data.aemProgram || 'via',
    processingProfile: data.processingProfile || null,
    aemProcessingId: data['dam:processingId'] || null,
    importJobId: data['dam:importJobId'] || null,
    asyncJobId: data['dam:asyncJobId'] || null,
    dynamicMediaRequestId: data['dam:scene7RequestID'] || null,
    dynamicMediaBatchId: data['dam:scene7BatchId'] || null,
    faults: data.faults, // demo-only fault injection passthrough
  };
}

module.exports = { normalize, COMPLETED_EVENT_CODES };
