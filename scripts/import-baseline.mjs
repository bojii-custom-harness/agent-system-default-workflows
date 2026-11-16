#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APPROVED_COMMIT = "7f5c7a56bce02501547e2933bbefd7f4a745f0b9";
const IDS = [
  "workflow-agent-writer",
  "workflow-command-writer",
  "workflow-file-preview-editor",
  "workflow-generator",
  "workflow-node-prompt-writer",
  "workflow-plugin-finder",
  "workflow-skill-creator",
  "workflow-skill-finder",
  "workflow-skill-writer",
  "workflow-tool-writer",
  "workflow-updater",
];
const SKILLS = ["plugin-discovery", "workflow-assembly", "resource-authoring"];
const SOURCE_SKILL_VERSIONS = {
  "plugin-discovery": "1.0.7",
  "workflow-assembly": "1.0.9",
  "resource-authoring": "1.0.8",
};
const UPGRADE_HASHES = {
  "1.0.8": {
    "plugin-discovery": "fd56a9c716e3d18ca7702c147068778622d6f7be6afb98548b0d33466726d5ed",
    "workflow-assembly": "38aeae53d9b4ba116c32c0a7572ca7c544cc6876a216ca462af6a78753b86d2c",
    "resource-authoring": "525f245a29a8dcdc421a7c51551ee2817c05b901b82d2031493f24a2dd543e97",
  },
  "1.0.9": {
    "plugin-discovery": "fd56a9c716e3d18ca7702c147068778622d6f7be6afb98548b0d33466726d5ed",
    "workflow-assembly": "5c10c5880590f76e416f907bcf14ba73aeff6e3e9fb6852993e6a58f5e92a02c",
    "resource-authoring": "525f245a29a8dcdc421a7c51551ee2817c05b901b82d2031493f24a2dd543e97",
  },
};

function fail(message) {
  throw new Error(message);
}

function runGit(repository, args) {
  try {
    return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, windowsHide: true }).trim();
  } catch (error) {
    const code = Number.isInteger(error?.status) ? ` (exit ${error.status})` : "";
    fail(`Git baseline command failed${code}; source import stopped.`);
  }
}

