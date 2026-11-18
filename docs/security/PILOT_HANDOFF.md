# Pilot Handoff — Security Workflow

**Task ID:** SEC-PILOT-001
**Repository:** kpjotr/smart-light-controller-PWA
**Branch:** codex/security-workflow-pilot
**Status:** Baseline established; no application code changed.

> The framework handoff JSON Schema is currently unavailable from the framework repository. This Markdown contract is the temporary human-readable fallback and must be replaced or validated once the schema is restored.

## Planner → Coder
- **Goal:** Establish the security workflow baseline without changing application behavior.
- **Allowed files:** AGENTS.md, SECURITY_PROFILE.md, docs/security/PILOT_HANDOFF.md.
- **Applicable requirements:** CORE-LOAD-001, CORE-HANDOFF-001, CORE-REV-001, AGENT-TRUST-001, AGENT-TOOL-001.
- **Risk:** Workflow text must not be treated as a production-security claim.
- **Evidence:** Framework v1.1.0 core and agent modules read from the framework repository.
- **Open decisions:** Confirm L2 tier, environment separation, App Check/IAM/backup status, and privacy inventory.
- **Status:** PASS — documentation-only pilot.

## Coder → Reviewer
- **Changes:** Three workflow documents only; no code, configuration, dependency, rules, function, or deployment change.
- **Verification:** Confirm the branch contains exactly the declared documentation files and each approval gate is explicit.
- **Known limitation:** No machine validation because handoff_contracts.schema.json is missing.
- **Status:** READY_FOR_REVIEW.

## Reviewer → Planner / Human
- **Independence requirement:** A separate agent instance reviews this branch before it becomes a durable repository policy.
- **Review questions:**
  1. Does the policy preserve the user's manual FireFlow release authority?
  2. Does it require explicit approval for all repository/cloud mutations?
  3. Does the provisional L2 classification match the user's risk appetite and actual data flows?
  4. Is the framework schema restored before automating handoff validation?
- **Decision options:** ACCEPT, ACCEPT_WITH_FINDINGS, REVISE, or REJECT.
