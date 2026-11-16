import assert from "node:assert/strict";
import test from "node:test";
import { ContractError } from "../src/errors.mjs";
import { assertSemVer, channelFor, compareSemVer, parseReleaseTag, parseSemVer, releaseTag } from "../src/semver.mjs";
import { WORKFLOW_IDS } from "../src/constants.mjs";

test("SemVer 2.0.0 ordering, prerelease channels and exact product tags", () => {
  assert.equal(parseSemVer("2.0.0+build.5").major, 2n);
  assert.equal(compareSemVer("2.0.0-rc.2", "2.0.0-rc.10"), -1);
  assert.equal(compareSemVer("2.0.0-rc.10", "2.0.0"), -1);
  assert.equal(channelFor("2.0.0"), "stable");
  assert.equal(channelFor("2.1.0-preview.1"), "dev");
  assert.equal(releaseTag("workflow", "workflow-generator", "2.0.0"), "workflow-generator-2.0.0");
  assert.equal(releaseTag("system-skills", "system-skills", "2.0.0"), "system-skills-2.0.0");
  assert.deepEqual(parseReleaseTag("workflow-generator-2.0.0", WORKFLOW_IDS), {
    kind: "workflow", id: "workflow-generator", version: "2.0.0", channel: "stable", tag: "workflow-generator-2.0.0",
  });
});

test("invalid SemVer, numeric prerelease leading zero and unknown IDs are rejected", () => {
  for (const version of ["01.0.0", "1.0", "1.0.0-01", "1.0.0+bad..metadata", "latest"]) {
    assert.equal(parseSemVer(version), undefined, version);
  }
  assert.throws(() => assertSemVer("1.0"), ContractError);
  assert.equal(parseReleaseTag("unknown-workflow-2.0.0", WORKFLOW_IDS), undefined);
  assert.equal(parseReleaseTag("workflow-generator-02.0.0", WORKFLOW_IDS), undefined);
});
