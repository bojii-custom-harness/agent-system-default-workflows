---
name: resource-authoring
description: Produce complete Agent, Skill, Tool, Plugin, Command, or Subagent content for an Agent System Workflow. Use when creating or modifying a runtime resource.
---

# Resource Authoring

This product-managed guide is version 2.0.0. It is available only to the Default Workflow. Produce the complete candidate content; backend validation must not fill in content or permissions.

## Resource rules

- **New managed Agent:** use native V2 frontmatter. `node.data.name` is the sole identity; do not emit a frontmatter `name`, legacy `permission`/`tools`/`skills`, or ignored `temperature`, `top_p`, or `variant` fields. Declare an ordered `permissions` array whose rules each contain exactly `action`, `resource`, and `effect`. Put `{ action: "*", resource: "*", effect: "deny" }` first, allow only graph-bound direct capabilities, and allow `subagent` only for exact direct child Agent names after denying all other children. Never add or widen a grant to make validation pass.
- **Existing Custom Agent:** Workflow Updater must preserve the target's existing V1 or V2 permission dialect; do not auto-convert V1 content. Prompt Writer may change only the body and must preserve all target frontmatter byte-for-byte, including V1 fields or ordered V2 rules.
- **Skill:** include valid frontmatter (`name`, `description`) and actionable instructions. Describe when to use the Skill and a checkable completion condition. Avoid claiming tools or credentials that the current Project Context does not provide.
- **Tool:** include a complete runtime schema and implementation or a precise verified reference. Bound inputs, outputs, side effects and errors. Never claim an unavailable external connection.
- **Plugin:** include complete installable source/configuration and declare only verified contributions. A broad all-Skills permission is valid only when the candidate explicitly expresses that existing authorization intent.
- **Command:** include valid frontmatter, concise invocation guidance, required inputs and a deterministic output contract. A Command is a Resource and is not the Workflow Entry Command.
- **Subagent:** define one delegated role, bounded input/output and only the permissions it needs. The delegation must be reachable and acyclic.

Prefer catalog reuse over duplication. Keep content and authorization consistent with Workflow Assembly. Do not put secrets in candidate content; report a missing Credential Reference as a blocker. A candidate remains uninstalled and unpublished until the user confirms it.
