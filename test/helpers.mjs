import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_BASE = process.env.LOCALAPPDATA
  ? join(process.env.LOCALAPPDATA, "Temp", "opencode")
  : join(tmpdir(), "opencode");
const COPY_PATHS = [".gitattributes", "bin", "schemas", "src", "system-skills", "workflows", "source.json", "source-baseline.json", "package.json"];

export function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "buffer", timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Git fixture command ${args[0]} failed (exit ${result.status ?? "unknown"}).`);
  }
  return result.stdout.toString("utf8").trim();
}

export async function makeGitFixture({ tags = [], prepareSource } = {}) {
  await mkdir(TEST_BASE, { recursive: true });
  const directory = await mkdtemp(join(TEST_BASE, "default-workflows-fixture-"));
  const root = join(directory, "source");
  const remote = join(directory, "remote.git");
  await mkdir(root, { recursive: true });
  for (const relative of COPY_PATHS) await cp(resolve(ROOT, relative), join(root, relative), { recursive: true });
  if (prepareSource) await prepareSource(root);

  runGit(directory, ["init", "--bare", "--initial-branch=main", remote]);
  runGit(root, ["init", "--initial-branch=main"]);
  runGit(root, ["config", "user.name", "Default Workflow Test Fixture"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  runGit(root, ["add", "--all"]);
  runGit(root, ["commit", "-m", "test fixture source"]);
  runGit(root, ["checkout", "--force", "main"]);
  runGit(root, ["remote", "add", "origin", remote]);
  runGit(root, ["push", "--set-upstream", "origin", "main"]);
  for (const tag of tags) runGit(root, ["tag", tag]);
  return { directory, root, remote };
}

export function gitOutput(cwd, args) {
  return runGit(cwd, args);
}

export function assertContractCode(error, code) {
  assert.equal(error?.code, code, error?.message ?? "Expected a contract error.");
}
