---
name: workflow-assembly
description: Build or update an Agent System Workflow. Use when generating or changing Workflow JSON, graph nodes, resources, bindings, delegation, or permissions.
---

# Workflow Assembly

This product-managed guide is version 2.0.0. It is available only to the Default Workflow. Treat the current Project Context and the complete request as authoritative; never infer a capability from a name alone.

## Produce the complete candidate

1. Select the smallest set of Agent, Skill, Tool, MCP and Plugin resources that satisfies the request. Reuse a verified catalog Resource as a Reference Resource Node when possible. Create a complete Managed Resource Node only when no suitable Resource exists.
2. Produce all requested Workflow JSON and graph structure. Represent each selected capability with its exact Resource node identity and a direct Binding to its consuming Agent; that Agent's permission must match the Binding. Every Resource reference has a valid identity and scope.
3. Keep delegation as a reachable acyclic graph. Give each newly authored Agent one clear role and only the minimum necessary capabilities. New Agents use native V2 frontmatter with node-derived identity (`node.data.name`, never a frontmatter `name`) and ordered `permissions` rules containing exactly `action`, `resource`, and `effect`.
4. Start each new Agent policy with `{ action: "*", resource: "*", effect: "deny" }`. Every allowed or asked capability must match a direct graph binding. For the fixed diagnostic Tool, include exactly one `resource.tool` reference node named `error_log_recent` with `scope: global`, bind it to every generated managed Agent, and include the exact `{ action: "error_log_recent", resource: "*", effect: "allow" }` rule in each Agent. This fixed node is not an inventory match; never create a project-scoped copy or duplicate. Use `action: subagent` rules to deny every unspecified child before allowing only exact direct child names. Do not infer, add, widen, reorder or repair authorization.
5. For MCP, select only tools from an already connected and verified server. Explicitly list a non-empty exact `toolNames` subset on every MCP selection; omission or an empty list is invalid and must never be treated as permission for `${server}_*`. Use one exact native V2 action for each selected MCP tool and `resource: "*"`; never authorize a wildcard MCP namespace. Report missing connection or credential references as a capability gap; never fabricate a working integration or include secret values.
6. Keep reference Resources as references. A content change to an existing runtime Resource uses a new name and Runtime Resource Identity; preserve the old Resource.
7. Return the consumer's required envelope: complete Workflow JSON for generation, typed operations for updates, and the existing frozen contract for file preview. Do not save, install or publish before user confirmation.

## Validate before returning

Check that every referenced Resource exists in the current inventory or is fully defined as a candidate; all nodes, edges, bindings and native V2 permissions are structurally valid; all permissions are explicit and consistent; no unrelated graph content changed; and no secret value is present. If a required fact is missing, return a bounded validation or capability error rather than a plausible guess.

When updating an existing Custom Agent, keep its target dialect: Updater must not convert V1 `name`/`permission`/`tools` content into V2. Prompt Writer changes only the body and preserves the entire frontmatter byte-for-byte for both V1 and V2 targets.
