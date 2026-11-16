import { GitHubApiError, ContractError } from "./errors.mjs";
import { CATALOG_SCHEMA, RELEASE_METADATA_ASSET, REPOSITORY, WORKFLOW_IDS } from "./constants.mjs";
import { compareSemVer, parseReleaseTag } from "./semver.mjs";
import { catalogBytes, sortCatalogEntries, validateCatalog } from "./validators/catalog.mjs";
import { catalogEntryFromRelease, releasePresentation, validateReleaseMetadata } from "./release-assets.mjs";

const MAX_CATALOG_WRITE_ATTEMPTS = 3;

export async function publishRelease({ github, artifacts }) {
  const presentation = releasePresentation(artifacts);
  let release = await github.getReleaseByTag(artifacts.tag);
  let action = "verified";
  if (!release) {
    try {
      release = await github.createRelease({
        tag_name: artifacts.tag,
        name: presentation.title,
        body: presentation.body,
        draft: false,
        prerelease: presentation.prerelease,
        make_latest: "false",
      });
      action = "created";
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 409 && error.status !== 422)) throw error;
      release = await github.getReleaseByTag(artifacts.tag);
      if (!release) throw error;
    }
  }
  assertReleaseIdentity(release, artifacts, presentation);
  await assertNoUnexpectedAssets(release, artifacts);
  for (const asset of artifacts.assets) {
    let current = findAsset(release, asset.name);
    if (current) {
      await verifyPublicAsset(github, current, asset);
      continue;
    }
    try {
      await github.uploadAsset(release, asset);
      action = action === "created" ? action : "repaired";
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 409 && error.status !== 422)) throw error;
      release = await github.getReleaseByTag(artifacts.tag);
      current = findAsset(release, asset.name);
      if (!current) throw error;
      await verifyPublicAsset(github, current, asset);
      continue;
    }
    release = await github.getReleaseByTag(artifacts.tag);
    if (!release) throw new ContractError("RELEASE_DISAPPEARED", `Release ${artifacts.tag} disappeared after asset upload.`);
    assertReleaseIdentity(release, artifacts, presentation);
    await assertNoUnexpectedAssets(release, artifacts);
  }
  release = await github.getReleaseByTag(artifacts.tag);
  assertReleaseIdentity(release, artifacts, presentation);
  await assertNoUnexpectedAssets(release, artifacts);
  const bytesByName = new Map();
  for (const expected of artifacts.assets) {
    const current = findAsset(release, expected.name);
    if (!current) throw new ContractError("RELEASE_ASSET_MISSING", `Release ${artifacts.tag} is missing ${expected.name}.`);
    bytesByName.set(expected.name, await verifyPublicAsset(github, current, expected));
  }
  const metadata = JSON.parse(bytesByName.get(RELEASE_METADATA_ASSET).toString("utf8"));
  validateReleaseMetadata(metadata, artifacts);
  return { release, entry: catalogEntryFromRelease(artifacts, bytesByName), artifacts, action };
}

