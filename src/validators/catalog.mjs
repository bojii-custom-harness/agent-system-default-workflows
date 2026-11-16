import { ContractError } from "../errors.mjs";
import { CATALOG_SCHEMA, REPOSITORY, SYSTEM_SKILL_IDS, WORKFLOW_IDS } from "../constants.mjs";
import { channelFor, parseReleaseTag } from "../semver.mjs";

export function validateCatalog(value) {
  if (!isRecord(value) || value.schemaVersion !== CATALOG_SCHEMA || !Array.isArray(value.entries)) {
    throw new ContractError("CATALOG_SCHEMA_INVALID", "Catalog must use the approved schema and entries array.");
  }
  exactKeys(value, ["schemaVersion", "entries"], "Catalog");
  const tags = new Set();
  const identities = new Set();
  for (const [index, entry] of value.entries.entries()) {
    const path = `catalog.entries[${index}]`;
    if (!isRecord(entry)) throw new ContractError("CATALOG_ENTRY_INVALID", `${path} must be an object.`);
    exactKeys(entry, ["kind", "id", "version", "channel", "tag", "sourceCommit", "assets"], path);
    const parsed = parseReleaseTag(entry.tag, WORKFLOW_IDS);
    if (!parsed || entry.kind !== parsed.kind || entry.id !== parsed.id || entry.version !== parsed.version || entry.channel !== parsed.channel) {
      throw new ContractError("CATALOG_IDENTITY_INVALID", `${path} kind, ID, version, channel and tag must agree exactly.`);
    }
    if (entry.kind === "system-skills" && entry.id !== "system-skills") throw new ContractError("CATALOG_ID_INVALID", `${path} System Skills ID is invalid.`);
    if (entry.kind === "workflow" && !WORKFLOW_IDS.includes(entry.id)) throw new ContractError("CATALOG_ID_INVALID", `${path} Workflow ID is not approved.`);
    if (!/^[0-9a-f]{40}$/.test(entry.sourceCommit)) throw new ContractError("CATALOG_SOURCE_COMMIT_INVALID", `${path} sourceCommit must be a full Git commit SHA.`);
    if (!Array.isArray(entry.assets) || entry.assets.length !== 2) throw new ContractError("CATALOG_ASSETS_INVALID", `${path} must include exactly the payload and release metadata assets.`);
    const assetNames = new Set();
    for (const asset of entry.assets) {
      if (!isRecord(asset)) throw new ContractError("CATALOG_ASSET_INVALID", `${path} contains a malformed asset.`);
      exactKeys(asset, ["name", "url", "size", "sha256"], `${path} asset`);
      if (typeof asset.name !== "string" || !asset.name || assetNames.has(asset.name)) throw new ContractError("CATALOG_ASSET_NAME_INVALID", `${path} asset names must be unique non-empty strings.`);
      if (!Number.isSafeInteger(asset.size) || asset.size < 1 || !/^[0-9a-f]{64}$/.test(asset.sha256)) throw new ContractError("CATALOG_ASSET_HASH_INVALID", `${path} asset size and SHA-256 are invalid.`);
      const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${entry.tag}/${asset.name}`;
      if (asset.url !== expectedUrl) throw new ContractError("CATALOG_ASSET_URL_INVALID", `${path} asset URL must identify the exact public Release asset.`);
      assetNames.add(asset.name);
    }
    if (!assetNames.has("release-metadata.json")) throw new ContractError("CATALOG_METADATA_MISSING", `${path} must include release-metadata.json.`);
    const payloadName = entry.kind === "workflow" ? `workflow-${entry.id}-${entry.version}.json` : `system-skills-${entry.version}.json`;
    if (!assetNames.has(payloadName)) throw new ContractError("CATALOG_PAYLOAD_MISSING", `${path} must include its exact payload asset ${payloadName}.`);
    if (entry.channel !== channelFor(entry.version)) throw new ContractError("CATALOG_CHANNEL_INVALID", `${path} channel does not match SemVer prerelease status.`);
    if (tags.has(entry.tag)) throw new ContractError("CATALOG_DUPLICATE_TAG", `${path} duplicates tag ${entry.tag}.`);
    tags.add(entry.tag);
    const identity = `${entry.kind}\0${entry.id}\0${entry.version}`;
    if (identities.has(identity)) throw new ContractError("CATALOG_DUPLICATE_RELEASE", `${path} duplicates a release identity.`);
    identities.add(identity);
  }
  for (const entry of value.entries) {
    if (entry.kind === "system-skills" && !SYSTEM_SKILL_IDS.length) throw new ContractError("CATALOG_SKILLS_INVALID", "System Skills inventory is unavailable.");
  }
  return value;
}

export function catalogBytes(value) {
  validateCatalog(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sortCatalogEntries(entries, compareSemVer) {
  return [...entries].sort((left, right) => left.kind.localeCompare(right.kind)
    || left.id.localeCompare(right.id)
    || compareSemVer(left.version, right.version)
    || left.tag.localeCompare(right.tag));
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ContractError("CATALOG_UNKNOWN_FIELD", `${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
