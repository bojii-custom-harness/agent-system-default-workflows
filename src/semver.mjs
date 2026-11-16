import { ContractError } from "./errors.mjs";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemVer(value) {
  if (typeof value !== "string") return undefined;
  const match = SEMVER.exec(value);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return undefined;
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease, build: match[5]?.split(".") ?? [] };
}

export function assertSemVer(value, label = "version") {
  if (!parseSemVer(value)) throw new ContractError("INVALID_SEMVER", `${label} must be a valid SemVer 2.0.0 value.`);
  return value;
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  if (!a || !b) throw new ContractError("INVALID_SEMVER", "Cannot compare invalid SemVer values.");
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function channelFor(version) {
  const parsed = parseSemVer(version);
  if (!parsed) throw new ContractError("INVALID_SEMVER", "Release version must be valid SemVer.");
  return parsed.prerelease.length === 0 ? "stable" : "dev";
}

export function releaseTag(kind, id, version) {
  assertSemVer(version);
  if (kind === "system-skills") {
    if (id !== "system-skills") throw new ContractError("INVALID_RELEASE_ID", "System Skills release ID must be system-skills.");
    return `system-skills-${version}`;
  }
  if (kind !== "workflow" || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) {
    throw new ContractError("INVALID_RELEASE_ID", "Workflow release ID is invalid.");
  }
  return `${id}-${version}`;
}

export function parseReleaseTag(tag, workflowIds) {
  if (typeof tag !== "string") return undefined;
  if (tag.startsWith("system-skills-")) {
    const version = tag.slice("system-skills-".length);
    if (!parseSemVer(version) || releaseTag("system-skills", "system-skills", version) !== tag) return undefined;
    return { kind: "system-skills", id: "system-skills", version, channel: channelFor(version), tag };
  }
  for (const id of [...workflowIds].sort((a, b) => b.length - a.length)) {
    const prefix = `${id}-`;
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (!parseSemVer(version) || releaseTag("workflow", id, version) !== tag) return undefined;
    return { kind: "workflow", id, version, channel: channelFor(version), tag };
  }
  return undefined;
}

export function assertReleaseTag(tag, workflowIds) {
  const parsed = parseReleaseTag(tag, workflowIds);
  if (!parsed) throw new ContractError("INVALID_RELEASE_TAG", `Tag ${String(tag)} does not match an approved product ID and SemVer.`);
  return parsed;
}
