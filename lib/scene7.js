/*
 * Minimal Scene7 IPS SOAP client. It uses fetch and a small XML reader to keep
 * the I/O Runtime action free of additional XML dependencies.
 */

const path = require('path');

const NAMESPACE = 'http://www.scene7.com/IpsApi/xsd/2013-02-15';
const SERVICE_PATH = '/scene7/services/IpsApiService';

function localName(name) {
  return name.split(':').pop();
}

function decodeXml(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity === 'amp') return '&';
    if (entity === 'lt') return '<';
    if (entity === 'gt') return '>';
    if (entity === 'quot') return '"';
    if (entity === 'apos') return "'";
    const codePoint = entity[1].toLowerCase() === 'x'
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
  });
}

function parseXml(xml) {
  const root = { name: '#document', text: '', children: [] };
  const stack = [root];
  const tokens =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<\/[^>]+>|<[^>]+>|[^<]+/g;
  let match;
  while ((match = tokens.exec(xml))) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) continue;
    if (token.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('</')) {
      const closing = token.match(/^<\/\s*([^\s>]+)/);
      if (stack.length === 1 || !closing || stack[stack.length - 1].qualifiedName !== closing[1]) {
        throw new Error('Invalid Scene7 SOAP XML: mismatched closing tag');
      }
      stack.pop();
      continue;
    }
    if (token.startsWith('<')) {
      const opening = token.match(/^<\s*([^\s/>]+)/);
      if (!opening) continue;
      const node = { name: localName(opening[1]), qualifiedName: opening[1], text: '', children: [] };
      stack[stack.length - 1].children.push(node);
      if (!/\/\s*>$/.test(token)) stack.push(node);
      continue;
    }
    stack[stack.length - 1].text += decodeXml(token);
  }
  if (stack.length !== 1) throw new Error('Invalid Scene7 SOAP XML: unclosed element');
  return root;
}

function descendants(node, name) {
  const found = [];
  for (const child of node.children || []) {
    if (child.name === name) found.push(child);
    found.push(...descendants(child, name));
  }
  return found;
}

function textContent(node) {
  return `${node.text || ''}${(node.children || []).map(textContent).join('')}`;
}

function firstText(node, names) {
  for (const name of names) {
    const found = descendants(node, name)[0];
    if (found) return textContent(found);
  }
  return '';
}

const IPS_FAULT_NAMES = ['authenticationFault', 'authorizationFault', 'ipsApiFault'];
const MAX_FAULT_TEXT = 300;
const PUBLISH_ALREADY_RUNNING_CODE = 'ipsApiFault:30000';
const PUBLISH_ALREADY_RUNNING_REASON =
  "A job of type 'Image Serving Publish' is already running for this company.";

function sanitizeFaultText(value, config) {
  let text = String(value || '');
  const user = config && config.user;
  const password = config && config.password;
  const secrets = [user, password, password && escapeXml(password)];
  if (user && password) {
    secrets.push(`${user}:${password}`, Buffer.from(`${user}:${password}`).toString('base64'));
  }
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > MAX_FAULT_TEXT ? `${text.slice(0, MAX_FAULT_TEXT)}…` : text;
}

function makeFaultError(fault, operation, config, status) {
  const message = firstText(fault, ['faultstring', 'Text', 'Reason']) || 'Scene7 SOAP fault';
  const code = firstText(fault, ['faultcode', 'Value', 'Code']);
  const ipsFault = IPS_FAULT_NAMES.map((name) => descendants(fault, name)[0]).find(Boolean);
  const ipsCode = ipsFault ? firstText(ipsFault, ['code']) : '';
  const ipsReason = ipsFault ? firstText(ipsFault, ['reason']) : '';
  const parts = [`Scene7 ${operation}`];
  if (status) parts.push(`→ HTTP ${status}`);
  parts.push(`fault${code ? ` ${sanitizeFaultText(code, config)}` : ''}:`);
  parts.push(sanitizeFaultText(message, config));
  if (ipsFault) {
    const detail = [ipsFault.name, ipsCode, ipsReason && sanitizeFaultText(ipsReason, config)];
    parts.push(`(${detail.filter(Boolean).join(' ')})`);
  }
  const error = new Error(parts.join(' '));
  error.code = ipsCode ? `${ipsFault.name}:${ipsCode}` : (sanitizeFaultText(code, config) || 'SCENE7_SOAP_FAULT');
  if (status) error.status = status;
  return error;
}

