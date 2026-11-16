import { createHash } from "node:crypto";
import { ContractError } from "./errors.mjs";
import { RELEASE_METADATA_ASSET, RELEASE_METADATA_SCHEMA, REPOSITORY, SYSTEM_SKILL_IDS, WORKFLOW_IDS } from "./constants.mjs";
import { channelFor, parseReleaseTag } from "./semver.mjs";
import { buildSkillsBundle } from "./validators/system-skills.mjs";
import { loadSource } from "./source.mjs";

export function createReleaseArtifacts(source, tag, sourceCommit) {
  const parsed = parseReleaseTag(tag, WORKFLOW_IDS);
  if (!parsed) throw new ContractError("INVALID_RELEASE_TAG", `Tag ${tag} does not identify an approved Workflow or System Skills version.`);
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new ContractError("SOURCE_COMMIT_INVALID", "Release source identity must be a full Git commit SHA.");
  let payloadName;
  let payloadBytes;
  if (parsed.kind === "workflow") {
    const workflow = source.workflows.find((item) => item.id === parsed.id);
    if (!workflow || workflow.version !== parsed.version) throw new ContractError("RELEASE_SOURCE_VERSION_MISMATCH", `${tag} does not match the Workflow source version.`);
    payloadName = `workflow-${parsed.id}-${parsed.version}.json`;
    payloadBytes = source.workflowFiles.get(parsed.id);
  } else {
    if (source.skillsManifest.version !== parsed.version) throw new ContractError("RELEASE_SOURCE_VERSION_MISMATCH", `${tag} does not match the System Skills bundle version.`);
    payloadName = `system-skills-${parsed.version}.json`;
    payloadBytes = Buffer.from(`${JSON.stringify(buildSkillsBundle(source.skillsManifest, source.skillFiles), null, 2)}\n`, "utf8");
  }
  if (!Buffer.isBuffer(payloadBytes) || payloadBytes.length === 0) throw new ContractError("RELEASE_ASSET_EMPTY", `${tag} payload asset is empty.`);
  const payload = {
    name: payloadName,
    bytes: payloadBytes,
    size: payloadBytes.byteLength,
    sha256: sha256(payloadBytes),
    url: releaseAssetUrl(tag, payloadName),
  };
  const metadata = {
    schemaVersion: RELEASE_METADATA_SCHEMA,
    kind: parsed.kind,
    id: parsed.id,
    version: parsed.version,
    channel: channelFor(parsed.version),
    tag,
    sourceCommit,
    asset: { name: payload.name, url: payload.url, size: payload.size, sha256: payload.sha256 },
  };
  const metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  const metadataAsset = {
    name: RELEASE_METADATA_ASSET,
    bytes: metadataBytes,
    size: metadataBytes.byteLength,
    sha256: sha256(metadataBytes),
    url: releaseAssetUrl(tag, RELEASE_METADATA_ASSET),
  };
  return { ...parsed, sourceCommit, payload, metadata, metadataAsset, assets: [payload, metadataAsset] };
}

export async function loadSourceAtCommit(repositoryRoot, commit, readGitFile) {
  const reader = async (relativePath) => readGitFile(commit, relativePath);
  const workflows = [];
  const workflowFiles = new Map();
  for (const id of WORKFLOW_IDS) {
    const bytes = await reader(`workflows/${id}.json`);
    const workflow = JSON.parse(bytes.toString("utf8"));
    workflows.push(workflow);
    workflowFiles.set(id, bytes);
  }
  const skillsManifestBytes = await reader("system-skills/manifest.json");
  const skillsManifest = JSON.parse(skillsManifestBytes.toString("utf8"));
  const skillFiles = Object.fromEntries(await Promise.all(SYSTEM_SKILL_IDS.map(async (id) => [id, await reader(`system-skills/${id}/SKILL.md`)])));
  const sourceManifest = JSON.parse((await reader("source.json")).toString("utf8"));
  const baseline = JSON.parse((await reader("source-baseline.json")).toString("utf8"));
  const workflowManifest = JSON.parse((await reader("workflows/manifest.json")).toString("utf8"));
  const loaded = { root: repositoryRoot, workflows, workflowFiles, skillsManifest, skillManifestBytes: skillsManifestBytes, skillFiles, sourceManifest, baseline, workflowManifest };
  const { validateSourceManifests } = await import("./source.mjs");
  const { validateWorkflow } = await import("./validators/workflow.mjs");
  const { validateSkillsManifest } = await import("./validators/system-skills.mjs");
  for (const workflow of workflows) validateWorkflow(workflow, workflow.id);
  validateSkillsManifest(skillsManifest, skillFiles);
  validateSourceManifests({ sourceManifest, baseline, workflowManifest, workflows, workflowFiles, skillFiles, skillsManifest });
  return loaded;
}

