import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { makeGitFixture, ROOT } from "./helpers.mjs";

test("Windows PowerShell sub-process validates CLI history and local bare Git publish/conflict behavior", async (t) => {
  assert.equal(process.platform, "win32", "The documented CLI integration matrix requires Windows PowerShell.");
  const fixture = await makeGitFixture();
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const script = join(ROOT, "test", "cli-powershell.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    "-FixtureRoot", fixture.root,
    "-RemotePath", fixture.remote,
    "-NodeExe", process.execPath,
  ], { encoding: "buffer", timeout: 40000, windowsHide: true });
  const output = Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]).toString("utf8");
  assert.ifError(result.error);
  assert.equal(result.status, 0, output);
  assert.match(output, /Windows PowerShell CLI, local bare Git tag, idempotency and conflict checks passed/);
});