function parseAssetArray(xml) {
  const root = parseXml(xml);
  const fault = descendants(root, 'Fault')[0];
  if (fault) throw makeFaultError(fault, 'response');
  const array = descendants(root, 'assetArray')[0];
  if (!array) return [];
  let records = array.children.filter((child) =>
    descendants(child, 'assetHandle').length || descendants(child, 'assetSetHandle').length
  );
  if (!records.length) {
    records = descendants(array, 'items').filter((node) =>
      descendants(node, 'assetHandle').length || descendants(node, 'assetSetHandle').length
    );
  }
  return records.map((record) => {
    const definitionNode = descendants(record, 'setDefinition')[0] ||
      descendants(record, 'assetSetDefinition')[0];
    return {
      assetHandle: firstText(record, ['assetHandle', 'assetSetHandle']),
      name: firstText(record, ['name', 'assetName']),
      type: firstText(record, ['type', 'assetType']),
      subType: firstText(record, ['subType', 'assetSubType']),
      setDefinition: definitionNode ? textContent(definitionNode) : '',
      hasSetDefinition: Boolean(definitionNode),
    };
  }).filter((asset) => asset.assetHandle);
}

function endpoint(server) {
  if (typeof server !== 'string' || !server) throw new Error('Scene7 server is not configured');
  const parsed = new URL(server);
  if (parsed.protocol !== 'https:') throw new Error('Scene7 server must use HTTPS');
  if (parsed.search || parsed.hash) throw new Error('Scene7 server must not include a query or fragment');
  if (parsed.pathname === SERVICE_PATH) return `${parsed.origin}${SERVICE_PATH}`;
  if (parsed.pathname !== '/') {
    throw new Error(`Scene7 server path must be empty or ${SERVICE_PATH}`);
  }
  return `${parsed.origin}${SERVICE_PATH}`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function envelope(operation, payload) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
    '<soapenv:Body>' +
    `<ips:${operation}Param xmlns:ips="${NAMESPACE}">${payload}</ips:${operation}Param>` +
    '</soapenv:Body></soapenv:Envelope>'
  );
}

async function call(config, operation, payload) {
  if (!config || !config.user || !config.password || !config.companyHandle) {
    throw new Error('Scene7 credentials and companyHandle are not configured');
  }
  const authorization = Buffer.from(`${config.user}:${config.password}`).toString('base64');
  const response = await fetch(endpoint(config.server), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authorization}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: operation,
    },
    body: envelope(operation, payload),
  });
  const body = await response.text();
  let fault = null;
  try {
    fault = descendants(parseXml(body), 'Fault')[0] || null;
  } catch (parseError) {
    if (response.ok) throw parseError;
  }
  if (fault) throw makeFaultError(fault, operation, config, response.ok ? null : response.status);
  if (!response.ok) {
    const contentType = response.headers && typeof response.headers.get === 'function'
      ? sanitizeFaultText(response.headers.get('content-type') || 'unknown', config)
      : 'unknown';
    const error = new Error(
      `Scene7 ${operation} → HTTP ${response.status} without a SOAP fault ` +
        `(content-type ${contentType}, ${Buffer.byteLength(body)} bytes)`
    );
    error.status = response.status;
    throw error;
  }
  return body;
}

const SEARCH_PAGE_SIZE = 1000;
const SEARCH_MAX_PAGES = 20;

