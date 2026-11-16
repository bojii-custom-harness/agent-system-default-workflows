import { GitHubApiError } from "../src/errors.mjs";

export class MemoryGitHub {
  constructor() {
    this.releases = new Map();
    this.assetsByUrl = new Map();
    this.catalogFile = undefined;
    this.createdCount = 0;
    this.uploadCount = 0;
    this.downloadCount = 0;
    this.catalogPutCount = 0;
    this.beforeCreateRelease = undefined;
    this.beforeUploadAsset = undefined;
    this.beforeCatalogPut = undefined;
    this.catalogWriteFailures = [];
  }

  async getReleaseByTag(tag) {
    const release = this.releases.get(tag);
    return release ? copyRelease(release) : null;
  }

  async createRelease(body) {
    if (this.beforeCreateRelease) {
      const hook = this.beforeCreateRelease;
      this.beforeCreateRelease = undefined;
      await hook(this, body);
    }
    if (this.releases.has(body.tag_name)) throw new GitHubApiError(422, "POST", "/releases");
    const release = {
      id: ++this.createdCount,
      tag_name: body.tag_name,
      name: body.name,
      body: body.body,
      draft: body.draft,
      prerelease: body.prerelease,
      upload_url: `https://uploads.github.com/repos/bojii-custom-harness/agent-system-default-workflows/releases/${this.createdCount}/assets{?name,label}`,
      assets: [],
    };
    this.releases.set(body.tag_name, release);
    return copyRelease(release);
  }

  async uploadAsset(release, asset) {
    if (this.beforeUploadAsset) {
      const hook = this.beforeUploadAsset;
      this.beforeUploadAsset = undefined;
      await hook(this, release, asset);
    }
    const current = this.releases.get(release.tag_name);
    if (!current) throw new GitHubApiError(404, "POST", "/releases/assets");
    if (current.assets.some((item) => item.name === asset.name)) throw new GitHubApiError(422, "POST", "/releases/assets");
    const record = { name: asset.name, size: asset.size, browser_download_url: asset.url };
    current.assets.push(record);
    this.assetsByUrl.set(asset.url, Buffer.from(asset.bytes));
    this.uploadCount += 1;
    return record;
  }

  async downloadPublicAsset(url) {
    this.downloadCount += 1;
    const bytes = this.assetsByUrl.get(url);
    if (!bytes) throw new GitHubApiError(404, "GET", "/releases/download/<asset>");
    return Buffer.from(bytes);
  }

  async listReleases() {
    return [...this.releases.values()].map(copyRelease);
  }

  async getCatalog(branch) {
    if (branch !== "main") throw new Error("Test catalog branch must be main.");
    return this.catalogFile ? { sha: this.catalogFile.sha, bytes: Buffer.from(this.catalogFile.bytes) } : null;
  }

  async putCatalog({ branch, sha, bytes }) {
    if (branch !== "main") throw new Error("Test catalog branch must be main.");
    this.catalogPutCount += 1;
    if (this.beforeCatalogPut) {
      const hook = this.beforeCatalogPut;
      this.beforeCatalogPut = undefined;
      await hook(this, { sha, bytes: Buffer.from(bytes) });
    }
    if (this.catalogWriteFailures.length) {
      const status = this.catalogWriteFailures.shift();
      throw new GitHubApiError(status, "PUT", "/contents/catalog.json");
    }
    if ((this.catalogFile?.sha ?? undefined) !== sha) throw new GitHubApiError(409, "PUT", "/contents/catalog.json");
    this.catalogFile = { sha: `catalog-${this.catalogPutCount}`, bytes: Buffer.from(bytes) };
    return { content: { path: "catalog.json", sha: this.catalogFile.sha } };
  }

  removeAsset(tag, name) {
    const release = this.releases.get(tag);
    const asset = release?.assets.find((item) => item.name === name);
    if (asset) {
      release.assets = release.assets.filter((item) => item !== asset);
      this.assetsByUrl.delete(asset.browser_download_url);
    }
  }

  replaceAssetBytes(url, bytes) {
    this.assetsByUrl.set(url, Buffer.from(bytes));
  }
}

function copyRelease(release) {
  return { ...release, assets: release.assets.map((asset) => ({ ...asset })) };
}
