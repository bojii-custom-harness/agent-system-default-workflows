import { createHash } from "node:crypto";
import { ContractError } from "./errors.mjs";
import {
  CATALOG_SCHEMA,
  REPOSITORY,
  RELEASE_METADATA_SCHEMA,
  SKILLS_BUNDLE_SCHEMA,
  SKILLS_MANIFEST_SCHEMA,
  SYSTEM_SKILL_IDS,
  UPGRADE_HASHES,
  WORKFLOW_IDS,
} from "./constants.mjs";
import { assertSemVer } from "./semver.mjs";
import { validateCatalog } from "./validators/catalog.mjs";

export const DEFAULT_CATALOG_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main/catalog.json`;

const MAX_CATALOG_BYTES = 1_000_000;
const MAX_RELEASE_ASSET_BYTES = 5_000_000;
const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [250, 1_000];
const RETRYABLE_TRANSPORT_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export async function fetchCatalog({
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayImpl = waitBeforeRetry,
} = {}) {
  const bytes = await fetchCheckedBytes(DEFAULT_CATALOG_URL, {
    maxBytes: MAX_CATALOG_BYTES,
    label: "catalog",
  }, { fetchImpl, timeoutMs, retryDelayImpl });
  let catalog;
  try {
    catalog = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContractError("SOURCE_CATALOG_INVALID", "The public Default Workflow catalog is not valid JSON.");
  }
  if (catalog?.schemaVersion !== CATALOG_SCHEMA) {
    throw new ContractError("SOURCE_CATALOG_INVALID", "The public Default Workflow catalog uses an unsupported schema.");
  }
  validateCatalog(catalog);
  return { catalog, bytes, sha256: sha256(bytes) };
}

export async function downloadRelease({
  catalog,
  id,
  version,
  channel,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayImpl = waitBeforeRetry,
} = {}) {
  assertReleaseChannel(channel);
  const isSystemSkills = id === "system-skills";
  if (!isSystemSkills && !WORKFLOW_IDS.includes(id)) {
    throw new ContractError("PRODUCT_ID_INVALID", "The requested Workflow ID is not approved.");
  }
  assertSemVer(version, "download version");
  validateCatalog(catalog);
  const kind = isSystemSkills ? "system-skills" : "workflow";
  const entry = catalog.entries.find((candidate) => (
    candidate.kind === kind && candidate.id === id && candidate.version === version && candidate.channel === channel
  ));
  if (!entry) throw new ContractError("RELEASE_NOT_FOUND", `The exact release ${id} ${channel} ${version} is not present in the catalog.`);

  const productName = kind === "system-skills"
    ? `system-skills-${version}.json`
    : `workflow-${id}-${version}.json`;
  const productAsset = entry.assets.find((asset) => asset.name === productName);
  const metadataAsset = entry.assets.find((asset) => asset.name === "release-metadata.json");
  if (!productAsset || !metadataAsset) {
    throw new ContractError("RELEASE_ASSET_MISSING", `The exact release ${entry.tag} is missing an approved asset.`);
  }
  const transport = { fetchImpl, timeoutMs, retryDelayImpl };
  const [metadataBytes, bytes] = await Promise.all([
    fetchCheckedBytes(metadataAsset.url, {
      expectedSize: metadataAsset.size,
      expectedSha256: metadataAsset.sha256,
      label: `${entry.tag} release metadata`,
    }, transport),
    fetchCheckedBytes(productAsset.url, {
      expectedSize: productAsset.size,
      expectedSha256: productAsset.sha256,
      label: `${entry.tag} release asset`,
    }, transport),
  ]);

  let metadata;
  let product;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new ContractError("RELEASE_METADATA_INVALID", `Release metadata for ${entry.tag} is not valid JSON.`);
  }
  validateReleaseMetadata(metadata, entry, productAsset);
  try {
    product = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ContractError("RELEASE_ASSET_INVALID", `Release asset for ${entry.tag} is not valid JSON.`);
  }
  if (kind === "workflow") validateWorkflowAsset(product, entry);
  else validateSystemSkillsBundle(product, entry);

  return { entry, productAsset, metadataAsset, metadataBytes, metadata, bytes, product };
}

async function fetchCheckedBytes(url, {
  expectedSize,
  expectedSha256,
  maxBytes = MAX_RELEASE_ASSET_BYTES,
  label,
}, { fetchImpl, timeoutMs, retryDelayImpl }) {
  if (typeof fetchImpl !== "function") throw new ContractError("SOURCE_FETCH_UNAVAILABLE", "A Fetch-compatible transport is required.");
  if (!isAllowedGithubReadUrl(url)) throw new ContractError("SOURCE_URL_FORBIDDEN", `${label} URL is outside the approved public GitHub hosts.`);

  const maxAttempts = RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchWithApprovedRedirects(url, fetchImpl, AbortSignal.timeout(timeoutMs));
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (attempt < maxAttempts && isRetryableTransportError(error)) {
        await retryDelayImpl(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw new ContractError("SOURCE_DOWNLOAD_FAILED", `Unable to download ${label}${attemptSuffix(attempt, maxAttempts)}.`);
    }

    if (!response.ok) {
      const status = response.status;
      await cancelResponseBody(response);
      if (attempt < maxAttempts && isRetryableHttpStatus(status)) {
        await retryDelayImpl(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw new ContractError("SOURCE_DOWNLOAD_FAILED", `Unable to download ${label}${attemptSuffix(attempt, maxAttempts)}: HTTP ${status}.`);
    }
    if (response.url && !isAllowedGithubReadUrl(response.url)) {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", `${label} resolved outside the approved GitHub asset hosts.`);
    }

    const declaredLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_ASSET_TOO_LARGE", `${label} exceeds the maximum accepted byte size.`);
    }
    let bytes;
    try {
      bytes = await readBoundedResponse(response, maxBytes);
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (attempt < maxAttempts && isRetryableTransportError(error)) {
        await cancelResponseBody(response);
        await retryDelayImpl(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw new ContractError("SOURCE_DOWNLOAD_FAILED", `Unable to read ${label}${attemptSuffix(attempt, maxAttempts)}.`);
    }
    if (expectedSize !== undefined && bytes.byteLength !== expectedSize) {
      throw new ContractError("SOURCE_SIZE_MISMATCH", `${label} byte size does not match its catalog pin.`);
    }
    if (expectedSha256 && sha256(bytes) !== expectedSha256) {
      throw new ContractError("SOURCE_HASH_MISMATCH", `${label} SHA-256 does not match its catalog pin.`);
    }
    return bytes;
  }
  throw new ContractError("SOURCE_DOWNLOAD_FAILED", `Unable to download ${label}.`);
}

async function fetchWithApprovedRedirects(url, fetchImpl, signal) {
  let currentUrl = url;
  for (let redirectCount = 0; ; redirectCount += 1) {
    if (!isAllowedGithubReadUrl(currentUrl)) {
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source URL is outside the approved GitHub hosts.");
    }
    const response = await fetchImpl(currentUrl, { signal, redirect: "manual" });
    if (!isRedirectStatus(response.status)) {
      if (response.url && !isAllowedGithubReadUrl(response.url)) {
        await cancelResponseBody(response);
        throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source resolved outside the approved GitHub hosts.");
      }
      return response;
    }
    if (redirectCount >= MAX_REDIRECTS) {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source exceeded the approved redirect limit.");
    }
    const location = response.headers.get("location");
    if (!location) {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source returned a redirect without a location.");
    }
    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source returned an invalid redirect.");
    }
    if (!isAllowedGithubReadUrl(nextUrl)) {
      await cancelResponseBody(response);
      throw new ContractError("SOURCE_REDIRECT_FORBIDDEN", "A public source redirected outside the approved GitHub hosts.");
    }
    await cancelResponseBody(response);
    currentUrl = nextUrl;
  }
}

function validateReleaseMetadata(metadata, entry, productAsset) {
  if (!isRecord(metadata)
    || metadata.schemaVersion !== RELEASE_METADATA_SCHEMA
    || metadata.kind !== entry.kind
    || metadata.id !== entry.id
    || metadata.version !== entry.version
    || metadata.channel !== entry.channel
    || metadata.tag !== entry.tag
    || metadata.sourceCommit !== entry.sourceCommit
    || !sameAsset(metadata.asset, productAsset)) {
    throw new ContractError("RELEASE_METADATA_MISMATCH", `Release metadata identity or asset differs from catalog for ${entry.tag}.`);
  }
}

function validateWorkflowAsset(workflow, entry) {
  if (!isRecord(workflow)
    || typeof workflow.schemaVersion !== "string"
    || !workflow.schemaVersion.startsWith("agent-system.workflow.v")
    || workflow.id !== entry.id
    || workflow.version !== entry.version
    || typeof workflow.uuid !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workflow.uuid)) {
    throw new ContractError("RELEASE_WORKFLOW_IDENTITY_MISMATCH", `Release asset is not the exact Workflow identified by ${entry.tag}.`);
  }
}

function validateSystemSkillsBundle(bundle, entry) {
  if (!isRecord(bundle)
    || bundle.schemaVersion !== SKILLS_BUNDLE_SCHEMA
    || bundle.version !== entry.version
    || typeof bundle.sourceVersion !== "string"
    || typeof bundle.sourceCommit !== "string"
    || !/^[0-9a-f]{40}$/.test(bundle.sourceCommit)
    || !isRecord(bundle.manifest)
    || bundle.manifest.schemaVersion !== SKILLS_MANIFEST_SCHEMA
    || bundle.manifest.version !== entry.version
    || bundle.manifest.sourceVersion !== bundle.sourceVersion
    || bundle.manifest.sourceCommit !== bundle.sourceCommit
    || !sameStringArray(bundle.manifest.skills, SYSTEM_SKILL_IDS)
    || !Array.isArray(bundle.skills)
    || bundle.skills.length !== SYSTEM_SKILL_IDS.length) {
    throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills bundle identity or inventory is invalid for ${entry.tag}.`);
  }
  validateUpgradeMappings(bundle.manifest.upgradesFrom, entry.tag);
  const skills = new Map();
  for (const skill of bundle.skills) {
    if (!isRecord(skill)
      || !SYSTEM_SKILL_IDS.includes(skill.id)
      || skill.path !== `${skill.id}/SKILL.md`
      || !Number.isSafeInteger(skill.size)
      || typeof skill.content !== "string"
      || !/^[0-9a-f]{64}$/.test(skill.sha256)
      || skills.has(skill.id)) {
      throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills bundle has an invalid or duplicate record for ${entry.tag}.`);
    }
    const content = Buffer.from(skill.content, "utf8");
    if (!content.byteLength || content.byteLength !== skill.size || sha256(content) !== skill.sha256) {
      throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills content hash or size is invalid for ${skill.id}.`);
    }
    skills.set(skill.id, skill);
  }
  if (SYSTEM_SKILL_IDS.some((id) => !skills.has(id))) {
    throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills bundle is missing an approved skill for ${entry.tag}.`);
  }
}

function validateUpgradeMappings(actual, tag) {
  if (!isRecord(actual)) throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills upgrade mappings are missing for ${tag}.`);
  for (const [version, expectedSkills] of Object.entries(UPGRADE_HASHES)) {
    const mapping = actual[version];
    if (!isRecord(mapping)
      || Object.keys(mapping).length !== SYSTEM_SKILL_IDS.length
      || SYSTEM_SKILL_IDS.some((id) => (
        !isRecord(mapping[id])
        || Object.keys(mapping[id]).length !== 1
        || mapping[id]["SKILL.md"] !== expectedSkills[id]
      ))) {
      throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills upgrade mapping ${version} differs from the approved hashes for ${tag}.`);
    }
  }
  for (const [version, mapping] of Object.entries(actual)) {
    if (!isRecord(mapping)
      || Object.keys(mapping).length !== SYSTEM_SKILL_IDS.length
      || SYSTEM_SKILL_IDS.some((id) => (
        !isRecord(mapping[id])
        || Object.keys(mapping[id]).length !== 1
        || !/^[0-9a-f]{64}$/.test(mapping[id]["SKILL.md"])
      ))) {
      throw new ContractError("RELEASE_SYSTEM_SKILLS_INVALID", `System Skills upgrade mapping ${version} is invalid for ${tag}.`);
    }
  }
}

async function readBoundedResponse(response, maxBytes) {
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new ContractError("SOURCE_ASSET_TOO_LARGE", "Downloaded source exceeds its maximum accepted byte size.");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ContractError("SOURCE_ASSET_TOO_LARGE", "Downloaded source exceeds its maximum accepted byte size.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

async function cancelResponseBody(response) {
  await response?.body?.cancel?.().catch(() => undefined);
}

function isAllowedGithubReadUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && (!url.port || url.port === "443")
      && new Set([
        "github.com",
        "raw.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ]).has(url.hostname);
  } catch {
    return false;
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function isRetryableHttpStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isRetryableTransportError(error) {
  const pending = [error];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || (typeof current !== "object" && typeof current !== "function") || visited.has(current)) continue;
    visited.add(current);
    if (current.name === "AbortError" || current.name === "TimeoutError" || RETRYABLE_TRANSPORT_CODES.has(current.code)) return true;
    if ("cause" in current) pending.push(current.cause);
    if (Array.isArray(current.errors)) pending.push(...current.errors);
  }
  return false;
}

function waitBeforeRetry(delayMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
}

function attemptSuffix(attempt, maximum) {
  return attempt > 1 ? ` after ${attempt}/${maximum} attempts` : "";
}

function sameAsset(value, expected) {
  return isRecord(value)
    && Object.keys(value).length === 4
    && value.name === expected.name
    && value.url === expected.url
    && value.size === expected.size
    && value.sha256 === expected.sha256;
}

function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertReleaseChannel(channel) {
  if (channel !== "stable" && channel !== "dev") {
    throw new ContractError("RELEASE_CHANNEL_INVALID", "Release channel must be explicitly set to stable or dev.");
  }
}
