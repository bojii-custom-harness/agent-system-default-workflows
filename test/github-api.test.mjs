import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github-api.mjs";
import { REPOSITORY } from "../src/constants.mjs";

test("GitHub client is target-repo restricted and public Release read-back sends no Authorization header", async () => {
  assert.throws(() => new GitHubClient({ token: "fixture-only", repository: "other/repository" }), /restricted/);
  let requestOptions;
  const github = new GitHubClient({
    token: "fixture-only",
    repository: REPOSITORY,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response("public-asset", { status: 200 });
    },
  });
  const bytes = await github.downloadPublicAsset(`https://github.com/${REPOSITORY}/releases/download/workflow-generator-2.0.0/asset.json`);
  assert.equal(bytes.toString("utf8"), "public-asset");
  assert.equal(requestOptions.method, "GET");
  assert.equal(requestOptions.headers, undefined);
  await assert.rejects(github.downloadPublicAsset("https://example.invalid/asset"), /approved public GitHub URL/);

  const oversized = new GitHubClient({
    token: "fixture-only",
    repository: REPOSITORY,
    fetchImpl: async () => new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "20000001" } }),
  });
  await assert.rejects(oversized.downloadPublicAsset(`https://github.com/${REPOSITORY}/releases/download/tag/asset`), /20 MB/);
});
