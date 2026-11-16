import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { CONTENT_VERSION, SYSTEM_SKILL_IDS, UPGRADE_HASHES, WORKFLOW_IDS } from "../src/constants.mjs";
import { validateSourceManifests, loadSource } from "../src/source.mjs";
import { validateSkillsManifest } from "../src/validators/system-skills.mjs";
import { validateWorkflow } from "../src/validators/workflow.mjs";
import { ROOT } from "./helpers.mjs";

test("來源 inventory、Workflow graph/resource fingerprints 與 Skills baseline 完整吻合", async () => {
  const source = await loadSource(ROOT);
  assert.equal(source.workflows.length, 11);
  assert.deepEqual(source.workflows.map((workflow) => workflow.id).sort(), [...WORKFLOW_IDS].sort());
  assert.equal(source.sourceManifest.sourceCommit, "7f5c7a56bce02501547e2933bbefd7f4a745f0b9");
  assert.equal(source.sourceManifest.workflowGeneratorSourceVersion, "0.0.30");
  assert.equal(source.sourceManifest.systemSkillsSourceVersion, "1.0.9");
  assert.equal(source.skillsManifest.version, CONTENT_VERSION);
  assert.equal(source.skillsManifest.sourceVersion, "1.0.9");
  assert.deepEqual(Object.keys(source.skillFiles).sort(), [...SYSTEM_SKILL_IDS].sort());
  assert.equal(source.workflowManifest.workflows.length, WORKFLOW_IDS.length);
  for (const [version, mappings] of Object.entries(source.baseline.legacyUpgradesFrom)) {
    if (version === "1.0.8") {
      assert.deepEqual(source.skillsManifest.upgradesFrom[version]["workflow-assembly"], mappings["workflow-assembly"]);
    } else {
      assert.deepEqual(source.skillsManifest.upgradesFrom[version], mappings);
    }
  }

  for (const workflow of source.workflows) {
    assert.equal(workflow.version, CONTENT_VERSION);
    assert.equal(source.workflowManifest.workflows.find((item) => item.id === workflow.id)?.uuid, workflow.uuid);
    assert.ok(workflow.nodes.length > 0);
    assert.ok(workflow.nodes.some((node) => node.type.startsWith("resource.") && typeof node.data.name === "string"));
    assert.ok(source.baseline.workflows.some((entry) => entry.id === workflow.id && entry.uuid === workflow.uuid));
  }
  for (const id of SYSTEM_SKILL_IDS) {
    const text = source.skillFiles[id].toString("utf8");
    assert.ok(text.includes(`name: ${id}`));
    assert.equal((text.match(/2\.0\.0/g) ?? []).length, 1, `${id} has exactly one approved version marker`);
  }
  assert.deepEqual((await readdir(join(ROOT, "system-skills"))).filter((item) => !item.endsWith(".json")).sort(), [...SYSTEM_SKILL_IDS].sort());
  await assert.rejects(readFile(join(ROOT, "system-skills", "find-skills")), { code: "ENOENT" });
  await assert.rejects(readFile(join(ROOT, "system-skills", "skill-creator")), { code: "ENOENT" });
});

test("1.0.8 與 1.0.9 安裝來源 fixtures 的完整三個 SKILL.md SHA-256 精確保留", async () => {
  const source = await loadSource(ROOT);
  for (const version of ["1.0.8", "1.0.9"]) {
    const fixture = JSON.parse(await readFile(join(ROOT, "test", "fixtures", `upgrade-source-${version}.json`), "utf8"));
    assert.equal(fixture.schemaVersion, "agent-system.system-skills-upgrade-source-fixture.v1");
    assert.equal(fixture.version, version);
    assert.deepEqual(fixture.skills, SYSTEM_SKILL_IDS);
    assert.deepEqual(Object.keys(fixture.installedFiles).sort(), [...SYSTEM_SKILL_IDS].sort());
    for (const id of SYSTEM_SKILL_IDS) {
      const expected = UPGRADE_HASHES[version][id];
      assert.equal(fixture.installedFiles[id]["SKILL.md"], expected);
      assert.equal(source.skillsManifest.upgradesFrom[version][id]["SKILL.md"], expected);
    }
  }
});