export function validateReleaseMetadata(value, expected) {
  if (!isRecord(value) || value.schemaVersion !== RELEASE_METADATA_SCHEMA) throw new ContractError("RELEASE_METADATA_INVALID", "Release metadata schema is invalid.");
  const expectedKeys = ["schemaVersion", "kind", "id", "version", "channel", "tag", "sourceCommit", "asset"];
  exactKeys(value, expectedKeys, "Release metadata");
  if (value.kind !== expected.kind || value.id !== expected.id || value.version !== expected.version || value.channel !== expected.channel
    || value.tag !== expected.tag || value.sourceCommit !== expected.sourceCommit) {
    throw new ContractError("RELEASE_METADATA_CONFLICT", `Release metadata identity conflicts for ${expected.tag}.`);
  }
  if (!isRecord(value.asset) || value.asset.name !== expected.payload.name || value.asset.url !== expected.payload.url
    || value.asset.size !== expected.payload.size || value.asset.sha256 !== expected.payload.sha256) {
    throw new ContractError("RELEASE_METADATA_ASSET_CONFLICT", `Release metadata asset identity conflicts for ${expected.tag}.`);
  }
  return value;
}

export function catalogEntryFromRelease(artifacts, assetBytesByName) {
  const metadataBytes = assetBytesByName.get(RELEASE_METADATA_ASSET);
  if (!Buffer.isBuffer(metadataBytes)) throw new ContractError("RELEASE_METADATA_ASSET_MISSING", `${artifacts.tag} is missing its metadata asset.`);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  validateReleaseMetadata(metadata, artifacts);
  const assets = artifacts.assets.map((asset) => {
    const bytes = assetBytesByName.get(asset.name);
    if (!Buffer.isBuffer(bytes) || !bytes.equals(asset.bytes)) throw new ContractError("RELEASE_ASSET_CONFLICT", `${artifacts.tag}/${asset.name} does not match its immutable expected bytes.`);
    return { name: asset.name, url: asset.url, size: bytes.byteLength, sha256: sha256(bytes) };
  });
  return {
    kind: artifacts.kind,
    id: artifacts.id,
    version: artifacts.version,
    channel: artifacts.channel,
    tag: artifacts.tag,
    sourceCommit: artifacts.sourceCommit,
    assets,
  };
}

export function releasePresentation(artifacts) {
  const title = artifacts.kind === "workflow"
    ? `Default Workflow ${artifacts.id} ${artifacts.version}`
    : `System Skills ${artifacts.version}`;
  const body = [
    "Automated immutable Default Workflow source release.",
    "",
    `- Channel: ${artifacts.channel}`,
    `- Source commit: ${artifacts.sourceCommit}`,
    `- Asset: ${artifacts.payload.name}`,
    `- Size: ${artifacts.payload.size} bytes`,
    `- SHA-256: ${artifacts.payload.sha256}`,
  ].join("\n");
  return { title, body, prerelease: artifacts.channel === "dev" };
}

export function releaseAssetUrl(tag, name) {
  return `https://github.com/${REPOSITORY}/releases/download/${tag}/${name}`;
}

export async function createArtifactsFromRoot(root, tag, sourceCommit) {
  const source = await loadSource(root);
  return createReleaseArtifacts(source, tag, sourceCommit);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ContractError("RELEASE_METADATA_UNKNOWN_FIELD", `${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
