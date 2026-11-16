import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { publishAllTags } from "../scripts/publish-releases.mjs";
import { createReleaseArtifacts } from "../src/release-assets.mjs";
import { loadSource } from "../src/source.mjs";
import { GitHubApiError } from "../src/errors.mjs";
import { REPOSITORY, WORKFLOW_IDS } from "../src/constants.mjs";
import { catalogBytes } from "../src/validators/catalog.mjs";
import { synchronizeCatalog, publishRelease } from "../src/publisher.mjs";
import { makeGitFixture, ROOT } from "./helpers.mjs";
import { MemoryGitHub } from "./memory-github.mjs";

async function getArtifacts(id = WORKFLOW_IDS[0], kind = "workflow") {
  const source = await loadSource(ROOT);
  const tag = kind === "system-skills" ? "system-skills-2.0.0" : `${id}-2.0.0`;
  return createReleaseArtifacts(source, tag, source.sourceManifest.sourceCommit);
}

test("Release creation and same-source retry verify anonymous bytes and are idempotent", async () => {
  const github = new MemoryGitHub();
  const artifacts = await getArtifacts();
  const first = await publishRelease({ github, artifacts });
  assert.equal(first.action, "created");
  assert.equal(first.release.assets.length, 2);
  assert.equal(github.createdCount, 1);
  assert.equal(github.uploadCount, 2);

  const second = await publishRelease({ github, artifacts });
  assert.equal(second.action, "verified");
  assert.equal(github.createdCount, 1);
  assert.equal(github.uploadCount, 2);
  assert.equal(github.downloadCount, 6);

  github.removeAsset(artifacts.tag, artifacts.payload.name);
  const repaired = await publishRelease({ github, artifacts });
  assert.equal(repaired.action, "repaired");
  assert.equal(github.createdCount, 1);
  assert.equal(github.uploadCount, 3);
  assert.equal(github.downloadCount, 9);
});

test("既有 Release metadata、asset bytes 與意外 asset 衝突時不覆寫", async () => {
  const artifacts = await getArtifacts();
  const github = new MemoryGitHub();
  const first = await publishRelease({ github, artifacts });
  const uploadCount = github.uploadCount;
  github.replaceAssetBytes(artifacts.payload.url, Buffer.from(`conflict:${artifacts.payload.bytes.toString("utf8")}`));
  await assert.rejects(publishRelease({ github, artifacts }), (error) => error.code === "RELEASE_ASSET_BYTES_CONFLICT");
  assert.equal(github.uploadCount, uploadCount);

  const metadataGithub = new MemoryGitHub();
  await publishRelease({ github: metadataGithub, artifacts });
  metadataGithub.releases.get(artifacts.tag).body += "\nunauthorized";
  await assert.rejects(publishRelease({ github: metadataGithub, artifacts }), (error) => error.code === "RELEASE_IDENTITY_CONFLICT");
  assert.equal(metadataGithub.uploadCount, 2);

  const urlGithub = new MemoryGitHub();
  await publishRelease({ github: urlGithub, artifacts });
  urlGithub.releases.get(artifacts.tag).assets[0].browser_download_url = "https://github.com/other/repo/releases/download/wrong/asset.json";
  await assert.rejects(publishRelease({ github: urlGithub, artifacts }), (error) => error.code === "RELEASE_ASSET_METADATA_CONFLICT");

  const unexpectedGithub = new MemoryGitHub();
  await publishRelease({ github: unexpectedGithub, artifacts });
  unexpectedGithub.releases.get(artifacts.tag).assets.push({ name: "unexpected.zip", size: 1, browser_download_url: "https://github.com/unexpected" });
  await assert.rejects(publishRelease({ github: unexpectedGithub, artifacts }), (error) => error.code === "RELEASE_ASSET_UNEXPECTED");
  assert.equal(first.entry.tag, artifacts.tag);
});

test("Release-create 與 asset-upload 競爭成功者會被 read-back 驗證，不覆寫", async () => {
  const artifacts = await getArtifacts();
  const github = new MemoryGitHub();
  const normal = await publishRelease({ github, artifacts });
  const raceGithub = new MemoryGitHub();
  raceGithub.beforeCreateRelease = async (client) => {
    client.releases.set(artifacts.tag, github.releases.get(artifacts.tag));
    client.assetsByUrl = new Map(github.assetsByUrl);
  };
  const result = await publishRelease({ github: raceGithub, artifacts });
  assert.equal(result.action, "verified");
  assert.equal(raceGithub.createdCount, 0);
  assert.ok(raceGithub.downloadCount >= 2);

  const uploadRace = new MemoryGitHub();
  const existingRelease = await github.getReleaseByTag(artifacts.tag);
  existingRelease.assets = [];
  uploadRace.releases.set(artifacts.tag, existingRelease);
  uploadRace.beforeUploadAsset = async (client, release, asset) => {
    const winnerRelease = github.releases.get(artifacts.tag);
    const winningAsset = winnerRelease.assets.find((item) => item.name === asset.name);
    client.releases.get(release.tag_name).assets.push({ ...winningAsset });
    client.assetsByUrl.set(winningAsset.browser_download_url, Buffer.from(github.assetsByUrl.get(winningAsset.browser_download_url)));
  };
  const uploadResult = await publishRelease({ github: uploadRace, artifacts });
  assert.equal(uploadResult.action, "repaired");
  assert.equal(uploadRace.uploadCount, 1);
  assert.ok(uploadRace.downloadCount >= 2);
  assert.equal(normal.entry.tag, artifacts.tag);
});

