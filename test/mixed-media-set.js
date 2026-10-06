const assert = require('node:assert/strict');
const { assetApiUrl, getAssetProperties } = require('../lib/aem');
const { getStore } = require('../lib/store');
const { WORK, mixedMediaSetNames } = require('../lib/branchWork');
const scene7 = require('../lib/scene7');
const ingest = require('../actions/ingest');
const ledger = require('../lib/ledger');
const { runBranch } = require('../lib/branchRunner');
const { BRANCH, READINESS, REQUIRED_BRANCHES, OPTIONAL_BRANCHES } = require('../lib/states');

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<(?:(?:[\\w.-]+):)?${tag}>([\\s\\S]*?)</(?:(?:[\\w.-]+):)?${tag}>`));
  if (!match) return '';
  return match[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function soapReturn(operation, inner) {
  return (
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soapenv:Body><${operation}Return>${inner}</${operation}Return></soapenv:Body></soapenv:Envelope>`
  );
}

function assetItem(asset, tag = 'items') {
  return `<${tag}><assetHandle>${xmlEscape(asset.assetHandle)}</assetHandle>` +
    `<name>${xmlEscape(asset.name)}</name><type>${xmlEscape(asset.type || '')}</type>` +
    `<subType>${xmlEscape(asset.subType || '')}</subType>` +
    `<catalogId>${xmlEscape(asset.catalogId || '')}</catalogId>` +
    `${asset.setDefinition === undefined ? '' : `<setDefinition>${xmlEscape(asset.setDefinition)}</setDefinition>`}</${tag}>`;
}

