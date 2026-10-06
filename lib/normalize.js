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
const METADATA_UPDATED_EVENT_CODE = 'aem.assets.asset.metadata_updated';
const MIXED_MEDIA_METADATA_FIELDS = Object.freeze([
  'masterPartRecordKeys',
  'businessUnitPartRecordKeys',
]);

function normalizeMetadataUpdate(rawEvent, data) {
  const metadata = data.assetMetadata || {};
  const updatedFields = metadata['event:updated'];
  const createdFields = metadata['event:created'];
  const fieldNames = new Set();
  if (updatedFields && typeof updatedFields === 'object' && !Array.isArray(updatedFields)) {
    Object.keys(updatedFields).forEach((field) => fieldNames.add(field));
  }
  if (Array.isArray(createdFields)) {
    createdFields.forEach((field) => {
      if (typeof field === 'string') {
        fieldNames.add(field);
      } else if (field && typeof field === 'object') {
        ['name', 'propertyName', 'key'].forEach((key) => {
          if (typeof field[key] === 'string') fieldNames.add(field[key]);
        });
      }
    });
  } else if (createdFields && typeof createdFields === 'object') {
    Object.keys(createdFields).forEach((field) => fieldNames.add(field));
  }
  const changedMetadataFields = MIXED_MEDIA_METADATA_FIELDS.filter((field) => fieldNames.has(field));
  if (!changedMetadataFields.length) {
    return { ignored: true, reason: 'no mixed-media metadata fields changed' };
  }

  const repositoryMetadata = data.repositoryMetadata || {};
  const assetId =
    repositoryMetadata['repo:assetId'] ||
    repositoryMetadata['repo:id'] ||
    data.assetId ||
    data['repo:assetId'] ||
    data['repo:id'];
  const assetPath = repositoryMetadata['repo:path'] || data.assetPath || data.path;
  if (!assetId || !assetPath) {
    return { ignored: true, reason: 'missing repository metadata asset id/path' };
  }

  const eventId = rawEvent.id || rawEvent.event_id || rawEvent.eventId || data.event_id || data.eventId;
  return {
    eventType: METADATA_UPDATED_EVENT_CODE,
    assetId,
    assetPath,
    assetVersion:
      eventId ||
      repositoryMetadata['repo:version'] ||
      repositoryMetadata['repo:etag'] ||
      data.assetVersion ||
      data['repo:version'] ||
      data.etag ||
      'v0',
    sourceSystem: rawEvent.source || 'aem-assets',
    aemEnvironment: 'production',
    aemProgram: 'via',
    changedMetadataFields,
  };
}

function normalize(rawEvent) {
  // Adobe I/O Events wraps AEM events as CloudEvents; payload is under `data`.
  const data = rawEvent && rawEvent.data ? rawEvent.data : rawEvent || {};
  const type = rawEvent && (rawEvent.type || rawEvent.event_code);

  if (type === METADATA_UPDATED_EVENT_CODE) {
    return normalizeMetadataUpdate(rawEvent, data);
  }

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

module.exports = {
  normalize,
  COMPLETED_EVENT_CODES,
  METADATA_UPDATED_EVENT_CODE,
  MIXED_MEDIA_METADATA_FIELDS,
};