async function getAssetsByName(config, name) {
  const body = await call(
    config,
    'getAssetsByName',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:nameArray><ips:items>${escapeXml(name)}</ips:items></ips:nameArray>`
  );
  return parseAssetArray(body);
}

async function searchAssetsByName(config, name, options = {}) {
  if (typeof name !== 'string' || !name) throw new Error('Scene7 search name is required');
  const folder = normalizeFolderPath(options.folder);
  const pageSize = options.pageSize || SEARCH_PAGE_SIZE;
  const maxPages = options.maxPages || SEARCH_MAX_PAGES;
  const types = (options.assetTypes || [])
    .map((type) => `<ips:items>${escapeXml(type)}</ips:items>`).join('');
  const results = new Map();
  let totalRows = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await call(
      config,
      'searchAssets',
      `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
        `<ips:folder>${escapeXml(folder)}</ips:folder>` +
        `<ips:includeSubfolders>${options.includeSubfolders === true}</ips:includeSubfolders>` +
        '<ips:systemFieldConditionArray><ips:items>' +
        `<ips:field>Name</ips:field><ips:op>Equals</ips:op><ips:value>${escapeXml(name)}</ips:value>` +
        '</ips:items></ips:systemFieldConditionArray>' +
        (types ? `<ips:assetTypeArray>${types}</ips:assetTypeArray>` : '') +
        `<ips:recordsPerPage>${pageSize}</ips:recordsPerPage>` +
        `<ips:resultsPage>${page}</ips:resultsPage>`
    );
    const assets = parseAssetArray(body);
    const rowsText = firstText(parseXml(body), ['totalRows']).trim();
    if (page === 1 && rowsText !== '') {
      totalRows = Number(rowsText);
      if (!Number.isInteger(totalRows) || totalRows < 0) {
        throw new Error('Scene7 searchAssets returned an invalid totalRows');
      }
    }
    for (const asset of assets) results.set(asset.assetHandle, asset);
    if (totalRows !== null) {
      if (results.size >= totalRows) return [...results.values()];
      if (!assets.length) {
        throw new Error(
          `Scene7 searchAssets for "${name}" returned an empty page ${page} before totalRows ${totalRows}`
        );
      }
    } else if (assets.length < pageSize) {
      return [...results.values()];
    }
  }
  throw new Error(`Scene7 searchAssets for "${name}" exceeded ${maxPages} pages`);
}

