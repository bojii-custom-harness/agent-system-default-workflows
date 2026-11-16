#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubClient } from "../src/github-api.mjs";
import { ContractError } from "../src/errors.mjs";
import { REPOSITORY, WORKFLOW_IDS } from "../src/constants.mjs";
import { assertReleaseTag, parseReleaseTag } from "../src/semver.mjs";
import { createReleaseArtifacts, loadSourceAtCommit } from "../src/release-assets.mjs";
import { publishRelease, synchronizeCatalog } from "../src/publisher.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function publishAllTags({ root = ROOT, repository, token, apiUrl, selectedTag, github, loadArtifacts = loadArtifactsForTag } = {}) {
  if (repository !== REPOSITORY) throw new ContractError("PUBLISH_REPOSITORY_INVALID", `GitHub Actions publishing is restricted to ${REPOSITORY}.`);
  const client = github ?? new GitHubClient({ token, repository, apiUrl });
  const tags = git(root, ["tag", "--list"]).split(/\r?\n/).filter(Boolean);
  const managedTags = [];
  for (const tag of tags) {
    if (!tag.startsWith("workflow-") && !tag.startsWith("system-skills-")) continue;
    const parsed = parseReleaseTag(tag, WORKFLOW_IDS);
    if (!parsed) throw new ContractError("PUBLISH_TAG_INVALID", `Managed tag ${tag} is invalid; no Release writes were attempted.`);
    managedTags.push(parsed);
  }
  if (managedTags.length === 0) throw new ContractError("PUBLISH_TAGS_MISSING", "No approved Workflow or System Skills release tags are available.");
  if (selectedTag && !managedTags.some((item) => item.tag === selectedTag)) {
    assertReleaseTag(selectedTag, WORKFLOW_IDS);
    throw new ContractError("DISPATCH_TAG_MISSING", `Requested workflow_dispatch tag ${selectedTag} does not exist in this repository.`);
  }

  const published = [];
  const releaseObjects = [];
  for (const { tag } of managedTags.sort((left, right) => left.tag.localeCompare(right.tag))) {
    const artifacts = await loadArtifacts(root, tag);
    const result = await publishRelease({ github: client, artifacts });
    published.push({ tag, action: result.action });
    releaseObjects.push(result.release);
  }
  const catalog = await synchronizeCatalog({
    github: client,
    branch: "main",
    releases: releaseObjects,
    loadArtifacts: (tag) => loadArtifacts(root, tag),
  });
  return { repository, tags: published, catalogAction: catalog.action, catalogEntries: catalog.catalog.entries.length, catalogWriteAttempts: catalog.attempts };
}

async function loadArtifactsForTag(root, tag) {
  const sourceCommit = git(root, ["rev-parse", "--verify", `${tag}^{commit}`]).trim();
  const readGitFile = async (commit, path) => {
    try {
      return execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, windowsHide: true });
    } catch {
      throw new ContractError("TAG_SOURCE_MISSING", `Tag ${tag} does not contain required source file ${path}.`);
    }
  };
  const source = await loadSourceAtCommit(root, sourceCommit, readGitFile);
  return createReleaseArtifacts(source, tag, sourceCommit);
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000, windowsHide: true });
  } catch {
    throw new ContractError("GIT_OPERATION_FAILED", `Git operation ${args[0]} failed; output was suppressed.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selectedTag = process.env.INPUT_TAG?.trim() || undefined;
  publishAllTags({
    root: ROOT,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
    selectedTag,
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "Release publishing failed.");
    process.exitCode = 1;
  });
}