export async function synchronizeCatalog({ github, branch = "main", releases = [], loadArtifacts, wait = delay }) {
  if (typeof loadArtifacts !== "function") throw new ContractError("CATALOG_SOURCE_REQUIRED", "Catalog synchronization requires a validated source loader for every release tag.");
  for (let attempt = 1; attempt <= MAX_CATALOG_WRITE_ATTEMPTS; attempt += 1) {
    const currentFile = await github.getCatalog(branch);
    const currentCatalog = currentFile ? parseCatalog(currentFile.bytes) : { schemaVersion: CATALOG_SCHEMA, entries: [] };
    const allReleases = await github.listReleases();
    const releaseByTag = new Map();
    for (const release of [...allReleases, ...releases]) {
      const tag = release?.tag_name;
      if (typeof tag !== "string" || (!tag.startsWith("workflow-") && !tag.startsWith("system-skills-"))) continue;
      if (!parseReleaseTag(tag, WORKFLOW_IDS)) throw new ContractError("RELEASE_TAG_INVALID", `Managed release tag ${tag} is malformed; catalog update stopped.`);
      const previous = releaseByTag.get(tag);
      if (previous && previous.id !== release.id) throw new ContractError("RELEASE_TAG_DUPLICATE", `Multiple GitHub Releases claim tag ${tag}.`);
      releaseByTag.set(tag, release);
    }

    for (const entry of currentCatalog.entries) {
      if (releaseByTag.has(entry.tag)) continue;
      const missing = await github.getReleaseByTag(entry.tag);
      if (!missing) throw new ContractError("CATALOG_RELEASE_MISSING", `Existing catalog entry ${entry.tag} has no matching Release; no entry was removed.`);
      releaseByTag.set(entry.tag, missing);
    }

    const entries = [];
    for (const [tag, release] of [...releaseByTag.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (release.draft === true) throw new ContractError("RELEASE_DRAFT_INVALID", `Release ${tag} is still a draft and cannot be cataloged.`);
      const artifacts = await loadArtifacts(tag);
      assertReleaseIdentity(release, artifacts, releasePresentation(artifacts));
      await assertNoUnexpectedAssets(release, artifacts);
      const bytesByName = new Map();
      for (const expected of artifacts.assets) {
        const asset = findAsset(release, expected.name);
        if (!asset) throw new ContractError("RELEASE_ASSET_MISSING", `Release ${tag} is missing ${expected.name}; catalog update stopped.`);
        bytesByName.set(expected.name, await verifyPublicAsset(github, asset, expected));
      }
      entries.push(catalogEntryFromRelease(artifacts, bytesByName));
    }

    const entriesByTag = new Map(entries.map((entry) => [entry.tag, entry]));
    for (const existing of currentCatalog.entries) {
      const actual = entriesByTag.get(existing.tag);
      if (!actual || !sameJson(actual, existing)) throw new ContractError("CATALOG_ENTRY_CONFLICT", `Existing catalog entry ${existing.tag} conflicts with its immutable Release; no data was changed.`);
    }
    const updated = { schemaVersion: CATALOG_SCHEMA, entries: sortCatalogEntries(entries, compareSemVer) };
    const bytes = catalogBytes(updated);
    if (currentFile && currentFile.bytes.equals(bytes)) return { action: "unchanged", catalog: updated, attempts: attempt - 1 };

    try {
      await github.putCatalog({ branch, sha: currentFile?.sha, bytes });
      return { action: "updated", catalog: updated, attempts: attempt };
    } catch (error) {
      if (!(error instanceof GitHubApiError) || (error.status !== 409 && error.status !== 422) || attempt === MAX_CATALOG_WRITE_ATTEMPTS) {
        throw error;
      }
      await wait(100 * (2 ** (attempt - 1)));
    }
  }
  throw new ContractError("CATALOG_CONCURRENCY_EXHAUSTED", "Catalog compare-and-swap failed after three bounded attempts.");
}

export function validateReleaseObject(release, artifacts) {
  assertReleaseIdentity(release, artifacts, releasePresentation(artifacts));
  return true;
}

function assertReleaseIdentity(release, artifacts, presentation) {
  if (!release || release.tag_name !== artifacts.tag || release.name !== presentation.title || release.body !== presentation.body
    || release.draft !== false || release.prerelease !== presentation.prerelease) {
    throw new ContractError("RELEASE_IDENTITY_CONFLICT", `Existing Release metadata for ${artifacts.tag} differs from its validated source; it was not changed.`);
  }
}

async function assertNoUnexpectedAssets(release, artifacts) {
  if (!Array.isArray(release.assets)) throw new ContractError("RELEASE_ASSETS_INVALID", `Release ${artifacts.tag} has no valid asset inventory.`);
  const names = release.assets.map((asset) => asset?.name);
  if (new Set(names).size !== names.length) throw new ContractError("RELEASE_ASSET_DUPLICATE", `Release ${artifacts.tag} contains duplicate asset names.`);
  const expected = new Set(artifacts.assets.map((asset) => asset.name));
  const unexpected = names.filter((name) => !expected.has(name));
  if (unexpected.length) throw new ContractError("RELEASE_ASSET_UNEXPECTED", `Release ${artifacts.tag} contains unexpected asset(s): ${unexpected.join(", ")}; none were removed.`);
}

function findAsset(release, name) {
  return release?.assets?.find((asset) => asset.name === name);
}

async function verifyPublicAsset(github, current, expected) {
  if (current.size !== expected.size || current.browser_download_url !== expected.url) {
    throw new ContractError("RELEASE_ASSET_METADATA_CONFLICT", `Release asset ${expected.name} metadata differs; it was not replaced.`);
  }
  const bytes = await github.downloadPublicAsset(current.browser_download_url);
  if (bytes.byteLength !== expected.size || !bytes.equals(expected.bytes)) {
    throw new ContractError("RELEASE_ASSET_BYTES_CONFLICT", `Public read-back for ${expected.name} does not match its exact source bytes.`);
  }
  return bytes;
}

function parseCatalog(bytes) {
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new ContractError("CATALOG_JSON_INVALID", "Existing catalog.json is not valid UTF-8 JSON; it was not overwritten.");
  }
  validateCatalog(value);
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
