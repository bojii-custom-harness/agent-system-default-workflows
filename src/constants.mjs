export const REPOSITORY = "bojii-custom-harness/agent-system-default-workflows";
export const CONTENT_VERSION = "2.0.0";
export const CLI_VERSION = "1.0.0";
export const WORKFLOW_IDS = Object.freeze([
  "workflow-agent-writer",
  "workflow-command-writer",
  "workflow-file-preview-editor",
  "workflow-generator",
  "workflow-node-prompt-writer",
  "workflow-plugin-finder",
  "workflow-skill-creator",
  "workflow-skill-finder",
  "workflow-skill-writer",
  "workflow-tool-writer",
  "workflow-updater",
]);
export const SYSTEM_SKILL_IDS = Object.freeze([
  "plugin-discovery",
  "workflow-assembly",
  "resource-authoring",
]);
export const WORKFLOW_SCHEMA_VERSION = "agent-system.workflow.v3";
export const WORKFLOW_MANIFEST_SCHEMA = "agent-system.default-workflows-manifest.v1";
export const SKILLS_MANIFEST_SCHEMA = "agent-system.system-skills-manifest.v1";
export const SKILLS_BUNDLE_SCHEMA = "agent-system.system-skills-bundle.v1";
export const SOURCE_MANIFEST_SCHEMA = "agent-system.default-workflow-source.v1";
export const SOURCE_BASELINE_SCHEMA = "agent-system.default-workflow-source-baseline.v1";
export const SOURCE_BASELINE_CANONICAL_SHA256 = "a514102f95059c9a05ad47668f492c14690a35578cde7a283911c23b50feecab";
export const CATALOG_SCHEMA = "agent-system.default-workflow-catalog.v1";
export const RELEASE_METADATA_SCHEMA = "agent-system.default-workflow-release.v1";
export const RELEASE_METADATA_ASSET = "release-metadata.json";

export const UPGRADE_HASHES = Object.freeze({
  "1.0.8": Object.freeze({
    "plugin-discovery": "fd56a9c716e3d18ca7702c147068778622d6f7be6afb98548b0d33466726d5ed",
    "workflow-assembly": "38aeae53d9b4ba116c32c0a7572ca7c544cc6876a216ca462af6a78753b86d2c",
    "resource-authoring": "525f245a29a8dcdc421a7c51551ee2817c05b901b82d2031493f24a2dd543e97",
  }),
  "1.0.9": Object.freeze({
    "plugin-discovery": "fd56a9c716e3d18ca7702c147068778622d6f7be6afb98548b0d33466726d5ed",
    "workflow-assembly": "5c10c5880590f76e416f907bcf14ba73aeff6e3e9fb6852993e6a58f5e92a02c",
    "resource-authoring": "525f245a29a8dcdc421a7c51551ee2817c05b901b82d2031493f24a2dd543e97",
  }),
});

export const WORKFLOW_ROOT_KEYS = Object.freeze([
  "schemaVersion", "id", "uuid", "version", "generatedBySystemVersion", "name", "description",
  "scope", "project", "nodes", "edges", "variables", "metadata", "createdAt", "updatedAt",
]);
export const WORKFLOW_NODE_TYPES = Object.freeze([
  "resource.agent", "resource.command", "resource.skill", "resource.tool", "resource.mcp", "resource.plugin",
  "action.prompt", "action.command", "action.restart", "trigger.manual",
]);
export const WORKFLOW_RESOURCE_DATA_KEYS = Object.freeze([
  "mode", "name", "resourceId", "scope", "purpose", "pluginName", "toolNames", "content", "filename",
  "files", "artifact", "config", "extension", "install", "links",
]);
