import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.mjs";
import { ContractError } from "../src/errors.mjs";
import { DEFAULT_CATALOG_URL, downloadRelease, fetchCatalog } from "../src/default-workflow-source.mjs";
import { REPOSITORY, SYSTEM_SKILL_IDS, UPGRADE_HASHES } from "../src/constants.mjs";

const WORKFLOW_ID = "workflow-generator";
const VERSION = "2.3.0";
const SOURCE_COMMIT = "6595dd9305f74a5aabe8b6490dbca1b558645f1f";

test("catalog command downloads the CLI-owned catalog, validates it, and writes its exact bytes", async () => {
  const fixture = createFixture();
  const directory = await mkdtemp(join(tmpdir(), "default-workflows-cli-catalog-"));
  const outputPath = join(directory, "catalog.json");
  const requests = [];
  try {
    await runCli(["catalog", "--output", outputPath], {
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return new Response(fixture.catalogBytes, { status: 200 });
      },
      retryDelayImpl: async () => undefined,
    });

    assert.deepEqual(requests.map(({ url }) => url), [DEFAULT_CATALOG_URL]);
    assert.equal(requests[0].options.redirect, "manual");
    assert.deepEqual(await readFile(outputPath), fixture.catalogBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download command selects the exact catalog release and emits verified asset bytes", async () => {
  const fixture = createFixture();
  const directory = await mkdtemp(join(tmpdir(), "default-workflows-cli-download-"));
  const catalogPath = join(directory, "catalog.json");
  const outputPath = join(directory, "workflow.json");
  const metadataPath = join(directory, "metadata.json");
  const requests = [];
  try {
    await writeFile(catalogPath, fixture.catalogBytes);
    await runCli([
      "download", WORKFLOW_ID, VERSION,
      "--catalog", catalogPath,
      "--output", outputPath,
      "--metadata-output", metadataPath,
    ], {
      fetchImpl: async (url, options) => {
        const requested = String(url);
        requests.push(requested);
        const bytes = fixture.assets.get(requested);
        return bytes
          ? new Response(bytes, { status: 200 })
          : new Response("missing", { status: 404 });
      },
      retryDelayImpl: async () => undefined,
    });

    assert.equal(requests.length, 2);
    assert(requests.includes(fixture.productAsset.url));
    assert(requests.includes(fixture.metadataAsset.url));
    assert.deepEqual(await readFile(outputPath), fixture.productBytes);
    assert.deepEqual(await readFile(metadataPath), fixture.metadataBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("download command verifies the complete System Skills bundle", async () => {
  const fixture = createSystemSkillsFixture();
  const result = await downloadRelease({
    catalog: fixture.catalog,
    id: "system-skills",
    version: VERSION,
    fetchImpl: async (url) => new Response(fixture.assets.get(String(url)), { status: 200 }),
    retryDelayImpl: async () => undefined,
  });

  assert.deepEqual(result.bytes, fixture.productBytes);
  assert.equal(result.product.skills.length, SYSTEM_SKILL_IDS.length);
  assert.equal(result.metadata.version, VERSION);
});

test("release downloads fail closed on hash, metadata identity, redirects, and oversized bodies", async (t) => {
  const fixture = createFixture();

  await t.test("rejects a payload with the wrong hash", async () => {
    await assert.rejects(downloadRelease({
      catalog: fixture.catalog,
      id: WORKFLOW_ID,
      version: VERSION,
      fetchImpl: async (url) => new Response(
        String(url) === fixture.metadataAsset.url ? fixture.metadataBytes : Buffer.from("{}"),
        { status: 200 },
      ),
      retryDelayImpl: async () => undefined,
    }), (error) => error instanceof ContractError && error.code === "SOURCE_SIZE_MISMATCH");
  });

  await t.test("rejects metadata that identifies another release", async () => {
    const wrongMetadata = Buffer.from(JSON.stringify({ ...fixture.metadata, version: "9.9.9" }));
    const wrongCatalog = structuredClone(fixture.catalog);
    const entry = wrongCatalog.entries[0];
    const wrongMetadataAsset = entry.assets.find((asset) => asset.name === "release-metadata.json");
    wrongMetadataAsset.size = wrongMetadata.byteLength;
    wrongMetadataAsset.sha256 = sha256(wrongMetadata);
    const assetBodies = new Map(fixture.assets);
    assetBodies.set(wrongMetadataAsset.url, wrongMetadata);
    await assert.rejects(downloadRelease({
      catalog: wrongCatalog,
      id: WORKFLOW_ID,
      version: VERSION,
      fetchImpl: async (url) => new Response(assetBodies.get(String(url)), { status: 200 }),
      retryDelayImpl: async () => undefined,
    }), (error) => error instanceof ContractError && error.code === "RELEASE_METADATA_MISMATCH");
  });

  await t.test("rejects an unapproved redirect before contacting its destination", async () => {
    const requests = [];
    await assert.rejects(fetchCatalog({
      fetchImpl: async (url) => {
        requests.push(String(url));
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/private" },
        });
      },
      retryDelayImpl: async () => undefined,
    }), (error) => error instanceof ContractError && error.code === "SOURCE_REDIRECT_FORBIDDEN");
    assert.deepEqual(requests, [DEFAULT_CATALOG_URL]);
  });

  await t.test("rejects a catalog asset over the configured byte limit", async () => {
    await assert.rejects(fetchCatalog({
      fetchImpl: async () => new Response(new Uint8Array(0), {
        status: 200,
        headers: { "content-length": "1000001" },
      }),
      retryDelayImpl: async () => undefined,
    }), (error) => error instanceof ContractError && error.code === "SOURCE_ASSET_TOO_LARGE");
  });
});

test("catalog downloads use bounded retries for temporary HTTP failures", async () => {
  const fixture = createFixture();
  let attempts = 0;
  const delays = [];
  const result = await fetchCatalog({
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1
        ? new Response("temporary", { status: 503 })
        : new Response(fixture.catalogBytes, { status: 200 });
    },
    retryDelayImpl: async (delay) => delays.push(delay),
  });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
  assert.equal(result.sha256, sha256(fixture.catalogBytes));
});

function createFixture() {
  const tag = `${WORKFLOW_ID}-${VERSION}`;
  const assetBase = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  const product = {
    schemaVersion: "agent-system.workflow.v3",
    id: WORKFLOW_ID,
    uuid: "00000000-0000-4000-8000-000000000001",
    version: VERSION,
  };
  const productBytes = Buffer.from(JSON.stringify(product));
  const productAsset = {
    name: `workflow-${WORKFLOW_ID}-${VERSION}.json`,
    url: `${assetBase}workflow-${WORKFLOW_ID}-${VERSION}.json`,
    size: productBytes.byteLength,
    sha256: sha256(productBytes),
  };
  const metadataAsset = {
    name: "release-metadata.json",
    url: `${assetBase}release-metadata.json`,
    size: 1,
    sha256: "0".repeat(64),
  };
  const entry = {
    kind: "workflow",
    id: WORKFLOW_ID,
    version: VERSION,
    channel: "stable",
    tag,
    sourceCommit: SOURCE_COMMIT,
    assets: [productAsset, metadataAsset],
  };
  const metadata = {
    schemaVersion: "agent-system.default-workflow-release.v1",
    kind: "workflow",
    id: WORKFLOW_ID,
    version: VERSION,
    channel: "stable",
    tag,
    sourceCommit: SOURCE_COMMIT,
    asset: productAsset,
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  metadataAsset.size = metadataBytes.byteLength;
  metadataAsset.sha256 = sha256(metadataBytes);
  const catalog = { schemaVersion: "agent-system.default-workflow-catalog.v1", entries: [entry] };
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`);
  return {
    catalog,
    catalogBytes,
    productBytes,
    productAsset,
    metadata,
    metadataBytes,
    metadataAsset,
    assets: new Map([[productAsset.url, productBytes], [metadataAsset.url, metadataBytes]]),
  };
}

function createSystemSkillsFixture() {
  const version = VERSION;
  const tag = `system-skills-${version}`;
  const sourceCommit = SOURCE_COMMIT;
  const sourceVersion = "1.0.9";
  const skillRecords = SYSTEM_SKILL_IDS.map((id) => {
    const content = `# ${id}\n`;
    const contentBytes = Buffer.from(content);
    return {
      id,
      path: `${id}/SKILL.md`,
      size: contentBytes.byteLength,
      sha256: sha256(contentBytes),
      content,
    };
  });
  const manifest = {
    schemaVersion: "agent-system.system-skills-manifest.v1",
    version,
    sourceVersion,
    sourceCommit,
    skills: [...SYSTEM_SKILL_IDS],
    upgradesFrom: Object.fromEntries(
      Object.entries(UPGRADE_HASHES).map(([oldVersion, hashes]) => [
        oldVersion,
        Object.fromEntries(Object.entries(hashes).map(([id, digest]) => [id, { "SKILL.md": digest }])),
      ]),
    ),
  };
  const product = {
    schemaVersion: "agent-system.system-skills-bundle.v1",
    version,
    sourceVersion,
    sourceCommit,
    manifest,
    skills: skillRecords,
  };
  const productBytes = Buffer.from(JSON.stringify(product));
  const assetBase = `https://github.com/${REPOSITORY}/releases/download/${tag}/`;
  const productAsset = {
    name: `system-skills-${version}.json`,
    url: `${assetBase}system-skills-${version}.json`,
    size: productBytes.byteLength,
    sha256: sha256(productBytes),
  };
  const metadataAsset = {
    name: "release-metadata.json",
    url: `${assetBase}release-metadata.json`,
    size: 0,
    sha256: "0".repeat(64),
  };
  const entry = {
    kind: "system-skills",
    id: "system-skills",
    version,
    channel: "stable",
    tag,
    sourceCommit,
    assets: [productAsset, metadataAsset],
  };
  const metadata = {
    schemaVersion: "agent-system.default-workflow-release.v1",
    kind: "system-skills",
    id: "system-skills",
    version,
    channel: "stable",
    tag,
    sourceCommit,
    asset: productAsset,
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata));
  metadataAsset.size = metadataBytes.byteLength;
  metadataAsset.sha256 = sha256(metadataBytes);
  return {
    catalog: { schemaVersion: "agent-system.default-workflow-catalog.v1", entries: [entry] },
    productBytes,
    assets: new Map([[productAsset.url, productBytes], [metadataAsset.url, metadataBytes]]),
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
