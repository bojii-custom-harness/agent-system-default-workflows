import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { makeGitFixture, gitOutput } from "./helpers.mjs";

const workflowVersion = "2.1.0";
const skillsVersion = "2.0.1";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function invokeCli(root, args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [join(root, "bin", "default-workflows.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30000,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, `${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return `${result.stdout}${result.stderr}`.trim();
}

test("Workflow 與 System Skills 可獨立版本化、驗證並推送各自的精確 tag", async (t) => {
  const fixture = await makeGitFixture({
    prepareSource: async (root) => {
      const workflowPath = join(root, "workflows", "workflow-generator.json");
      const workflow = await readJson(workflowPath);
      workflow.version = workflowVersion;
      await writeJson(workflowPath, workflow);

      const workflowManifestPath = join(root, "workflows", "manifest.json");
      const workflowManifest = await readJson(workflowManifestPath);
      const workflowEntry = workflowManifest.workflows.find((entry) => entry.id === workflow.id);
      const workflowBytes = await readFile(workflowPath);
      workflowEntry.version = workflowVersion;
      workflowEntry.sha256 = sha256(workflowBytes);
      await writeJson(workflowManifestPath, workflowManifest);

      const skillsManifestPath = join(root, "system-skills", "manifest.json");
      const skillsManifest = await readJson(skillsManifestPath);
      skillsManifest.version = skillsVersion;
      await writeJson(skillsManifestPath, skillsManifest);

      for (const id of skillsManifest.skills) {
        const skillPath = join(root, "system-skills", id, "SKILL.md");
        let text = await readFile(skillPath, "utf8");
        const oldMarker = id === "plugin-discovery"
          ? "版本為 2.0.0 的 System Skill"
          : "is version 2.0.0.";
        const newMarker = id === "plugin-discovery"
          ? `版本為 ${skillsVersion} 的 System Skill`
          : `is version ${skillsVersion}.`;
        assert.equal(text.split(oldMarker).length - 1, 1, `${id} source marker must be unique`);
        text = text.replace(oldMarker, newMarker);
        await writeFile(skillPath, text, "utf8");
      }
    },
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  const validation = JSON.parse(invokeCli(fixture.root, ["validate"]));
  assert.deepEqual(validation, {
    valid: true,
    sourceCommit: "7f5c7a56bce02501547e2933bbefd7f4a745f0b9",
    workflows: 11,
    systemSkills: 3,
    systemSkillsVersion: skillsVersion,
  });

  const listing = JSON.parse(invokeCli(fixture.root, ["list"]));
  const products = new Map(listing.products.map((product) => [product.id, product.currentVersion]));
  assert.equal(products.get("workflow-generator"), workflowVersion);
  assert.equal(products.get("system-skills"), skillsVersion);
  assert.equal(products.get("workflow-agent-writer"), "2.0.0");

  assert.match(invokeCli(fixture.root, ["publish", "workflow-generator", workflowVersion, "--remote", "origin"]), /created-and-pushed/);
  assert.match(invokeCli(fixture.root, ["publish", "system-skills", skillsVersion, "--remote", "origin"]), /created-and-pushed/);
  assert.match(invokeCli(fixture.root, ["publish", "workflow-generator", "2.0.0", "--remote", "origin"], 1), /PUBLISH_VERSION_MISMATCH/);
  assert.match(invokeCli(fixture.root, ["publish", "system-skills", "2.0.0", "--remote", "origin"], 1), /PUBLISH_VERSION_MISMATCH/);

  const tags = gitOutput(fixture.root, ["tag", "--list"]).split(/\r?\n/).filter(Boolean).sort();
  assert.deepEqual(tags, ["system-skills-2.0.1", "workflow-generator-2.1.0"]);
  assert.equal(gitOutput(fixture.root, ["status", "--porcelain=v1"]), "");
});
