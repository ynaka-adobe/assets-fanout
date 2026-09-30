/*
 * Branch action: dynamic-media-readiness
 *
 * An independent fan-out branch with its own queue, retry policy, DLQ,
 * idempotency key, and success/failure state (doc Design Principle 2). In a
 * deployed App Builder app the fan-out dispatcher invokes this action
 * asynchronously (openwhisk async invoke or an I/O Events subscription) so a
 * failure here never blocks the other branches. It shares the branch logic in
 * lib/branchWork.js with the local simulation harness.
 */

const { runBranch } = require('../../../lib/branchRunner');
const { WORK } = require('../../../lib/branchWork');

const BRANCH_ID = 'dynamic-media-readiness';

async function main(envelope) {
  try {
    const result = await runBranch(BRANCH_ID, envelope, WORK[BRANCH_ID]);
    return { statusCode: 200, body: result };
  } catch (err) {
    return { statusCode: 500, body: { branchId: BRANCH_ID, error: String(err.message || err) } };
  }
}

exports.main = main;
