# ADR-001: Service Account Identity for Azure DevOps Operations

**Status:** Accepted  
**Date:** 2026-07-21  
**Decision makers:** Project team

## Context

KiroFactory workers (containerized agent processes) need to perform Git operations against Azure DevOps repositories:
- Clone the repository
- Create feature branches
- Commit changes
- Push branches
- Create pull requests

The question is whether each worker should authenticate as the individual user who triggered the session, or as a shared service account.

## Decision

**Workers use a single service account identity for all Azure DevOps operations.**

All Git operations (clone, push, create PR) are performed using:
- A single Azure DevOps Personal Access Token (PAT) stored in the `AZURE_DEVOPS_EXT_PAT` environment variable
- Git author identity: `KiroFactory Agent <agent@kirofactory.dev>`

All actions appear as a single bot user in Azure DevOps.

## Rationale

| Factor | Service Account (chosen) | Per-User PAT |
|--------|--------------------------|--------------|
| Credential management | One PAT to configure and rotate | N PATs, each with different expiry/scope |
| Setup complexity | Single env var, works immediately | Requires encrypted storage, per-user injection |
| Audit trail | All PRs from "KiroFactory Agent" | PRs show actual developer name |
| Security surface | One credential to protect | Multiple credentials, larger attack surface |
| Sufficiency for MVP | ✅ Fully sufficient | Over-engineered for current needs |

The service account approach is simpler and sufficient for the MVP. The trade-off is reduced audit granularity — all PRs appear as created by a bot rather than the requesting developer.

## Current Implementation

- `worker/worker.js` — reads `AZURE_DEVOPS_EXT_PAT` from environment, uses it for clone/push
- `backend/src/aca-worker-spawner.ts` — injects the PAT into worker container environment
- `backend/src/mcp-proxy-config.ts` — passes PAT to MCP proxy for Azure DevOps tools
- Git identity configured as `KiroFactory Agent <agent@kirofactory.dev>`

## Future: Per-User Identity

When per-user audit trails become a requirement, the system will switch to per-user PAT injection:

1. Each user stores their Azure DevOps PAT in their KiroFactory user settings (encrypted in the `users` table via `cred_azure_devops_pat` column — already implemented)
2. When a session starts, the user's PAT is injected into the worker container instead of the shared service account PAT
3. Git author identity is set to the user's name/email
4. PRs will then appear as created by the actual developer

The credential storage infrastructure for this is already in place (`backend/src/db/credentials.ts`). The remaining work is:
- Passing the user's PAT (instead of the service account PAT) when spawning a worker for that user
- Setting Git user.name/user.email from the user's profile
- Handling cases where a user hasn't configured their PAT (fallback to service account or error)

## Consequences

- **Positive:** Simple setup, one credential to manage, workers are stateless with respect to user identity
- **Negative:** No per-user audit trail in Azure DevOps; all PRs appear from the bot account
- **Mitigation:** KiroFactory's own database tracks which user initiated each session, providing internal auditability even without Azure DevOps attribution
