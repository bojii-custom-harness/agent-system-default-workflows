#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = await collect(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { cwd: root, timeout: 15000, encoding: "buffer", windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(`Syntax check failed: ${file} (exit ${result.status ?? "unknown"}).`);
    process.exitCode = 1;
    break;
  }
}
if (process.exitCode !== 1) console.log(`Syntax check passed for ${files.length} JavaScript modules.`);

async function collect(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules", ".release-work"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collect(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) result.push(path);
  }
  return result.sort();
}
