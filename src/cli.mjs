import { execFileSync, spawnSync } from "node:child_process";
import { open, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ContractError } from "./errors.mjs";
import { CATALOG_SCHEMA, CLI_VERSION, REPOSITORY, SYSTEM_SKILL_IDS, WORKFLOW_IDS } from "./constants.mjs";
import { assertSemVer, channelFor, compareSemVer, parseReleaseTag, releaseTag } from "./semver.mjs";
import { loadSource } from "./source.mjs";
import { validateCatalog } from "./validators/catalog.mjs";
import { downloadRelease, fetchCatalog } from "./default-workflow-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runCli(args, options = {}) {
  const root = resolve(options.root ?? ROOT);
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") {
    console.log(helpText());
    return 0;
  }
  if (command === "--version" || command === "version") {
    console.log(CLI_VERSION);
    return 0;
  }
  if (command === "catalog") {
    const parsed = parseCommandOptions(rest, ["--output"]);
    if (parsed.positionals.length > 0) throw new ContractError("CATALOG_ARGUMENTS_INVALID", "catalog does not accept positional arguments.");
    const { bytes, sha256 } = await fetchCatalog(networkOptions(options));
    if (parsed.options["--output"]) {
      await writeOutputFile(parsed.options["--output"], bytes);
      console.log(JSON.stringify({ repository: REPOSITORY, size: bytes.byteLength, sha256 }));
    } else {
      process.stdout.write(bytes);
    }
    return 0;
  }
  if (command === "download") {
    const parsed = parseCommandOptions(rest, ["--channel", "--catalog", "--output", "--metadata-output"]);
    if (parsed.positionals.length !== 2) {
      throw new ContractError("DOWNLOAD_ARGUMENTS_REQUIRED", "download requires <workflow-id|system-skills> <SemVer>.");
    }
    const [id, version] = parsed.positionals;
    if (!id || !version) throw new ContractError("DOWNLOAD_ARGUMENTS_REQUIRED", "download requires <workflow-id|system-skills> <SemVer>.");
    if (!parsed.options["--output"]) throw new ContractError("DOWNLOAD_OUTPUT_REQUIRED", "download requires --output <path>.");
    const channel = requiredReleaseChannel(parsed.options["--channel"]);
    const catalog = parsed.options["--catalog"]
      ? await readCatalog(parsed.options["--catalog"])
      : (await fetchCatalog(networkOptions(options))).catalog;
    const release = await downloadRelease({
      catalog,
      id,
      version,
      channel,
      ...networkOptions(options),
    });
    await writeOutputFiles([
      { path: parsed.options["--output"], bytes: release.bytes },
      ...(parsed.options["--metadata-output"]
        ? [{ path: parsed.options["--metadata-output"], bytes: release.metadataBytes }]
        : []),
    ]);
    console.log(JSON.stringify({
      kind: release.entry.kind,
      id: release.entry.id,
      version: release.entry.version,
      channel: release.entry.channel,
      tag: release.entry.tag,
      filename: release.productAsset.name,
      size: release.bytes.byteLength,
      sha256: release.productAsset.sha256,
    }));
    return 0;
  }
  const source = await loadSource(root);
  if (command === "validate") {
    console.log(JSON.stringify({ valid: true, sourceCommit: source.sourceManifest.sourceCommit, workflows: source.workflows.length, systemSkills: source.skillManifestBytes ? SYSTEM_SKILL_IDS.length : 0, systemSkillsVersion: source.skillsManifest.version }));
    return 0;
  }
  if (command === "list") {
    const catalogPath = optionValue(rest, "--catalog") ?? resolve(root, "catalog.json");
    const catalog = await readCatalog(catalogPath);
    const products = [
      ...source.workflows.map((workflow) => ({ kind: "workflow", id: workflow.id, currentVersion: workflow.version })),
      { kind: "system-skills", id: "system-skills", currentVersion: source.skillsManifest.version },
    ].map((product) => productInfo(product, catalog.entries, readLocalTags(root)));
    console.log(JSON.stringify({ repository: REPOSITORY, products }, null, 2));
    return 0;
  }
  if (command === "history") {
    const id = rest.find((arg) => !arg.startsWith("-"));
    if (!id || (!WORKFLOW_IDS.includes(id) && id !== "system-skills")) throw new ContractError("PRODUCT_ID_REQUIRED", "history requires an approved Workflow ID or system-skills.");
    const catalogPath = optionValue(rest, "--catalog") ?? resolve(root, "catalog.json");
    const catalog = await readCatalog(catalogPath);
    const kind = id === "system-skills" ? "system-skills" : "workflow";
    const entries = catalog.entries.filter((entry) => entry.kind === kind && entry.id === id)
      .sort((left, right) => compareSemVer(right.version, left.version));
    const localTags = readLocalTags(root).filter((entry) => entry.kind === kind && entry.id === id)
      .sort((left, right) => compareSemVer(right.version, left.version));
    console.log(JSON.stringify({ id, kind, currentVersion: kind === "system-skills" ? source.skillsManifest.version : source.workflows.find((item) => item.id === id).version, catalog: entries, localTags }, null, 2));
    return 0;
  }
  if (command === "publish") {
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    const id = positional[0];
    const version = positional[1];
    if (!id || !version) throw new ContractError("PUBLISH_ARGUMENTS_REQUIRED", "publish requires <workflow-id|system-skills> <SemVer>.");
    const remote = optionValue(rest, "--remote") ?? "origin";
    const result = publishTag({ root, source, id, version, remote });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  throw new ContractError("UNKNOWN_COMMAND", `Unknown command ${command}. Run with --help for supported commands.`);
}