async function main() {
  assert.equal(
    assetApiUrl('https://aem.example', '/content/dam/brand/Brand 14/front image.jpg'),
    'https://aem.example/api/assets/brand/Brand%2014/front%20image.jpg.json'
  );
  assert.throws(() => assetApiUrl('https://aem.example', '/content/dam/../etc/passwd'), /invalid/);
  assert.equal(
    scene7.imageMemberDefinition('a|9686|front.jpg'),
    '${getCatalogId([a|9686|front.jpg])};${getCatalogId([a|9686|front.jpg])};advanced_image;'
  );
  assert.throws(() => scene7.imageMemberDefinition('v|9686|clip.mp4'), /image asset handle/);
  assert.equal(scene7.imageNameFromAssetPath('/content/dam/Brand 14/8M0222065.v2.JPG'), '8M0222065.v2');
  assert.deepEqual(
    mixedMediaSetNames({
      masterPartRecordKeys: ['Existing Set', 'New Set', 'Shared Set'],
      businessUnitPartRecordKeys: ['New Set', 'Shared Set'],
    }),
    ['Existing Set', 'New Set', 'Shared Set']
  );
  assert.throws(
    () => mixedMediaSetNames({ masterPartRecordKeys: [' padded '] }),
    /non-empty, unpadded strings/
  );
  assert.ok(OPTIONAL_BRANCHES.includes('mixed-media-set'));
  assert.equal(REQUIRED_BRANCHES.includes('mixed-media-set'), false);

  const store = await getStore();
  await store.put('config:aem', { host: 'https://aem.example', token: 'aem-test-token' });
  const scene7Config = {
    server: 'https://scene7.example',
    companyHandle: 'c|9686',
    user: 'test-user',
    password: 'test-password',
    sourceImageFolderPath: 'mock/source-images/',
    setSearchFolderPath: 'mock/sets/',
    setFolderPath: 'mock/sets/',
  };
  const folderHandle = 'f|mock/sets/';
  const image = {
    assetHandle: 'a|9686|front.jpg',
    name: 'front',
    type: 'Image',
    catalogId: 'MUST_NOT_BE_USED',
  };
  const sets = new Map([
    ['Existing Set', {
      assetHandle: 's|9686|existing',
      name: 'Existing Set',
      type: 'MediaSet',
      setDefinition: 'prior-member;',
    }],
  ]);
  const setsByHandle = new Map([[sets.get('Existing Set').assetHandle, sets.get('Existing Set')]]);
  const calls = [];
  const imageNameRequests = [];
  let metadata = {
    masterPartRecordKeys: ['Existing Set', 'New Set', 'Shared Set'],
    businessUnitPartRecordKeys: ['New Set', 'Shared Set'],
  };
  let faultResponse = null;
  let submitJobFaultResponse = null;
  let aemReads = 0;
  let mutations = 0;
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    if (String(url).startsWith('https://aem.example/')) {
      aemReads += 1;
      assert.equal(options.headers.Authorization, 'Bearer aem-test-token');
      assert.equal(options.headers.Accept, 'application/json');
      return response(JSON.stringify({ properties: { metadata } }));
    }
    assert.equal(String(url), 'https://scene7.example/scene7/services/IpsApiService');
    assert.ok(options.headers.Authorization.startsWith('Basic '));
    assert.equal(options.body.includes('test-password'), false);
    if (faultResponse) return faultResponse;
    const operation = options.headers.SOAPAction;
    calls.push({ operation, body: options.body });

    if (operation === 'searchAssets') {
      const requestedName = xmlValue(options.body, 'value');
      const folder = xmlValue(options.body, 'folder');
      if (folder === scene7Config.sourceImageFolderPath) imageNameRequests.push(requestedName);
      const matches = folder === scene7Config.sourceImageFolderPath && requestedName === image.name
        ? [image]
        : folder === scene7Config.setSearchFolderPath && sets.has(requestedName)
          ? [sets.get(requestedName)]
          : [];
      const items = matches.map((asset) => assetItem(asset)).join('');
      return response(soapReturn(operation, `<assetArray>${items}</assetArray><totalRows>${matches.length}</totalRows>`));
    }

    if (operation === 'getAssets') {
      const handle = xmlValue(options.body, 'items');
      const asset = handle === image.assetHandle ? image : setsByHandle.get(handle);
      return response(soapReturn(operation, `<assetArray>${asset ? assetItem(asset, 'asset') : ''}</assetArray>`));
    }

    if (operation === 'getFolders') {
      assert.equal(xmlValue(options.body, 'companyHandle'), 'c|9686');
      assert.equal(xmlValue(options.body, 'folderPath'), 'mock/');
      return response(soapReturn(operation,
        '<folderArray><items><folderHandle>f|mock/sets/</folderHandle>' +
        '<path>mock/sets/</path></items></folderArray>'));
    }

    if (operation === 'createAssetSet') {
      mutations += 1;
      assert.match(options.body, /<ips:subType>MediaSet<\/ips:subType>/);
      assert.equal(xmlValue(options.body, 'companyHandle'), 'c|9686');
      assert.equal(xmlValue(options.body, 'folderHandle'), folderHandle);
      const name = xmlValue(options.body, 'name');
      const asset = {
        assetHandle: `s|9686|${name.replace(/\s/g, '-')}`,
        name,
        type: 'MediaSet',
        setDefinition: xmlValue(options.body, 'setDefinition'),
      };
      sets.set(name, asset);
      setsByHandle.set(asset.assetHandle, asset);
      return response(soapReturn(operation, `<assetHandle>${xmlEscape(asset.assetHandle)}</assetHandle>`));
    }

    if (operation === 'setAssetSetDefinition') {
      mutations += 1;
      const set = setsByHandle.get(xmlValue(options.body, 'assetHandle'));
      assert.ok(set);
      set.setDefinition = xmlValue(options.body, 'setDefinition');
      return response(soapReturn(operation, '<status>Success</status>'));
    }

    if (operation === 'submitJob') {
      mutations += 1;
      assert.match(options.body, /<ips:publishType>Incremental<\/ips:publishType>/);
      assert.match(options.body, /<ips:emailSetting>None<\/ips:emailSetting>/);
      assert.equal(xmlValue(options.body, 'companyHandle'), 'c|9686');
      assert.match(xmlValue(options.body, 'jobName'), /^fanout-mixed-media-/);
      if (submitJobFaultResponse) return submitJobFaultResponse;
      return response(soapReturn(operation, '<jobHandle>job-1</jobHandle>'));
    }

    throw new Error(`Unexpected SOAP operation ${operation}`);
  };

  try {
    const env = {
      assetId: 'asset-1',
      assetVersion: 'v1',
      assetPath: '/content/dam/brand/Brand 14/front.jpg',
    };
    const result = await WORK['mixed-media-set'](env, scene7Config);
    assert.deepEqual(result.setNames, ['Existing Set', 'New Set', 'Shared Set']);
    assert.deepEqual(result.updated, ['Existing Set']);
    assert.deepEqual(result.created, ['New Set', 'Shared Set']);
    assert.deepEqual(result.unchanged, []);
    assert.equal(result.published, true);
    assert.equal(result.jobHandle, 'job-1');
    assert.deepEqual(imageNameRequests, ['front']);
    assert.equal(sets.get('Existing Set').setDefinition,
      'prior-member;,${getCatalogId([a|9686|front.jpg])};${getCatalogId([a|9686|front.jpg])};advanced_image;');
    assert.equal(sets.get('New Set').setDefinition.includes('MUST_NOT_BE_USED'), false);
    assert.equal(calls.filter((call) => call.operation === 'submitJob').length, 1);
    assert.equal(mutations, 4);

    const repeat = await WORK['mixed-media-set'](env, scene7Config);
    assert.deepEqual(repeat.created, []);
    assert.deepEqual(repeat.updated, []);
    assert.deepEqual(repeat.unchanged, ['Existing Set', 'New Set', 'Shared Set']);
    assert.equal(repeat.published, false);
    assert.equal(calls.filter((call) => call.operation === 'submitJob').length, 1);

    metadata = { masterPartRecordKeys: ['Existing Set'], businessUnitPartRecordKeys: [] };
    const existingMember = await WORK['mixed-media-set']({
      ...env,
      assetId: 'asset-existing-member',
      assetVersion: 'v2',
    }, scene7Config);
    assert.deepEqual(existingMember.unchanged, ['Existing Set']);
    assert.equal(existingMember.published, false);
    assert.equal(calls.filter((call) => call.operation === 'setAssetSetDefinition').length, 1);

    const alreadyRunningFault = response(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode>' +
        `<faultstring>${xmlEscape("A job of type 'Image Serving Publish' is already running for this company.")}</faultstring>` +
        '<detail><ips:ipsApiFault xmlns:ips="http://www.scene7.com/IpsApi/xsd/2013-02-15">' +
        '<ips:code>30000</ips:code>' +
        `<ips:reason>${xmlEscape("A job of type 'Image Serving Publish' is already running for this company.")}</ips:reason>` +
        '</ips:ipsApiFault></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>',
      500
    );
    metadata = { masterPartRecordKeys: ['Already Running Set'], businessUnitPartRecordKeys: [] };
    submitJobFaultResponse = alreadyRunningFault;
    const alreadyRunningEnv = {
      ...env,
      assetId: 'asset-publish-already-running',
      assetVersion: 'v1',
      branchExecutionId: 'publish-already-running-execution',
    };
    await ledger.open(alreadyRunningEnv);
    const alreadyRunning = await runBranch(
      'mixed-media-set',
      alreadyRunningEnv,
      (branchEnv) => WORK['mixed-media-set'](branchEnv, scene7Config),
      { maxAttempts: 3, baseBackoffMs: 1 }
    );
    assert.equal(alreadyRunning.status, BRANCH.SUCCEEDED);
    assert.equal(alreadyRunning.attempts, 1);
    assert.equal(alreadyRunning.result.published, true);
    assert.equal(alreadyRunning.result.publishAlreadyRunning, true);
    assert.equal(alreadyRunning.result.jobHandle, null);
    assert.equal(await store.get('scene7:publishPending:asset-publish-already-running:v1'), undefined);
    assert.equal(await store.get('dlq:mixed-media-set:publish-already-running-execution'), undefined);

    const otherPublishFault = response(
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soapenv:Body><soapenv:Fault><faultcode>soapenv:Server</faultcode>' +
        '<faultstring>Scene7 publish failed</faultstring>' +
        '<detail><ips:ipsApiFault xmlns:ips="http://www.scene7.com/IpsApi/xsd/2013-02-15">' +
        '<ips:code>30001</ips:code><ips:reason>Another publish error</ips:reason>' +
        '</ips:ipsApiFault></detail></soapenv:Fault></soapenv:Body></soapenv:Envelope>',
      500
    );
    metadata = { masterPartRecordKeys: ['Other Publish Fault Set'], businessUnitPartRecordKeys: [] };
    submitJobFaultResponse = otherPublishFault;
    const otherFaultEnv = {
      ...env,
      assetId: 'asset-other-publish-fault',
      assetVersion: 'v1',
      branchExecutionId: 'other-publish-fault-execution',
    };
    await ledger.open(otherFaultEnv);
    const otherFault = await runBranch(
      'mixed-media-set',
      otherFaultEnv,
      (branchEnv) => WORK['mixed-media-set'](branchEnv, scene7Config),
      { maxAttempts: 3, baseBackoffMs: 1 }
    );
    assert.equal(otherFault.status, BRANCH.DEAD_LETTER);
    assert.equal(otherFault.attempts, 3);
    assert.ok(await store.get('dlq:mixed-media-set:other-publish-fault-execution'));
    for (const branchId of REQUIRED_BRANCHES) {
      await store.put(`branch:${otherFaultEnv.assetId}:${branchId}`, { state: BRANCH.SUCCEEDED });
    }
    const optionalFailureRecord = await ledger.load(otherFaultEnv.assetId);
    assert.equal(optionalFailureRecord.branches['mixed-media-set'].state, BRANCH.DEAD_LETTER);
    assert.equal(optionalFailureRecord.readiness, READINESS.READY_FOR_VIA);

    metadata = { masterPartRecordKeys: ['Set A', 'Set A'], businessUnitPartRecordKeys: [] };
    const noConfig = await WORK['mixed-media-set'](env);
    assert.equal(noConfig.skipped, true);
    const outside = await WORK['mixed-media-set']({
      ...env,
      assetPath: '/content/dam/brand/Brand 14-elsewhere/front.jpg',
    }, scene7Config);
    assert.equal(outside.skipped, true);
    const video = await WORK['mixed-media-set']({
      ...env,
      assetPath: '/content/dam/brand/Brand 14/video.mp4',
    }, scene7Config);
    assert.equal(video.skipped, true);

    assert.equal(aemReads, 7);
    assert.equal(await store.get('config:scene7'), undefined);
    assert.deepEqual(scene7.appendMember('member;', 'member;'), {
      setDefinition: 'member;',
      changed: false,
    });
    assert.throws(() => scene7.normalizeFolderPath('/mock/path/'), /folder path/);

    const updatedEvent = {
      id: 'metadata-update-1',
      source: 'test',
      type: 'aem.assets.asset.metadata_updated',
      data: {
        assetMetadata: { 'event:updated': { masterPartRecordKeys: ['Set A'] } },
        repositoryMetadata: {
          'repo:assetId': 'metadata-updated-asset',
          'repo:path': '/content/dam/brand/Brand 14/metadata.jpg',
          'repo:version': 'repo-version',
        },
      },
    };
    const updatedResult = await ingest.main(updatedEvent);
    assert.equal(updatedResult.statusCode, 200);
    assert.deepEqual(updatedResult.body.branches.map((branch) => branch.branchId), ['mixed-media-set']);
    assert.equal(updatedResult.body.readiness, READINESS.BRANCH_PENDING);
    const updatedRecord = await ledger.load('metadata-updated-asset');
    assert.equal(updatedRecord.branches['mixed-media-set'].state, BRANCH.SUCCEEDED);
    for (const branchId of REQUIRED_BRANCHES) {
      assert.equal(updatedRecord.branches[branchId].state, BRANCH.PENDING);
    }

    const createdEvent = {
      id: 'metadata-created-1',
      type: 'aem.assets.asset.metadata_updated',
      data: {
        assetMetadata: {
          'event:created': [
            { name: 'businessUnitPartRecordKeys' },
            { name: 'dc:title' },
          ],
        },
        repositoryMetadata: {
          'repo:assetId': 'metadata-created-asset',
          'repo:path': '/content/dam/brand/Brand 14/metadata.jpg',
        },
      },
    };
    const createdResult = await ingest.main(createdEvent);
    assert.equal(createdResult.statusCode, 200);
    assert.deepEqual(createdResult.body.branches.map((branch) => branch.branchId), ['mixed-media-set']);
    assert.equal((await ledger.load('metadata-created-asset')).branches['mixed-media-set'].state, BRANCH.SUCCEEDED);

    const unrelatedEvent = JSON.parse(JSON.stringify(updatedEvent));
    unrelatedEvent.data.assetMetadata['event:updated'] = { 'dc:title': 'Old title' };
    const ignoredResult = await ingest.main(unrelatedEvent);
    assert.equal(ignoredResult.body.ignored, true);
    assert.equal(ignoredResult.body.reason, 'no mixed-media metadata fields changed');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('PASS mixed-media-set branch, optional dispatch, and publish fault handling');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
