import { GitHubApiError } from "./errors.mjs";
import { REPOSITORY } from "./constants.mjs";

export class GitHubClient {
  constructor({ token, repository = REPOSITORY, apiUrl = "https://api.github.com", fetchImpl = fetch, timeoutMs = 30000 }) {
    if (!token) throw new Error("GITHUB_TOKEN is required for Release and catalog writes.");
    if (repository !== REPOSITORY) throw new Error(`Publishing is restricted to ${REPOSITORY}.`);
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async getReleaseByTag(tag) {
    const route = `/repos/${this.repository}/releases/tags/${encodeURIComponent(tag)}`;
    try {
      return await this.request("GET", route);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  createRelease(body) {
    return this.request("POST", `/repos/${this.repository}/releases`, { body });
  }

  async listReleases() {
    const releases = [];
    for (let page = 1; page <= 1000; page += 1) {
      const result = await this.request("GET", `/repos/${this.repository}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(result)) throw new Error("GitHub Releases response is not an array.");
      releases.push(...result);
      if (result.length < 100) return releases;
    }
    throw new Error("GitHub Releases pagination exceeded the bounded page limit.");
  }

  uploadAsset(release, asset) {
    const uploadUrl = String(release.upload_url ?? "").replace(/\{\?.*$/, "");
    if (!uploadUrl.startsWith("https://uploads.github.com/")) throw new Error("GitHub returned an invalid Release upload URL.");
    const url = new URL(uploadUrl);
    url.searchParams.set("name", asset.name);
    return this.rawRequest("POST", url.toString(), {
      headers: { "Content-Type": "application/octet-stream" },
      body: asset.bytes,
      routeForError: `/releases/${release.id}/assets?name=${asset.name}`,
    });
  }

  async downloadPublicAsset(url) {
    const parsed = new URL(url);
    if (parsed.hostname !== "github.com" || parsed.protocol !== "https:") throw new Error("Release asset URL is not an approved public GitHub URL.");
    const response = await this.fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) throw new GitHubApiError(response.status, "GET", "/releases/download/<asset>");
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 20_000_000) {
      await response.body?.cancel();
      throw new Error("Release asset exceeded the 20 MB validation limit.");
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let byteLength = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        byteLength += value.byteLength;
        if (byteLength > 20_000_000) {
          await reader.cancel();
          throw new Error("Release asset exceeded the 20 MB validation limit.");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, byteLength);
  }

  async getCatalog(branch) {
    const route = `/repos/${this.repository}/contents/catalog.json?ref=${encodeURIComponent(branch)}`;
    try {
      const file = await this.request("GET", route);
      if (file.path !== "catalog.json" || file.encoding !== "base64" || typeof file.content !== "string" || typeof file.sha !== "string") {
        throw new Error("GitHub catalog Contents response is malformed.");
      }
      return { sha: file.sha, bytes: Buffer.from(file.content.replace(/\n/g, ""), "base64") };
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  putCatalog({ branch, sha, bytes }) {
    const body = {
      message: "chore: update verified Default Workflow release catalog",
      content: Buffer.from(bytes).toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    };
    return this.request("PUT", `/repos/${this.repository}/contents/catalog.json`, { body });
  }

  async request(method, route, options = {}) {
    const url = route.startsWith("https://") ? route : `${this.apiUrl}${route}`;
    return this.rawRequest(method, url, { ...options, routeForError: options.routeForError ?? route, json: true });
  }

  async rawRequest(method, url, options = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers ?? {}),
    };
    if (options.json && options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : options.json ? JSON.stringify(options.body) : options.body,
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) throw new GitHubApiError(response.status, method, options.routeForError ?? "/<upload>");
    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub API ${method} returned invalid JSON for ${options.routeForError ?? "/<response>"}.`);
    }
  }
}