function readGitBlob(repository, commit, path) {
  try {
    return execFileSync("git", ["-C", repository, "show", `${commit}:${path}`], { encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, windowsHide: true });
  } catch {
    fail(`Approved baseline is missing ${path}.`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sourceSkillVersion(text, id) {
  const markers = id === "plugin-discovery"
    ? [/版本為 ([0-9]+\.[0-9]+\.[0-9]+) 的 System Skill/g]
    : [/is version ([0-9]+\.[0-9]+\.[0-9]+)\./g];
  const matches = markers.flatMap((pattern) => [...text.matchAll(pattern)]);
  if (matches.length !== 1 || matches[0][1] !== SOURCE_SKILL_VERSIONS[id]) {
    fail(`${id}/SKILL.md does not have the approved source version marker.`);
  }
  return matches[0][0];
}

async function main() {
  const args = process.argv.slice(2);
  const repositoryFlag = args.indexOf("--repository");
  const commitFlag = args.indexOf("--commit");
  if (repositoryFlag < 0 || commitFlag < 0 || !args[repositoryFlag + 1] || !args[commitFlag + 1]) {
    fail("Usage: node scripts/import-baseline.mjs --repository <Agent-System-repo> --commit 7f5c7a56bce02501547e2933bbefd7f4a745f0b9");
  }
  const repository = resolve(args[repositoryFlag + 1]);
  const commit = args[commitFlag + 1];
  if (commit !== APPROVED_COMMIT) fail(`Only approved source baseline ${APPROVED_COMMIT} may be imported.`);
  if (args.length !== 4 || args[0] !== "--repository" || args[2] !== "--commit") {
    fail("Usage: node scripts/import-baseline.mjs --repository <Agent-System-repo> --commit 7f5c7a56bce02501547e2933bbefd7f4a745f0b9");
  }
  if (runGit(repository, ["rev-parse", "--show-toplevel"]) === runGit(ROOT, ["rev-parse", "--show-toplevel"])) {
    fail("The source repo must be an independent Git working directory.");
  }
  if (runGit(repository, ["rev-parse", `${commit}^{commit}`]) !== commit) fail("The approved baseline commit is unavailable or does not resolve exactly.");
  const existing = await Promise.all(["workflows", "system-skills", "source.json", "source-baseline.json"].map(async (path) => {
    try { await readFile(join(ROOT, path)); return path; } catch { return undefined; }
  }));
  if (existing.some(Boolean)) fail("Source import destination is not empty; no files were changed.");

  const originalManifestBytes = readGitBlob(repository, commit, "opencode-server/system-skills/manifest.json");
  const originalManifest = JSON.parse(originalManifestBytes.toString("utf8"));
  if (originalManifest.product !== "Agent System" || originalManifest.version !== "1.0.9") fail("System Skills baseline identity is not the approved 1.0.9 bundle.");
  if (JSON.stringify(originalManifest.skills) !== JSON.stringify(SKILLS)) fail("System Skills baseline inventory does not match the approved three product Skills.");

  const workflowEntries = [];
  const workflowBaseline = [];
  for (const id of IDS) {
    const sourcePath = `backend/src/features/workflows/default-workflows/${id}.json`;
    const sourceBytes = readGitBlob(repository, commit, sourcePath);
    const workflow = JSON.parse(sourceBytes.toString("utf8"));
    if (workflow.id !== id || typeof workflow.version !== "string" || typeof workflow.uuid !== "string") fail(`${sourcePath} has an invalid source identity.`);
    const sourceVersion = workflow.version;
    workflow.version = "2.0.0";
    const file = `workflows/${id}.json`;
    const output = jsonBytes(workflow);
    await mkdir(join(ROOT, "workflows"), { recursive: true });
    await writeFile(join(ROOT, file), output, { flag: "wx" });
    workflowEntries.push({ id, uuid: workflow.uuid, version: "2.0.0", sourceVersion, file, sha256: sha256(output) });
    workflowBaseline.push({ id, uuid: workflow.uuid, sourceVersion, canonicalSha256: sha256(Buffer.from(JSON.stringify(canonical({ ...workflow, version: sourceVersion })), "utf8")) });
  }

  const skillBaseline = [];
  for (const id of SKILLS) {
    const sourcePath = `opencode-server/system-skills/${id}/SKILL.md`;
    const sourceBytes = readGitBlob(repository, commit, sourcePath);
    const sourceText = sourceBytes.toString("utf8");
    const marker = sourceSkillVersion(sourceText, id);
    const currentText = sourceText.replace(marker, marker.replace(SOURCE_SKILL_VERSIONS[id], "2.0.0"));
    const output = Buffer.from(currentText, "utf8");
    const file = `system-skills/${id}/SKILL.md`;
    await mkdir(dirname(join(ROOT, file)), { recursive: true });
    await writeFile(join(ROOT, file), output, { flag: "wx" });
    skillBaseline.push({ id, sourceVersion: SOURCE_SKILL_VERSIONS[id], sha256: sha256(sourceBytes) });
  }

  const upgradesFrom = structuredClone(originalManifest.upgradesFrom ?? {});
  upgradesFrom["1.0.8"] = Object.fromEntries(SKILLS.map((id) => [id, { "SKILL.md": UPGRADE_HASHES["1.0.8"][id] }]));
  upgradesFrom["1.0.9"] = Object.fromEntries(SKILLS.map((id) => [id, { "SKILL.md": UPGRADE_HASHES["1.0.9"][id] }]));
  const skillsManifest = {
    schemaVersion: "agent-system.system-skills-manifest.v1",
    product: "Agent System",
    version: "2.0.0",
    sourceVersion: originalManifest.version,
    sourceCommit: commit,
    skills: SKILLS,
    upgradesFrom,
  };
  await writeFile(join(ROOT, "system-skills/manifest.json"), jsonBytes(skillsManifest), { flag: "wx" });

  const workflowManifest = {
    schemaVersion: "agent-system.default-workflows-manifest.v1",
    sourceCommit: commit,
    workflowGeneratorSourceVersion: workflowEntries.find((entry) => entry.id === "workflow-generator")?.sourceVersion,
    systemSkillsSourceVersion: originalManifest.version,
    workflows: workflowEntries,
  };
  await writeFile(join(ROOT, "workflows/manifest.json"), jsonBytes(workflowManifest), { flag: "wx" });

  const source = {
    schemaVersion: "agent-system.default-workflow-source.v1",
    sourceRepository: "Agent System",
    sourceCommit: commit,
    workflowCount: IDS.length,
    systemSkillIds: SKILLS,
    workflowGeneratorSourceVersion: workflowManifest.workflowGeneratorSourceVersion,
    systemSkillsSourceVersion: originalManifest.version,
    contentVersion: "2.0.0",
  };
  await writeFile(join(ROOT, "source.json"), jsonBytes(source), { flag: "wx" });
  const sourceBaseline = {
    schemaVersion: "agent-system.default-workflow-source-baseline.v1",
    sourceCommit: commit,
    workflows: workflowBaseline,
    skills: skillBaseline,
    legacyUpgradesFrom: originalManifest.upgradesFrom,
  };
  await writeFile(join(ROOT, "source-baseline.json"), jsonBytes(sourceBaseline), { flag: "wx" });

  console.log(`Imported ${workflowEntries.length} Workflows and ${skillBaseline.length} product System Skills from approved baseline ${commit}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Source import failed.");
  process.exitCode = 1;
});
