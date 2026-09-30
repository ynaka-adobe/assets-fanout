/*
 * Business-readiness state model (Design Principle 3 in the architecture doc).
 *
 * Core-tier states mirror dam:assetState inside AEM; the business-readiness
 * states live OUTSIDE AEM in the processing ledger so that a fan-out branch
 * failure is observable without touching AEM Author.
 */

// Core tier — foundational processing (owned by AEM / Asset Compute)
const CORE = Object.freeze({
  PROCESSING: 'processing',
  PROCESSED: 'processed',
  FAILED: 'failed',
  CUSTOM_WORKFLOW_PROCESSING: 'customWorkflowProcessing',
});

// Business-readiness states (owned by this App Builder app, stored in the ledger)
const READINESS = Object.freeze({
  RECEIVED: 'RECEIVED', // Upload or asset-completion event received
  CORE_PROCESSING: 'CORE_PROCESSING', // AEM core processing not complete
  CORE_COMPLETE: 'CORE_COMPLETE', // AEM core processing completed
  BRANCH_PENDING: 'BRANCH_PENDING', // One or more fan-out branches not started
  BRANCH_RUNNING: 'BRANCH_RUNNING', // At least one branch executing
  BRANCH_RETRYABLE_FAILURE: 'BRANCH_RETRYABLE_FAILURE', // Failed but retryable
  BRANCH_TERMINAL_FAILURE: 'BRANCH_TERMINAL_FAILURE', // Manual intervention required
  PARTIALLY_READY: 'PARTIALLY_READY', // Some branches completed
  READY_FOR_VIA: 'READY_FOR_VIA', // All required Toyota branches completed
});

// Per-branch terminal states
const BRANCH = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  RETRYABLE_FAILURE: 'RETRYABLE_FAILURE',
  DEAD_LETTER: 'DEAD_LETTER',
});

/*
 * The required Toyota branches, in the doc's recommended migration order
 * (Phase 4). This order establishes the eventing/retry model on the least
 * timing-sensitive branch before migrating Dynamic Media last.
 */
const REQUIRED_BRANCHES = Object.freeze([
  'workflow-sync',
  'pim-sync',
  'metadata-enrichment',
  'dynamic-media-readiness',
  'via-indexing',
]);

module.exports = { CORE, READINESS, BRANCH, REQUIRED_BRANCHES };