test("固定來源漂移、未核准 Workflow 欄位與錯誤 Upgrade hash 都 fail-closed", async () => {
  const source = await loadSource(ROOT);
  const alteredWorkflows = structuredClone(source.workflows);
  alteredWorkflows[0].nodes[0].data.name = "unauthorized-edit";
  assert.throws(() => validateSourceManifests({
    sourceManifest: source.sourceManifest,
    baseline: source.baseline,
    workflowManifest: source.workflowManifest,
    workflows: alteredWorkflows,
    workflowFiles: source.workflowFiles,
    skillFiles: source.skillFiles,
    skillsManifest: source.skillsManifest,
  }), (error) => error.code === "WORKFLOW_SOURCE_DRIFT");

  const alteredBaseline = structuredClone(source.baseline);
  alteredBaseline.legacyUpgradesFrom["1.0.0"]["plugin-discovery"]["SKILL.md"] = "0".repeat(64);
  assert.throws(() => validateSourceManifests({
    sourceManifest: source.sourceManifest,
    baseline: alteredBaseline,
    workflowManifest: source.workflowManifest,
    workflows: source.workflows,
    workflowFiles: source.workflowFiles,
    skillFiles: source.skillFiles,
    skillsManifest: source.skillsManifest,
  }), (error) => error.code === "SOURCE_BASELINE_FINGERPRINT_INVALID");

  const alteredSkillsManifest = structuredClone(source.skillsManifest);
  alteredSkillsManifest.sourceCommit = "0".repeat(40);
  assert.throws(() => validateSourceManifests({
    sourceManifest: source.sourceManifest,
    baseline: source.baseline,
    workflowManifest: source.workflowManifest,
    workflows: source.workflows,
    workflowFiles: source.workflowFiles,
    skillFiles: source.skillFiles,
    skillsManifest: alteredSkillsManifest,
  }), (error) => error.code === "SYSTEM_SKILL_SOURCE_IDENTITY_INVALID");

  const unknownField = structuredClone(source.workflows[0]);
  unknownField.unauthorized = true;
  assert.throws(() => validateWorkflow(unknownField, unknownField.id), (error) => error.code === "WORKFLOW_UNKNOWN_FIELD");

  const alteredManifest = structuredClone(source.skillsManifest);
  alteredManifest.upgradesFrom["1.0.9"]["workflow-assembly"]["SKILL.md"] = "0".repeat(64);
  assert.throws(() => validateSkillsManifest(alteredManifest, source.skillFiles), (error) => error.code === "SKILLS_UPGRADE_MAPPING_MISMATCH");
});

test("所有公開 JSON Schema 都是有效 JSON 並宣告完整 source/release 資料契約", async () => {
  const schemaDirectory = join(ROOT, "schemas");
  const names = (await readdir(schemaDirectory)).filter((name) => name.endsWith(".schema.json")).sort();
  assert.deepEqual(names, [
    "catalog.schema.json",
    "release-metadata.schema.json",
    "source-baseline.schema.json",
    "source-manifest.schema.json",
    "system-skills-bundle.schema.json",
    "system-skills-manifest.schema.json",
    "workflow-manifest.schema.json",
    "workflow.schema.json",
  ]);
  const schemas = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(schemaDirectory, name), "utf8"))));
  assert.ok(schemas.every((schema) => schema.$schema === "https://json-schema.org/draft/2020-12/schema"));
  const workflowSchema = JSON.parse(await readFile(join(schemaDirectory, "workflow.schema.json"), "utf8"));
  assert.ok(workflowSchema.$defs.node.properties.type.enum.includes("action.prompt"));
  assert.ok(workflowSchema.$defs.node.properties.type.enum.includes("trigger.manual"));
});