async function getAssets(config, handles) {
  const items = handles.map((handle) => `<ips:items>${escapeXml(handle)}</ips:items>`).join('');
  const body = await call(
    config,
    'getAssets',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:assetHandleArray>${items}</ips:assetHandleArray>`
  );
  return parseAssetArray(body);
}

async function getAssetDetails(config, asset) {
  const details = await getAssets(config, [asset.assetHandle]);
  const detail = details.find((item) => item.assetHandle === asset.assetHandle);
  if (!detail) throw new Error(`Scene7 getAssets returned no details for ${asset.assetHandle}`);
  return detail;
}

function imageNameFromAssetPath(assetPath) {
  const name = path.posix.parse(String(assetPath || '')).name;
  if (!name) throw new Error('Scene7 image name could not be derived from the asset path');
  return name;
}

async function findImage(config, imageName) {
  const found = await searchAssetsByName(config, imageName, {
    folder: config.sourceImageFolderPath,
  });
  const details = await Promise.all(found.map((asset) => getAssetDetails(config, asset)));
  const images = details.filter((asset) => {
    const type = `${asset.type} ${asset.subType}`.toLowerCase();
    return !asset.hasSetDefinition && !type.includes('set') &&
      (!asset.name || asset.name === imageName) &&
      (type.includes('image') || /^a\|/.test(asset.assetHandle));
  });
  if (images.length !== 1) {
    throw new Error(
      images.length
        ? `Scene7 image name "${imageName}" is ambiguous`
        : `Scene7 image "${imageName}" was not found`
    );
  }
  return images[0];
}

async function findSet(config, setName, options) {
  const found = (await searchAssetsByName(config, setName, options))
    .filter((asset) => asset.name === setName);
  const details = await Promise.all(found.map((asset) => getAssetDetails(config, asset)));
  const sets = details.filter((asset) => {
    const type = `${asset.type} ${asset.subType}`.toLowerCase();
    return (type.includes('set') || asset.hasSetDefinition) && asset.name === setName;
  });
  if (sets.length > 1) throw new Error(`Scene7 set name "${setName}" is ambiguous`);
  if (sets.length) return sets[0];
  if (details.length) throw new Error(`Scene7 name "${setName}" exists but is not an asset set`);
  return null;
}

function imageMemberDefinition(assetHandle) {
  if (typeof assetHandle !== 'string' || !assetHandle.startsWith('a|')) {
    throw new Error('Scene7 Mixed Media Set v1 requires an image asset handle beginning with a|');
  }
  return `\${getCatalogId([${assetHandle}])};\${getCatalogId([${assetHandle}])};advanced_image;`;
}

function appendMember(setDefinition, member) {
  const members = (setDefinition || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  if (members.includes(member)) return { setDefinition: setDefinition || '', changed: false };
  return { setDefinition: [...members, member].join(','), changed: true };
}

const GET_FOLDERS_LIMIT = 100000;

function normalizeFolderPath(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath) {
    throw new Error('Scene7 folder path is not configured');
  }
  const segments = folderPath.split('/').slice(0, -1);
  const invalid = folderPath !== folderPath.trim() || folderPath.startsWith('/') ||
    !folderPath.endsWith('/') || segments.some((s) => !s || s === '.' || s === '..');
  if (invalid) {
    throw new Error('Scene7 set folder path must look like "Company/folder/" (relative, trailing slash)');
  }
  return folderPath;
}

function parseFolderArray(xml) {
  const array = descendants(parseXml(xml), 'folderArray')[0];
  if (!array) return [];
  return array.children
    .filter((child) => child.name === 'items')
    .map((item) => ({ folderHandle: firstText(item, ['folderHandle']), path: firstText(item, ['path']) }));
}

async function getFolders(config, folderPath) {
  const pathXml = folderPath
    ? `<ips:folderPath>${escapeXml(normalizeFolderPath(folderPath))}</ips:folderPath>`
    : '';
  const body = await call(
    config,
    'getFolders',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>${pathXml}`
  );
  return parseFolderArray(body);
}

async function resolveFolderHandle(config, folderPath) {
  const target = normalizeFolderPath(folderPath);
  const parent = target.slice(0, target.slice(0, -1).lastIndexOf('/') + 1);
  const folders = await getFolders(config, parent);
  const matches = folders.filter((folder) =>
    folder.path === target || folder.path.endsWith(`/${target}`)
  );
  if (matches.length > 1) throw new Error(`Scene7 folder "${target}" is ambiguous`);
  if (!matches.length && folders.length >= GET_FOLDERS_LIMIT) {
    throw new Error(`Scene7 getFolders hit its ${GET_FOLDERS_LIMIT}-folder limit before "${target}"`);
  }
  if (!matches.length) throw new Error(`Scene7 folder "${target}" was not found`);
  if (!matches[0].folderHandle) throw new Error(`Scene7 folder "${target}" has no folderHandle`);
  return matches[0].folderHandle;
}

