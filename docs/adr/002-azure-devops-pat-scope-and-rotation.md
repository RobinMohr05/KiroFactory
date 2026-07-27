# ADR-002: Azure DevOps PAT Scope and Rotation Strategy

**Status:** Proposed (parked — revisit after initial deployment is working)  
**Date:** 2026-07-21  
**Decision makers:** TBD  
**Depends on:** [ADR-001](./001-service-account-identity-for-azure-devops.md) (service account identity)

## Context

ADR-001 established that Vibecode Heaven uses a single service account PAT (`AZURE_DEVOPS_EXT_PAT`) for all Azure DevOps operations. This ADR addresses the operational concerns around that PAT:

- What scopes (permissions) does the PAT need?
- How often should it be rotated?
- Who owns the service account and is responsible for rotation?
- What happens when the PAT expires?

These questions are parked until the auth model is finalized and initial deployment is operational.

## Open Questions

| # | Question | Options / Notes |
|---|----------|-----------------|
| 1 | **Shared PAT or per-user PAT?** | ADR-001 decided shared for MVP. Per-user is a future enhancement. This ADR covers the shared PAT only. |
| 2 | **What scopes does the PAT need?** | Minimum viable: `Code (Read & Write)`, `Pull Request Threads (Read & Write)`, `Build (Read)`. See analysis below. |
| 3 | **How often to rotate?** | Options: 30 days, 90 days, 180 days, or on-demand. Azure DevOps max PAT lifetime is 1 year. |
| 4 | **Who owns the service account?** | Options: shared team account, dedicated service principal, individual admin's PAT. |
| 5 | **Expiry alerting** | How do we detect an expired PAT before it breaks CI? |

## Preliminary Scope Analysis

Based on current Vibecode Heaven operations (clone, branch, commit, push, create PR), the minimum PAT scopes are:

| Scope | Access Level | Why |
|-------|-------------|-----|
| **Code** | Read & Write | Clone repos, push branches, read file contents |
| **Pull Request Threads** | Read & Write | Create PRs, add comments, approve/reject |
| **Build** | Read | Check build status before merging (optional) |
| **Work Items** | Read (optional) | Link PRs to work items if needed |

**Excluded scopes** (not needed currently):
- Packaging, Release, Test Plans, Wiki, Analytics, Extensions, Security

## Rotation Strategy Options

| Strategy | Frequency | Automation | Risk |
|----------|-----------|------------|------|
| **Manual rotation** | Every 90 days | Calendar reminder, manual update in env/secrets | Human forgets → outage |
| **Automated rotation** | Every 30-60 days | Script creates new PAT via Azure DevOps REST API, updates secret store | Requires service principal with PAT management permissions |
| **On-demand** | When compromised or on schedule | Triggered manually or by policy | Lowest overhead but least predictable |

## Recommended Approach (Draft — Not Yet Accepted)

1. **Scope:** Grant minimum scopes listed above. Avoid `Full access` PATs.
2. **Lifetime:** Set PAT expiry to 90 days.
3. **Rotation:** Manual rotation for MVP; automate after deployment stabilizes.
4. **Ownership:** A dedicated service account (not tied to any individual's Azure DevOps identity).
5. **Alerting:** Log a warning on 401/403 responses from Azure DevOps; add a health check endpoint that validates the PAT periodically.
6. **Secret storage:** Store in environment variables for local dev; use Azure Key Vault or equivalent for production containers.

## Action Items (Post-Deployment)

- [ ] Finalize auth model (per-user vs. shared — confirm ADR-001 holds)
- [ ] Create the dedicated service account in Azure DevOps
- [ ] Generate PAT with minimum scopes
- [ ] Document the rotation procedure (runbook)
- [ ] Implement PAT health check (periodic validation call)
- [ ] Set up expiry alerting (calendar + automated check)
- [ ] Evaluate automated rotation via Azure DevOps PAT Lifecycle Management API

## Consequences

- **Positive:** Documenting scope requirements prevents over-permissioned PATs; rotation strategy reduces blast radius of leaked credentials.
- **Negative:** Manual rotation carries risk of human error/forgetfulness until automation is in place.
- **Mitigation:** Health check endpoint will detect expired PATs quickly; minimum scopes limit damage from a compromised token.

## References

- [Azure DevOps PAT documentation](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate)
- [PAT Lifecycle Management API](https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/manage-personal-access-tokens-via-api)
- ADR-001: Service Account Identity for Azure DevOps Operations
