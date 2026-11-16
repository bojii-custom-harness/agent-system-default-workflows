import { ContractError } from "../errors.mjs";
import { WORKFLOW_IDS, WORKFLOW_NODE_TYPES, WORKFLOW_RESOURCE_DATA_KEYS, WORKFLOW_ROOT_KEYS, WORKFLOW_SCHEMA_VERSION } from "../constants.mjs";
import { parseSemVer } from "../semver.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const EDGE_KINDS = new Set(["capability", "delegation", "primary-link"]);
const NODE_KEYS = new Set(["id", "type", "position", "data"]);
const EDGE_KEYS = new Set(["id", "source", "target", "kind", "sourceHandle", "targetHandle"]);
const RESOURCE_TYPES = new Set(WORKFLOW_NODE_TYPES.filter((type) => type.startsWith("resource.")));

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, allowed, path) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new ContractError("WORKFLOW_UNKNOWN_FIELD", `${path} contains unsupported field(s): ${unexpected.join(", ")}.`);
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}

export function validateWorkflow(value, expectedId) {
  if (!record(value)) throw new ContractError("WORKFLOW_OBJECT_REQUIRED", "Workflow definition must be a JSON object.");
  exactKeys(value, new Set(WORKFLOW_ROOT_KEYS), "Workflow root");
  const required = ["schemaVersion", "id", "uuid", "version", "name", "scope", "nodes", "edges", "createdAt", "updatedAt"];
  if (required.some((key) => !Object.hasOwn(value, key))) throw new ContractError("WORKFLOW_REQUIRED_FIELD", "Workflow is missing a required root field.");
  if (value.schemaVersion !== WORKFLOW_SCHEMA_VERSION) throw new ContractError("WORKFLOW_SCHEMA_INVALID", "Workflow schemaVersion must be agent-system.workflow.v3.");
  if (!WORKFLOW_IDS.includes(value.id) || (expectedId !== undefined && value.id !== expectedId)) throw new ContractError("WORKFLOW_ID_INVALID", "Workflow ID must match the approved inventory and filename.");
  if (!UUID.test(value.uuid)) throw new ContractError("WORKFLOW_UUID_INVALID", `${value.id} must preserve a valid stable UUID.`);
  if (!parseSemVer(value.version)) throw new ContractError("WORKFLOW_VERSION_INVALID", `${value.id} must declare a valid SemVer version.`);
  if (value.generatedBySystemVersion !== undefined && (typeof value.generatedBySystemVersion !== "string" || !parseSemVer(value.generatedBySystemVersion))) {
    throw new ContractError("WORKFLOW_GENERATOR_VERSION_INVALID", `${value.id} has an invalid generatedBySystemVersion.`);
  }
  if (typeof value.name !== "string" || value.name.trim() !== value.name || value.name.length < 1 || value.name.length > 120) throw new ContractError("WORKFLOW_NAME_INVALID", `${value.id} has an invalid name.`);
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.length > 2000)) throw new ContractError("WORKFLOW_DESCRIPTION_INVALID", `${value.id} has an invalid description.`);
  if (value.scope !== "global" && value.scope !== "project") throw new ContractError("WORKFLOW_SCOPE_INVALID", `${value.id} scope must be global or project.`);
  if ((value.scope === "project") !== Object.hasOwn(value, "project")) throw new ContractError("WORKFLOW_PROJECT_SCOPE_INVALID", `${value.id} project field must match its scope.`);
  if (value.scope === "project" && (typeof value.project !== "string" || value.project.length === 0)) throw new ContractError("WORKFLOW_PROJECT_INVALID", `${value.id} project scope requires a project name.`);
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new ContractError("WORKFLOW_TIMESTAMP_INVALID", `${value.id} timestamps must be valid UTC dates and updatedAt cannot precede createdAt.`);
  }
  if (value.variables !== undefined && !record(value.variables)) throw new ContractError("WORKFLOW_VARIABLES_INVALID", `${value.id} variables must be an object.`);
  if (value.metadata !== undefined && !record(value.metadata)) throw new ContractError("WORKFLOW_METADATA_INVALID", `${value.id} metadata must be an object.`);
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 500) throw new ContractError("WORKFLOW_NODES_INVALID", `${value.id} must have 1–500 nodes.`);
  if (!Array.isArray(value.edges) || value.edges.length > 2000) throw new ContractError("WORKFLOW_EDGES_INVALID", `${value.id} must have at most 2000 edges.`);
  if (value.nodes[0]?.type !== "resource.command") throw new ContractError("WORKFLOW_ENTRY_INVALID", `${value.id} must start with its Entry Command node.`);

  const nodeIds = new Set();
  const resourceIds = new Set();
  for (const [index, node] of value.nodes.entries()) {
    const path = `${value.id}.nodes[${index}]`;
    if (!record(node)) throw new ContractError("WORKFLOW_NODE_INVALID", `${path} must be an object.`);
    exactKeys(node, NODE_KEYS, path);
    if (![...NODE_KEYS].every((key) => Object.hasOwn(node, key))) throw new ContractError("WORKFLOW_NODE_REQUIRED_FIELD", `${path} is missing a required field.`);
    if (typeof node.id !== "string" || !GRAPH_ID.test(node.id) || nodeIds.has(node.id)) throw new ContractError("WORKFLOW_NODE_ID_INVALID", `${path} has an invalid or duplicate node ID.`);
    nodeIds.add(node.id);
    if (!WORKFLOW_NODE_TYPES.includes(node.type)) throw new ContractError("WORKFLOW_NODE_TYPE_INVALID", `${path} has an unsupported node type.`);
    if (!record(node.position) || Object.keys(node.position).some((key) => key !== "x" && key !== "y") || !Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) {
      throw new ContractError("WORKFLOW_NODE_POSITION_INVALID", `${path}.position must contain finite x/y numbers only.`);
    }
    if (!record(node.data)) throw new ContractError("WORKFLOW_NODE_DATA_INVALID", `${path}.data must be an object.`);
    if (RESOURCE_TYPES.has(node.type)) {
      exactKeys(node.data, new Set(WORKFLOW_RESOURCE_DATA_KEYS), `${path}.data`);
      if (node.data.mode !== "managed" && node.data.mode !== "reference") throw new ContractError("WORKFLOW_RESOURCE_MODE_INVALID", `${path}.data.mode must be managed or reference.`);
      if (typeof node.data.name !== "string" || node.data.name.length === 0) throw new ContractError("WORKFLOW_RESOURCE_NAME_INVALID", `${path}.data.name is required.`);
      if (node.data.scope !== "global" && node.data.scope !== "project") throw new ContractError("WORKFLOW_RESOURCE_SCOPE_INVALID", `${path}.data.scope must be global or project.`);
      if (node.data.mode === "managed" && typeof node.data.content !== "string" && node.type !== "resource.mcp" && node.type !== "resource.plugin") {
        throw new ContractError("WORKFLOW_RESOURCE_CONTENT_INVALID", `${path} managed resource requires string content.`);
      }
      const identity = `${node.type}\0${node.data.scope}\0${node.data.name}`;
      if (resourceIds.has(identity)) throw new ContractError("WORKFLOW_RESOURCE_IDENTITY_DUPLICATE", `${path} duplicates a resource identity.`);
      resourceIds.add(identity);
      if (node.data.toolNames !== undefined && (!Array.isArray(node.data.toolNames) || node.data.toolNames.some((name) => typeof name !== "string" || !name))) {
        throw new ContractError("WORKFLOW_TOOL_NAMES_INVALID", `${path}.data.toolNames must be an array of non-empty names.`);
      }
    }
  }

  const edgeIds = new Set();
  const edgeSignatures = new Set();
  for (const [index, edge] of value.edges.entries()) {
    const path = `${value.id}.edges[${index}]`;
    if (!record(edge)) throw new ContractError("WORKFLOW_EDGE_INVALID", `${path} must be an object.`);
    exactKeys(edge, EDGE_KEYS, path);
    if (["id", "source", "target", "kind"].some((key) => !Object.hasOwn(edge, key))) throw new ContractError("WORKFLOW_EDGE_REQUIRED_FIELD", `${path} is missing a required field.`);
    if (typeof edge.id !== "string" || !GRAPH_ID.test(edge.id) || edgeIds.has(edge.id)) throw new ContractError("WORKFLOW_EDGE_ID_INVALID", `${path} has an invalid or duplicate edge ID.`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target) throw new ContractError("WORKFLOW_EDGE_ENDPOINT_INVALID", `${path} references a missing node or a self-edge.`);
    if (!EDGE_KINDS.has(edge.kind)) throw new ContractError("WORKFLOW_EDGE_KIND_INVALID", `${path} has an unsupported edge kind.`);
    for (const key of ["sourceHandle", "targetHandle"]) {
      if (edge[key] !== undefined && (typeof edge[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(edge[key]))) {
        throw new ContractError("WORKFLOW_EDGE_HANDLE_INVALID", `${path}.${key} is invalid.`);
      }
    }
    const signature = [edge.source, edge.target, edge.kind, edge.sourceHandle ?? "", edge.targetHandle ?? ""].join("\0");
    if (edgeSignatures.has(signature)) throw new ContractError("WORKFLOW_EDGE_DUPLICATE", `${path} duplicates a graph connection.`);
    edgeSignatures.add(signature);
  }
  return value;
}