async function createFolder(config, folderPath) {
  const target = normalizeFolderPath(folderPath);
  const apiPath = `/${target.slice(0, -1)}`;
  const body = await call(
    config,
    'createFolder',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:folderPath>${escapeXml(apiPath)}</ips:folderPath>`
  );
  const folderHandle = firstText(parseXml(body), ['folderHandle']);
  if (!folderHandle) throw new Error(`Scene7 createFolder response did not include folderHandle for "${target}"`);
  return folderHandle;
}

async function createAssetSet(config, folderHandle, name, setDefinition) {
  if (!folderHandle) throw new Error('Scene7 createAssetSet requires a folderHandle');
  const body = await call(
    config,
    'createAssetSet',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:folderHandle>${escapeXml(folderHandle)}</ips:folderHandle>` +
      `<ips:name>${escapeXml(name)}</ips:name>` +
      '<ips:subType>MediaSet</ips:subType>' +
      `<ips:setDefinition>${escapeXml(setDefinition)}</ips:setDefinition>`
  );
  const assetHandle = firstText(parseXml(body), ['assetHandle']);
  if (!assetHandle) throw new Error('Scene7 createAssetSet response did not include assetHandle');
  return assetHandle;
}

async function setAssetSetDefinition(config, handle, setDefinition) {
  return call(
    config,
    'setAssetSetDefinition',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:assetHandle>${escapeXml(handle)}</ips:assetHandle>` +
      `<ips:setDefinition>${escapeXml(setDefinition)}</ips:setDefinition>`
  );
}

async function submitIncrementalPublish(config) {
  const jobName = `fanout-mixed-media-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const body = await call(
    config,
    'submitJob',
    `<ips:companyHandle>${escapeXml(config.companyHandle)}</ips:companyHandle>` +
      `<ips:jobName>${escapeXml(jobName)}</ips:jobName>` +
      '<ips:imageServingPublishJob>' +
      '<ips:publishType>Incremental</ips:publishType>' +
      '<ips:emailSetting>None</ips:emailSetting>' +
      '</ips:imageServingPublishJob>'
  );
  const jobHandle = firstText(parseXml(body), ['jobHandle']);
  if (!jobHandle) throw new Error('Scene7 submitJob response did not include jobHandle');
  return jobHandle;
}

async function ensureSetMember(config, setName, member, markPublishPending, getFolderHandle) {
  const existing = await findSet(config, setName, {
    folder: config.setSearchFolderPath,
  });
  if (!existing) {
    if (typeof getFolderHandle !== 'function') throw new Error('Scene7 set folder resolver is required');
    const folderHandle = await getFolderHandle();
    await markPublishPending();
    const assetSetHandle = await createAssetSet(config, folderHandle, setName, member);
    return { status: 'created', assetSetHandle };
  }
  if (!existing.hasSetDefinition) {
    throw new Error(`Scene7 getAssets returned no setDefinition for "${setName}"`);
  }
  const next = appendMember(existing.setDefinition, member);
  if (!next.changed) return { status: 'unchanged', assetSetHandle: existing.assetHandle };
  await markPublishPending();
  await setAssetSetDefinition(config, existing.assetHandle, next.setDefinition);
  return { status: 'updated', assetSetHandle: existing.assetHandle };
}

async function publishIfPending(config, store, pendingKey) {
  if (!(await store.get(pendingKey))) return { published: false, jobHandle: null };
  let jobHandle;
  try {
    jobHandle = await submitIncrementalPublish(config);
  } catch (error) {
    if (
      error.code !== PUBLISH_ALREADY_RUNNING_CODE ||
      !String(error.message || '').includes(PUBLISH_ALREADY_RUNNING_REASON)
    ) {
      throw error;
    }
    await store.delete(pendingKey);
    return { published: true, jobHandle: null, alreadyRunning: true };
  }
  await store.delete(pendingKey);
  return { published: true, jobHandle: jobHandle || null };
}

module.exports = {
  getAssetsByName,
  searchAssetsByName,
  getAssets,
  imageNameFromAssetPath,
  normalizeFolderPath,
  getFolders,
  resolveFolderHandle,
  createFolder,
  findImage,
  findSet,
  imageMemberDefinition,
  appendMember,
  ensureSetMember,
  publishIfPending,
};