test("catalog compare-and-swap 遇到併發更新會重讀並保留每個 Release entry", async () => {
  const github = new MemoryGitHub();
  const source = await loadSource(ROOT);
  const artifacts = [
    createReleaseArtifacts(source, `${WORKFLOW_IDS[0]}-2.0.0`, source.sourceManifest.sourceCommit),
    createReleaseArtifacts(source, `${WORKFLOW_IDS[1]}-2.0.0`, source.sourceManifest.sourceCommit),
  ];
  const results = [];
  for (const item of artifacts) results.push(await publishRelease({ github, artifacts: item }));
  github.beforeCatalogPut = async (client) => {
    client.catalogFile = {
      sha: "concurrent-writer-sha",
      bytes: catalogBytes({ schemaVersion: "agent-system.default-workflow-catalog.v1", entries: [results[0].entry] }),
    };
  };

  const result = await synchronizeCatalog({
    github,
    releases: results.map((item) => item.release),
    loadArtifacts: async (tag) => artifacts.find((item) => item.tag === tag),
  });
  assert.equal(result.action, "updated");
  assert.equal(result.attempts, 2);
  assert.deepEqual(new Set(result.catalog.entries.map((entry) => entry.tag)), new Set(artifacts.map((item) => item.tag)));
  assert.equal(github.catalogPutCount, 2);
});

test("catalog conflict is fail-closed; Release survives a failed catalog write and a retry repairs it", async () => {
  const github = new MemoryGitHub();
  const artifacts = await getArtifacts();
  const release = await publishRelease({ github, artifacts });
  const conflictingEntry = structuredClone(release.entry);
  conflictingEntry.assets[0].sha256 = "0".repeat(64);
  github.catalogFile = {
    sha: "existing-catalog",
    bytes: catalogBytes({ schemaVersion: "agent-system.default-workflow-catalog.v1", entries: [conflictingEntry] }),
  };
  await assert.rejects(synchronizeCatalog({ github, loadArtifacts: async () => artifacts }), (error) => error.code === "CATALOG_ENTRY_CONFLICT");
  assert.equal(github.catalogPutCount, 0);

  github.catalogFile = undefined;
  github.catalogWriteFailures.push(500);
  await assert.rejects(synchronizeCatalog({ github, releases: [release.release], loadArtifacts: async () => artifacts }), (error) => error instanceof GitHubApiError && error.status === 500);
  assert.equal(github.releases.size, 1);
  assert.equal(github.uploadCount, 2);
  const retry = await synchronizeCatalog({ github, releases: [release.release], loadArtifacts: async () => artifacts });
  assert.equal(retry.action, "updated");
  assert.equal(retry.catalog.entries.length, 1);
  assert.equal(github.releases.size, 1);
  assert.equal(github.uploadCount, 2);
});

test("發布腳本只接受核准 repo，並從已提交 tag 裝載驗證 source、補齊 assets/catalog", async (t) => {
  const fixture = await makeGitFixture({ tags: ["workflow-generator-2.0.0", "system-skills-2.0.0"] });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const github = new MemoryGitHub();
  await assert.rejects(publishAllTags({ root: fixture.root, repository: "someone/else", github }), (error) => error.code === "PUBLISH_REPOSITORY_INVALID");
  assert.equal(github.releases.size, 0);

  const result = await publishAllTags({ root: fixture.root, repository: REPOSITORY, github });
  assert.equal(result.tags.length, 2);
  assert.equal(result.catalogEntries, 2);
  assert.equal(github.releases.size, 2);
  const rerun = await publishAllTags({ root: fixture.root, repository: REPOSITORY, github });
  assert.ok(rerun.tags.every((item) => item.action === "verified"));
  assert.equal(github.catalogPutCount, 1);
});

test("公開 bundle asset 是 deterministic JSON，含 manifest 與三個完整產品 Skill", async () => {
  const artifacts = await getArtifacts("system-skills", "system-skills");
  const repeatedArtifacts = await getArtifacts("system-skills", "system-skills");
  assert.deepEqual(repeatedArtifacts.payload.bytes, artifacts.payload.bytes);
  const bundle = JSON.parse(artifacts.payload.bytes.toString("utf8"));
  assert.equal(bundle.schemaVersion, "agent-system.system-skills-bundle.v1");
  assert.equal(bundle.version, "2.0.0");
  assert.deepEqual(bundle.skills.map((skill) => skill.id), ["plugin-discovery", "workflow-assembly", "resource-authoring"]);
  for (const skill of bundle.skills) {
    assert.equal(skill.size, Buffer.byteLength(skill.content, "utf8"));
    assert.equal(skill.sha256, createHash("sha256").update(skill.content, "utf8").digest("hex"));
    assert.ok(skill.content.includes(`name: ${skill.id}`));
  }
  const metadata = JSON.parse(artifacts.metadataAsset.bytes.toString("utf8"));
  assert.equal(metadata.sourceCommit, "7f5c7a56bce02501547e2933bbefd7f4a745f0b9");
  assert.equal(metadata.asset.sha256, artifacts.payload.sha256);
  const currentCatalog = JSON.parse(await readFile(join(ROOT, "catalog.json"), "utf8"));
  assert.equal(currentCatalog.entries.length, 12);
  assert.ok(currentCatalog.entries.every((entry) => entry.version === "2.0.0" && entry.channel === "stable"));
});