export function publishTag({ root, source, id, version, remote }) {
  assertSemVer(version, "publish version");
  const isBundle = id === "system-skills";
  const workflow = source.workflows.find((item) => item.id === id);
  if (!isBundle && !workflow) throw new ContractError("PRODUCT_ID_INVALID", `publish ID ${id} is not an approved Workflow or System Skills bundle.`);
  const currentVersion = isBundle ? source.skillsManifest.version : workflow.version;
  if (version !== currentVersion) {
    throw new ContractError("PUBLISH_VERSION_MISMATCH", `${id} source version is ${currentVersion}; refusing to tag requested version ${version}.`);
  }
  const kind = isBundle ? "system-skills" : "workflow";
  const tag = releaseTag(kind, id, version);
  const status = git(root, ["status", "--porcelain=v1"]);
  if (status.trim()) throw new ContractError("WORKTREE_NOT_CLEAN", "Publishing requires a clean source worktree so the tag identifies committed bytes.");
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new ContractError("SOURCE_COMMIT_INVALID", "Current source commit must be a full Git SHA.");
  const localTagCommit = optionalGit(root, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  if (localTagCommit && localTagCommit.trim() !== sourceCommit) throw new ContractError("TAG_CONFLICT", `Local tag ${tag} points to a different source commit; it was not changed.`);

  const remoteTag = git(root, ["ls-remote", "--refs", remote, `refs/tags/${tag}`]);
  if (remoteTag.trim()) {
    const fetched = optionalGit(root, ["fetch", "--no-tags", remote, `refs/tags/${tag}`]);
    if (fetched === undefined) throw new ContractError("REMOTE_TAG_READ_FAILED", `Remote tag ${tag} could not be fetched for identity verification.`);
    const remoteCommit = git(root, ["rev-parse", "FETCH_HEAD^{commit}"]).trim();
    if (remoteCommit !== sourceCommit) throw new ContractError("TAG_CONFLICT", `Remote tag ${tag} points to a different source commit; no tag was overwritten.`);
    verifyCommitFiles(root, remoteCommit, source, id, isBundle);
    return releaseSummary(kind, id, version, tag, sourceCommit, "already-published");
  }

  if (!localTagCommit) git(root, ["tag", tag, sourceCommit]);
  const pushed = optionalGit(root, ["push", remote, `refs/tags/${tag}:refs/tags/${tag}`]);
  if (pushed === undefined) {
    const afterFailure = optionalGit(root, ["ls-remote", "--refs", remote, `refs/tags/${tag}`]);
    if (afterFailure?.trim()) {
      const fetched = optionalGit(root, ["fetch", "--no-tags", remote, `refs/tags/${tag}`]);
      const remoteCommit = fetched !== undefined ? optionalGit(root, ["rev-parse", "FETCH_HEAD^{commit}"])?.trim() : undefined;
      if (remoteCommit === sourceCommit) {
        verifyCommitFiles(root, remoteCommit, source, id, isBundle);
        return releaseSummary(kind, id, version, tag, sourceCommit, "already-published");
      }
      throw new ContractError("TAG_PUSH_CONFLICT", `Push of ${tag} was rejected and the remote tag does not match this source; no retry or alternate remote was attempted.`);
    }
    throw new ContractError("TAG_PUSH_FAILED", `Push of ${tag} failed; local tag is retained for diagnosis and no alternate remote was attempted.`);
  }
  return releaseSummary(kind, id, version, tag, sourceCommit, "created-and-pushed");
}

export function productInfo(product, catalogEntries, localTags) {
  const tags = localTags.filter((entry) => entry.kind === product.kind && entry.id === product.id);
  const releases = catalogEntries.filter((entry) => entry.kind === product.kind && entry.id === product.id);
  return {
    kind: product.kind,
    id: product.id,
    currentVersion: product.currentVersion,
    channel: channelFor(product.currentVersion),
    catalogVersions: releases.map(({ version, channel, tag, assets }) => ({ version, channel, tag, assets })),
    localTags: tags.map(({ version, channel, tag }) => ({ version, channel, tag })),
  };
}

export async function readCatalog(path) {
  let value;
  try {
    value = JSON.parse((await readFile(path, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: CATALOG_SCHEMA, entries: [] };
    throw new ContractError("CATALOG_READ_FAILED", `Unable to read catalog file ${path}.`);
  }
  validateCatalog(value);
  return value;
}

export function readLocalTags(root) {
  const tags = git(root, ["tag", "--list"]).split(/\r?\n/).filter(Boolean);
  return tags.flatMap((tag) => {
    const parsed = parseReleaseTag(tag, WORKFLOW_IDS);
    return parsed ? [parsed] : [];
  });
}

function verifyCommitFiles(root, commit, source, id, isBundle) {
  const paths = isBundle
    ? ["system-skills/manifest.json", ...SYSTEM_SKILL_IDS.map((skill) => `system-skills/${skill}/SKILL.md`)]
    : [`workflows/${id}.json`];
  for (const path of paths) {
    const bytes = execFileSync("git", ["show", `${commit}:${path}`], { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 30000, windowsHide: true });
    const expected = isBundle
      ? path === "system-skills/manifest.json" ? source.skillManifestBytes : source.skillFiles[path.split("/")[1]]
      : source.workflowFiles.get(id);
    if (!bytes.equals(expected)) throw new ContractError("TAG_SOURCE_CONTENT_CONFLICT", `Tag source file ${path} does not match the validated current source.`);
  }
}

function releaseSummary(kind, id, version, tag, sourceCommit, action) {
  const assetName = kind === "workflow" ? `workflow-${id}-${version}.json` : `system-skills-${version}.json`;
  return { action, kind, id, version, channel: channelFor(version), tag, sourceCommit, assetName };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseCommandOptions(args, allowedOptions) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (!allowedOptions.includes(value)) throw new ContractError("UNKNOWN_OPTION", `Unknown option ${value}.`);
    if (Object.hasOwn(options, value)) throw new ContractError("DUPLICATE_OPTION", `Option ${value} may only be provided once.`);
    const optionValue = args[index + 1];
    if (!optionValue || optionValue.startsWith("--")) throw new ContractError("OPTION_VALUE_REQUIRED", `${value} requires a value.`);
    options[value] = optionValue;
    index += 1;
  }
  return { positionals, options };
}

function networkOptions(options) {
  return {
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.requestTimeoutMs ? { timeoutMs: options.requestTimeoutMs } : {}),
    ...(options.retryDelayImpl ? { retryDelayImpl: options.retryDelayImpl } : {}),
  };
}

function requiredReleaseChannel(value) {
  if (value !== "stable" && value !== "dev") {
    throw new ContractError("RELEASE_CHANNEL_INVALID", "download requires --channel stable|dev.");
  }
  return value;
}

async function writeOutputFile(path, bytes) {
  await writeOutputFiles([{ path, bytes }]);
}

async function writeOutputFiles(outputs) {
  const destinations = outputs.map(({ path }) => resolve(path));
  if (new Set(destinations).size !== destinations.length) {
    throw new ContractError("OUTPUT_PATH_CONFLICT", "Output and metadata paths must be different.");
  }
  const staged = [];
  try {
    for (const [index, output] of outputs.entries()) {
      const destination = destinations[index];
      const parent = dirname(destination);
      await mkdir(parent, { recursive: true });
      const temporary = resolve(parent, `.${basename(destination)}.${randomUUID()}.tmp`);
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(output.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      staged.push({ temporary, destination });
    }
    for (const { destination } of staged) {
      await lstat(destination).then(() => {
        throw new ContractError("OUTPUT_PATH_EXISTS", `Refusing to overwrite existing output: ${destination}`);
      }, (error) => {
        if (error instanceof ContractError) throw error;
        if (error?.code !== "ENOENT") throw error;
      });
    }
    for (const item of staged) await rename(item.temporary, item.destination);
  } catch (error) {
    for (const item of staged) await rm(item.temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "buffer", timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) {
    const code = Number.isInteger(result.status) ? `exit ${result.status}` : "process error";
    throw new ContractError("GIT_OPERATION_FAILED", `Git operation ${args[0]} failed (${code}); output was suppressed to avoid exposing remote credentials.`);
  }
  return result.stdout.toString("utf8");
}

function optionalGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "buffer", timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout.toString("utf8");
}

function helpText() {
  return [
    `Agent System Default Workflow CLI ${CLI_VERSION}`,
    "",
    "Commands:",
    "  catalog [--output <path>]",
    "  download <workflow-id|system-skills> <SemVer> --channel stable|dev [--catalog <path>] --output <path> [--metadata-output <path>]",
    "  validate",
    "  list [--catalog <path>]",
    "  history <workflow-id|system-skills> [--catalog <path>]",
    "  publish <workflow-id|system-skills> <SemVer> [--remote <git-remote>]",
    "  --version",
  ].join("\n");
}

export function main(args = process.argv.slice(2)) {
  return runCli(args).catch((error) => {
    const message = error instanceof Error ? error.message : "Command failed.";
    console.error(error instanceof ContractError ? `${error.code}: ${message}` : message);
    return 1;
  });
}
