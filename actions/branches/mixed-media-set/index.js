/*
 * Optional Scene7 Mixed Media Set integration for the Brand 14 demo.
 * Its status is visible in the ledger but does not gate READY_FOR_VIA.
 */

const { runBranch } = require('../../../lib/branchRunner');
const { WORK } = require('../../../lib/branchWork');

const BRANCH_ID = 'mixed-media-set';

function redactError(error, config) {
  let message = String(error && error.message ? error.message : error);
  const basicAuth = Buffer.from(`${config.user}:${config.password}`).toString('base64');
  const escapedPassword = config.password && String(config.password)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  const secrets = [
    config.user,
    config.password,
    escapedPassword,
    `${config.user}:${config.password}`,
    basicAuth,
  ];
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  const safe = new Error(message);
  if (error && error.code) safe.code = error.code;
  return safe;
}

async function main(params) {
  const {
    S7_SERVER: server,
    S7_COMPANY_HANDLE: companyHandle,
    S7_USER: user,
    S7_PASSWORD: password,
    S7_SOURCE_IMAGE_FOLDER_PATH: sourceImageFolderPath,
    S7_SET_SEARCH_FOLDER_PATH: setSearchFolderPath,
    S7_SET_FOLDER_PATH: setFolderPath,
    ...envelope
  } = params || {};
  const scene7Config = {
    server,
    companyHandle,
    user,
    password,
    sourceImageFolderPath,
    setSearchFolderPath,
    setFolderPath,
  };
  const safeWork = async (branchEnv) => {
    try {
      return await WORK[BRANCH_ID](branchEnv, scene7Config);
    } catch (error) {
      throw redactError(error, scene7Config);
    }
  };
  try {
    const result = await runBranch(BRANCH_ID, envelope, safeWork);
    return { statusCode: 200, body: result };
  } catch (err) {
    const safeError = redactError(err, scene7Config);
    return { statusCode: 500, body: { branchId: BRANCH_ID, error: safeError.message } };
  }
}

exports.main = main;
