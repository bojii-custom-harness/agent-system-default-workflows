import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ContractError } from "./errors.mjs";
import { CONTENT_VERSION, SOURCE_BASELINE_CANONICAL_SHA256, SOURCE_BASELINE_SCHEMA, SOURCE_MANIFEST_SCHEMA, SYSTEM_SKILL_IDS, WORKFLOW_IDS, WORKFLOW_MANIFEST_SCHEMA } from "./constants.mjs";
import { parseSemVer } from "./semver.mjs";
import { restoreSourceSkillVersion, validateSkillsManifest } from "./validators/system-skills.mjs";
import { validateWorkflow } from "./validators/workflow.mjs";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function canonicalHash(value) {
  return sha256(Buffer.from(JSON.stringify(canonical(value)), "utf8"));
}

async function jsonFile(path) {
  const bytes = await readFile(path);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new ContractError("SOURCE_JSON_INVALID", `${path} must contain valid UTF-8 JSON.`);
  }
}

export async function loadSource(rootPath) {
  const root = resolve(rootPath);
  const workflowDirectory = join(root, "workflows");
  const workflowFileNames = (await readdir(workflowDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "manifest.json")
    .map((entry) => entry.name)
    .sort();
  const expectedFiles = [...WORKFLOW_IDS].map((id) => `${id}.json`).sort();
  if (JSON.stringify(workflowFileNames) !== JSON.stringify(expectedFiles)) {
    throw new ContractError("WORKFLOW_INVENTORY_INVALID", "Source must contain exactly the 11 approved Workflow JSON files.");
  }
  const workflowFiles = new Map();
  const workflows = [];
  const uuids = new Set();
  for (const id of WORKFLOW_IDS) {
    const { bytes, value } = await jsonFile(join(workflowDirectory, `${id}.json`));
    validateWorkflow(value, id);
    if (value.version !== CONTENT_VERSION) throw new ContractError("WORKFLOW_CONTENT_VERSION_INVALID", `${id} must use approved content version ${CONTENT_VERSION}.`);
    if (uuids.has(value.uuid)) throw new ContractError("WORKFLOW_UUID_DUPLICATE", `${id} duplicates another Workflow UUID.`);
    uuids.add(value.uuid);
    workflowFiles.set(id, bytes);
    workflows.push(value);
  }

  const systemSkillsRoot = join(root, "system-skills");
  const skillDirectoryNames = (await readdir(systemSkillsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(skillDirectoryNames) !== JSON.stringify([...SYSTEM_SKILL_IDS].sort())) {
    throw new ContractError("SYSTEM_SKILL_INVENTORY_INVALID", "Source must contain exactly the three approved product System Skill directories.");
  }
  const skillFiles = {};
  for (const id of SYSTEM_SKILL_IDS) skillFiles[id] = await readFile(join(systemSkillsRoot, id, "SKILL.md"));
  const { bytes: skillManifestBytes, value: skillsManifest } = await jsonFile(join(systemSkillsRoot, "manifest.json"));
  validateSkillsManifest(skillsManifest, skillFiles);

  const { value: sourceManifest } = await jsonFile(join(root, "source.json"));
  const { value: baseline } = await jsonFile(join(root, "source-baseline.json"));
  const { value: workflowManifest } = await jsonFile(join(workflowDirectory, "manifest.json"));
  validateSourceManifests({ sourceManifest, baseline, workflowManifest, workflows, workflowFiles, skillFiles, skillsManifest, skillManifestBytes });

  return { root, workflows, workflowFiles, skillsManifest, skillManifestBytes, skillFiles, sourceManifest, baseline, workflowManifest };
}

export function validateSourceManifests({ sourceManifest, baseline, workflowManifest, workflows, workflowFiles, skillFiles, skillsManifest }) {
  if (!isRecord(sourceManifest)) throw new ContractError("SOURCE_MANIFEST_INVALID", "Source manifest must be a JSON object.");
  exactKeys(sourceManifest, ["schemaVersion", "sourceRepository", "sourceCommit", "workflowCount", "systemSkillIds", "workflowGeneratorSourceVersion", "systemSkillsSourceVersion", "contentVersion"], "Source manifest");
  if (sourceManifest.schemaVersion !== SOURCE_MANIFEST_SCHEMA
    || sourceManifest.sourceCommit !== "7f5c7a56bce02501547e2933bbefd7f4a745f0b9"
    || sourceManifest.workflowCount !== WORKFLOW_IDS.length
    || sourceManifest.contentVersion !== CONTENT_VERSION
    || sourceManifest.workflowGeneratorSourceVersion !== "0.0.30"
    || sourceManifest.systemSkillsSourceVersion !== "1.0.9"
    || JSON.stringify(sourceManifest.systemSkillIds) !== JSON.stringify(SYSTEM_SKILL_IDS)) {
    throw new ContractError("SOURCE_MANIFEST_INVALID", "Source manifest does not match the approved baseline and inventory.");
  }
  if (!isRecord(baseline)) throw new ContractError("SOURCE_BASELINE_INVALID", "Pinned source baseline must be a JSON object.");
  exactKeys(baseline, ["schemaVersion", "sourceCommit", "workflows", "skills", "legacyUpgradesFrom"], "Source baseline");
  if (canonicalHash(baseline) !== SOURCE_BASELINE_CANONICAL_SHA256) {
    throw new ContractError("SOURCE_BASELINE_FINGERPRINT_INVALID", "Pinned source baseline fingerprints or historical mappings were changed.");
  }
  if (baseline.schemaVersion !== SOURCE_BASELINE_SCHEMA || baseline.sourceCommit !== sourceManifest.sourceCommit
    || !Array.isArray(baseline.workflows) || !Array.isArray(baseline.skills) || !isRecord(baseline.legacyUpgradesFrom)) {
    throw new ContractError("SOURCE_BASELINE_INVALID", "Pinned source baseline inventory is malformed.");
  }
  if (!isRecord(workflowManifest)) throw new ContractError("WORKFLOW_MANIFEST_INVALID", "Workflow manifest must be a JSON object.");
  exactKeys(workflowManifest, ["schemaVersion", "sourceCommit", "workflowGeneratorSourceVersion", "systemSkillsSourceVersion", "workflows"], "Workflow manifest");
  if (workflowManifest.schemaVersion !== WORKFLOW_MANIFEST_SCHEMA
    || workflowManifest.sourceCommit !== sourceManifest.sourceCommit
    || workflowManifest.workflowGeneratorSourceVersion !== "0.0.30"
    || workflowManifest.systemSkillsSourceVersion !== "1.0.9"
    || !Array.isArray(workflowManifest.workflows) || workflowManifest.workflows.length !== WORKFLOW_IDS.length
    || workflowManifest.workflows.some((entry) => !isRecord(entry))) {
    throw new ContractError("WORKFLOW_MANIFEST_INVALID", "Workflow manifest does not match the approved baseline identity.");
  }
  const baselineById = new Map(baseline.workflows.map((entry) => [entry.id, entry]));
  const manifestById = new Map(workflowManifest.workflows.map((entry) => [entry.id, entry]));
  for (const entry of baseline.workflows) exactKeys(entry, ["id", "uuid", "sourceVersion", "canonicalSha256"], "Baseline Workflow entry");
  for (const entry of workflowManifest.workflows) exactKeys(entry, ["id", "uuid", "version", "sourceVersion", "file", "sha256"], "Workflow manifest entry");
  for (const workflow of workflows) {
    const base = baselineById.get(workflow.id);
    const item = manifestById.get(workflow.id);
    const bytes = workflowFiles.get(workflow.id);
    if (!base || !item || base.uuid !== workflow.uuid || item.uuid !== workflow.uuid || item.version !== CONTENT_VERSION
      || item.sourceVersion !== base.sourceVersion || item.file !== `workflows/${workflow.id}.json`
      || item.sha256 !== sha256(bytes) || !HEX_SHA256.test(base.canonicalSha256)
      || canonicalHash({ ...workflow, version: base.sourceVersion }) !== base.canonicalSha256) {
      throw new ContractError("WORKFLOW_SOURCE_DRIFT", `${workflow.id} differs from the pinned baseline beyond its approved version reset.`);
    }
  }
  if (baseline.workflows.length !== WORKFLOW_IDS.length || baseline.skills.length !== SYSTEM_SKILL_IDS.length) {
    throw new ContractError("SOURCE_BASELINE_INVENTORY_INVALID", "Pinned source baseline must identify all 11 Workflows and three Skills.");
  }

  const baselineSkills = new Map(baseline.skills.map((entry) => [entry.id, entry]));
  for (const entry of baseline.skills) exactKeys(entry, ["id", "sourceVersion", "sha256"], "Baseline Skill entry");
  if (skillsManifest.sourceVersion !== "1.0.9" || skillsManifest.sourceCommit !== sourceManifest.sourceCommit) {
    throw new ContractError("SYSTEM_SKILL_SOURCE_IDENTITY_INVALID", "System Skills manifest source version and commit must match the approved baseline.");
  }
  for (const id of SYSTEM_SKILL_IDS) {
    const base = baselineSkills.get(id);
    const bytes = skillFiles[id];
    const restored = Buffer.from(restoreSourceSkillVersion(bytes.toString("utf8"), id, base?.sourceVersion ?? ""), "utf8");
    if (!base || !HEX_SHA256.test(base.sha256) || sha256(restored) !== base.sha256) {
      throw new ContractError("SYSTEM_SKILL_SOURCE_DRIFT", `${id}/SKILL.md differs from its pinned baseline beyond the approved version marker reset.`);
    }
  }
  const workflowAssemblyHash = baselineSkills.get("workflow-assembly")?.sha256;
  if (baselineSkills.get("plugin-discovery")?.sha256 !== "fd56a9c716e3d18ca7702c147068778622d6f7be6afb98548b0d33466726d5ed"
    || workflowAssemblyHash !== "5c10c5880590f76e416f907bcf14ba73aeff6e3e9fb6852993e6a58f5e92a02c"
    || baselineSkills.get("resource-authoring")?.sha256 !== "525f245a29a8dcdc421a7c51551ee2817c05b901b82d2031493f24a2dd543e97") {
    throw new ContractError("SYSTEM_SKILL_BASELINE_HASH_INVALID", "Current 1.0.9 Skill hashes do not match AC02.");
  }
  if (JSON.stringify(skillsManifest.upgradesFrom["1.0.7"]) !== JSON.stringify(baseline.legacyUpgradesFrom["1.0.7"])
    || JSON.stringify(skillsManifest.upgradesFrom["1.0.6"]) !== JSON.stringify(baseline.legacyUpgradesFrom["1.0.6"])) {
    throw new ContractError("SYSTEM_SKILL_HISTORY_DROPPED", "Existing historical upgrade mappings were changed or removed.");
  }
  for (const version of Object.keys(baseline.legacyUpgradesFrom)) {
    if (version === "1.0.8") {
      if (skillsManifest.upgradesFrom[version]?.["workflow-assembly"]?.["SKILL.md"]
        !== baseline.legacyUpgradesFrom[version]?.["workflow-assembly"]?.["SKILL.md"]) {
        throw new ContractError("SYSTEM_SKILL_HISTORY_DROPPED", "The existing 1.0.8 workflow-assembly mapping must be preserved exactly.");
      }
      continue;
    }
    if (JSON.stringify(skillsManifest.upgradesFrom[version]) !== JSON.stringify(baseline.legacyUpgradesFrom[version])) {
      throw new ContractError("SYSTEM_SKILL_HISTORY_DROPPED", `Existing upgrade mapping ${version} was changed or removed.`);
    }
  }
  return true;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expectedKeys, label) {
  if (!isRecord(value)) throw new ContractError("SOURCE_MANIFEST_FIELDS_INVALID", `${label} must be a JSON object.`);
  const expected = new Set(expectedKeys);
  const missing = expectedKeys.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !expected.has(key));
  if (missing.length || extra.length) {
    throw new ContractError("SOURCE_MANIFEST_FIELDS_INVALID", `${label} fields must match the published source contract exactly.`);
  }
}
