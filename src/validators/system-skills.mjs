import { createHash } from "node:crypto";
import { ContractError } from "../errors.mjs";
import { SKILLS_MANIFEST_SCHEMA, SYSTEM_SKILL_IDS, UPGRADE_HASHES } from "../constants.mjs";
import { parseSemVer } from "../semver.mjs";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateSkillsManifest(value, skillFiles) {
  if (!isRecord(value) || value.schemaVersion !== SKILLS_MANIFEST_SCHEMA || value.product !== "Agent System") {
    throw new ContractError("SKILLS_MANIFEST_IDENTITY_INVALID", "System Skills manifest schema or product identity is invalid.");
  }
  const expectedKeys = ["schemaVersion", "product", "version", "sourceVersion", "sourceCommit", "skills", "upgradesFrom"];
  exactKeys(value, expectedKeys, "System Skills manifest");
  if (!parseSemVer(value.version) || !parseSemVer(value.sourceVersion) || !COMMIT.test(value.sourceCommit)) {
    throw new ContractError("SKILLS_MANIFEST_VERSION_INVALID", "System Skills versions or source commit are invalid.");
  }
  if (!Array.isArray(value.skills) || value.skills.length !== SYSTEM_SKILL_IDS.length || value.skills.some((id, index) => id !== SYSTEM_SKILL_IDS[index])) {
    throw new ContractError("SKILLS_MANIFEST_INVENTORY_INVALID", "System Skills manifest must list exactly the three approved product Skills in canonical order.");
  }
  if (!isRecord(value.upgradesFrom)) throw new ContractError("SKILLS_UPGRADES_INVALID", "upgradesFrom must be an object keyed by old SemVer versions.");
  for (const [version, mappings] of Object.entries(value.upgradesFrom)) {
    if (!parseSemVer(version) || !isRecord(mappings)) throw new ContractError("SKILLS_UPGRADE_VERSION_INVALID", `Upgrade mapping ${version} is invalid.`);
    for (const [id, files] of Object.entries(mappings)) {
      if (!SYSTEM_SKILL_IDS.includes(id) || !isRecord(files) || Object.keys(files).length !== 1 || !SHA256.test(files["SKILL.md"])) {
        throw new ContractError("SKILLS_UPGRADE_HASH_INVALID", `Upgrade mapping ${version}/${id} must identify one exact SKILL.md SHA-256.`);
      }
    }
  }
  for (const [version, expected] of Object.entries(UPGRADE_HASHES)) {
    const actual = value.upgradesFrom[version];
    if (!isRecord(actual) || SYSTEM_SKILL_IDS.some((id) => actual[id]?.["SKILL.md"] !== expected[id])) {
      throw new ContractError("SKILLS_UPGRADE_MAPPING_MISMATCH", `Upgrade mapping ${version} does not match the approved exact hashes.`);
    }
  }
  if (!isRecord(skillFiles) || SYSTEM_SKILL_IDS.some((id) => !Buffer.isBuffer(skillFiles[id]))) {
    throw new ContractError("SKILLS_FILES_MISSING", "The three approved SKILL.md files are required.");
  }
  for (const id of SYSTEM_SKILL_IDS) {
    const text = skillFiles[id].toString("utf8");
    if (!text.startsWith(`---\nname: ${id}\n`) && !text.startsWith(`---\r\nname: ${id}\r\n`)) {
      throw new ContractError("SKILL_IDENTITY_INVALID", `${id}/SKILL.md frontmatter does not match its directory identity.`);
    }
    if (!hasVersionMarker(text, id, value.version)) throw new ContractError("SKILL_VERSION_MARKER_INVALID", `${id}/SKILL.md must declare bundle version ${value.version} exactly once.`);
  }
  return value;
}

export function buildSkillsBundle(manifest, skillFiles) {
  validateSkillsManifest(manifest, skillFiles);
  return {
    schemaVersion: "agent-system.system-skills-bundle.v1",
    version: manifest.version,
    sourceVersion: manifest.sourceVersion,
    sourceCommit: manifest.sourceCommit,
    manifest,
    skills: SYSTEM_SKILL_IDS.map((id) => ({
      id,
      path: `${id}/SKILL.md`,
      size: skillFiles[id].byteLength,
      sha256: sha256(skillFiles[id]),
      content: skillFiles[id].toString("utf8"),
    })),
  };
}

export function restoreSourceSkillVersion(text, id, currentVersion, sourceVersion) {
  const pattern = id === "plugin-discovery"
    ? new RegExp(`版本為 ${escapeRegExp(currentVersion)} 的 System Skill`, "g")
    : new RegExp(`is version ${escapeRegExp(currentVersion)}\\.`, "g");
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new ContractError("SKILL_VERSION_MARKER_INVALID", `${id}/SKILL.md must have one replaceable version marker.`);
  const match = matches[0][0];
  return text.replace(match, id === "plugin-discovery" ? `版本為 ${sourceVersion} 的 System Skill` : `is version ${sourceVersion}.`);
}

function hasVersionMarker(text, id, version) {
  const pattern = id === "plugin-discovery"
    ? new RegExp(`版本為 ${escapeRegExp(version)} 的 System Skill`, "g")
    : new RegExp(`is version ${escapeRegExp(version)}\\.`, "g");
  return [...text.matchAll(pattern)].length === 1;
}

function exactKeys(value, keys, label) {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ContractError("SKILLS_MANIFEST_UNKNOWN_FIELD", `${label} contains unsupported field(s): ${unexpected.join(", ")}.`);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
