# Research: Coding Guidelines, Workflows, Best Practices & Security

Last Updated: 2026-08-19 (expanded with sections 18–24)

This document collects coding guidelines, workflows, security practices, and quality standards relevant to the KiroFactory project — a TypeScript/Node.js monorepo with Express backend, vanilla JS frontend, Neo4j database, WebSocket real-time communication, Docker containers on Azure Container Apps, and autonomous AI agent orchestration.

Each section is rated for relevance to this project:
- **HIGH** — Directly applicable now or in the near future
- **MEDIUM** — Useful context, likely needed as the project grows
- **LOW** — Tangential; included only if it may become relevant later

---

## Table of Contents

1. [TypeScript & Node.js Coding Standards](#1-typescript--nodejs-coding-standards)
2. [Security Practices](#2-security-practices)
3. [Git Workflow & Commit Conventions](#3-git-workflow--commit-conventions)
4. [Code Review Process](#4-code-review-process)
5. [Testing Strategy](#5-testing-strategy)
6. [API Design](#6-api-design)
7. [Error Handling & Logging](#7-error-handling--logging)
8. [Dependency Management & Supply Chain Security](#8-dependency-management--supply-chain-security)
9. [Docker & Container Security](#9-docker--container-security)
10. [CI/CD Pipeline](#10-cicd-pipeline)
11. [Performance & Scalability](#11-performance--scalability)
12. [Architecture & Design Principles](#12-architecture--design-principles)
13. [Documentation Standards](#13-documentation-standards)
14. [Database & Query Safety](#14-database--query-safety)
15. [WebSocket Security](#15-websocket-security)
16. [Secrets Management](#16-secrets-management)
17. [Monorepo Best Practices](#17-monorepo-best-practices)
18. [Observability & Monitoring](#18-observability--monitoring)
19. [Resilience Patterns](#19-resilience-patterns)
20. [Input Validation & Schema Enforcement](#20-input-validation--schema-enforcement)
21. [Linting & Formatting](#21-linting--formatting)
22. [Configuration Management (12-Factor App)](#22-configuration-management-12-factor-app)
23. [Accessibility (Frontend)](#23-accessibility-frontend)
24. [Feature Flags & Progressive Rollout](#24-feature-flags--progressive-rollout)

---

## 1. TypeScript & Node.js Coding Standards

**Relevance: HIGH**

### Sources
- https://github.com/seanpmaxwell/Typescript-Best-Practices/blob/main/README.md
- https://techinsights.manisuec.com/nodejs/typescript-best-practices/
- https://blog.openreplay.com/typescript-best-practices-large-projects/
- https://github.com/labs42io/clean-code-typescript

### Key Guidelines

**Strict TypeScript Configuration:**
- Enable `strict: true` in tsconfig (includes `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`)
- Enable `noUncheckedIndexedAccess` for safer array/object property access
- Prefer `unknown` over `any` — force explicit narrowing
- Use `readonly` modifiers on objects and arrays to protect data integrity

**Naming & Structure:**
- Use `camelCase` for variables/functions, `PascalCase` for types/interfaces/classes
- Prefer named exports over default exports for clarity and refactoring safety
- Group imports: Node built-ins → external packages → internal modules
- Keep function bodies under 30 lines where possible; extract helpers
- Use exhaustive `switch` with `never` fallback for discriminated unions

**Type Safety:**
- Prefer interfaces for object shapes, type aliases for unions/intersections
- Use discriminated unions instead of optional properties where states are mutually exclusive
- Avoid type assertions (`as`) — narrow instead
- Use `satisfies` operator for type-safe object literals while preserving narrower types

**Async Patterns:**
- Always use `async/await` over raw Promise chains for readability
- Never mix callbacks and promises in the same code path
- Handle all promise rejections — use `Promise.allSettled` when partial failure is acceptable
- Never use `void` on promises without intentional fire-and-forget semantics

**Code Hygiene:**
- No `eval()`, `Function()` constructor, or dynamic code execution
- No `var` — always `const`, use `let` only when reassignment is required
- Avoid global state and singletons — inject dependencies explicitly
- Use `Map`/`Set` over plain objects for dynamic key collections

---

## 2. Security Practices

**Relevance: HIGH**

### Sources
- https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Nodejs_Security_Cheat_Sheet.md
- https://nodejs.org/learn/getting-started/security-best-practices
- https://owasp.org/www-project-secure-coding-practices-quick-reference-guide/
- https://shattered.io/owasp-top-10-nodejs/

### OWASP Top 10 — Node.js Specific

**A01 — Broken Access Control:**
- Validate authorization on every route handler, not just at middleware level
- Use principle of least privilege for database connections
- Verify resource ownership (not just authentication) before operations

**A02 — Cryptographic Failures:**
- Use `crypto.timingSafeEqual()` for comparing secrets (prevents timing attacks)
- Use `scrypt` or `argon2` for password hashing — never MD5/SHA for passwords
- Generate encryption keys with `crypto.randomBytes(32)`

**A03 — Injection:**
- Always use parameterized queries (Cypher parameters for Neo4j, never string concatenation)
- Validate and sanitize all user input with a validation library
- Use Content-Type validation on incoming requests

**A05 — Security Misconfiguration:**
- Use `helmet` middleware for security headers (CSP, HSTS, X-Frame-Options, etc.)
- Remove `X-Powered-By` header
- Set appropriate cookie flags: `httpOnly`, `Secure`, `SameSite`
- Configure request body size limits per content type

**A07 — Identification and Authentication Failures:**
- Implement rate limiting on auth endpoints (express-rate-limit)
- Account lockout after repeated failures
- JWT tokens: short expiry, secure storage, proper invalidation

**A08 — Software and Data Integrity Failures:**
- Pin dependency versions, use lockfiles, run `npm ci` in CI
- Verify package integrity with lockfile checksums

### Node.js-Specific Threats

- **Prototype Pollution:** Use `Object.create(null)` for dictionary objects, validate JSON input shapes, avoid recursive deep-merge of untrusted data
- **ReDoS (Regex Denial of Service):** Audit regex patterns for catastrophic backtracking, use tools like `vuln-regex-detector`
- **Event Loop Blocking:** Never perform CPU-intensive work on the main thread; use worker threads if needed
- **`child_process.exec` Injection:** Use `execFile` with argument arrays instead of `exec` with interpolated strings

---

## 3. Git Workflow & Commit Conventions

**Relevance: HIGH**

### Sources
- https://www.conventionalcommits.org/en/v1.0.0/
- https://www.atlassian.com/continuous-delivery/continuous-integration/trunk-based-development
- https://www.deployhq.com/blog/5-effective-git-branching-strategies-for-streamlined-development

### Branching Strategy

**GitHub Flow (recommended for this project's size/team):**
- `main` is always deployable
- Feature branches are short-lived (hours to a couple of days)
- Every change goes through a PR before merging
- Delete branches after merge

**Branch naming convention:**
```
<type>/#<task-id>_<short-slug>
```
Examples: `feature/#42_add-pagination`, `fix/#99_auth-timeout`

### Conventional Commits

Format:
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

Types:
| Type | Purpose |
|------|---------|
| `feat` | New feature (MINOR version bump) |
| `fix` | Bug fix (PATCH version bump) |
| `docs` | Documentation only |
| `style` | Formatting, no logic change |
| `refactor` | Code change that neither fixes nor adds |
| `perf` | Performance improvement |
| `test` | Adding/fixing tests |
| `chore` | Build, tooling, dependencies |
| `ci` | CI/CD configuration |

Rules:
- Subject line under 72 characters
- Use imperative mood ("add feature" not "added feature")
- Breaking changes: append `!` after type or add `BREAKING CHANGE:` footer
- Each commit = one logical, independently revertable change
- Stage specific files (no `git add .`)

---

## 4. Code Review Process

**Relevance: HIGH**

### Sources
- https://www.qodo.ai/blog/code-review-process/
- https://codeant.ai/blogs/code-review-best-practices
- https://kluster.ai/blog/best-practices-code-review

### Automated Pre-Review (run before human review)

1. Linting (ESLint with strict TypeScript rules)
2. Type checking (`tsc --noEmit`)
3. Unit tests pass
4. Build succeeds
5. Security scanning (npm audit)

### Human Review Checklist

**Intent & Design:**
- Does the change solve the stated problem correctly?
- Is the approach appropriate for the problem's complexity?
- Are there unintended side effects or scope creep?

**Correctness:**
- Edge cases handled (null, empty, concurrent access)?
- Error paths well-defined and tested?
- Race conditions in async code?

**Security:**
- User input validated before use?
- No secrets in code or logs?
- Authorization checked, not just authentication?

**Maintainability:**
- Would a new team member understand this in 6 months?
- No dead code, commented-out blocks, or TODOs without tickets?
- Names clearly convey intent?

### PR Best Practices

- Keep PRs small and focused (< 400 lines of functional change)
- Title: concise, under 70 characters
- Description: what changed, why, how to verify, what's not included
- Self-review before requesting others
- Respond to all comments before re-requesting review

---

## 5. Testing Strategy

**Relevance: HIGH**

### Sources
- https://github.com/goldbergyoni/javascript-testing-best-practices
- https://github.com/testjavascript/nodejs-integration-tests-best-practices
- https://www.digitalapplied.com/blog/software-testing-strategy-2026-engineering-reference

### Test Pyramid

```
         ╱  E2E  ╲         ~10% — Critical user flows only
        ╱──────────╲
       ╱ Integration ╲     ~20% — API endpoints, DB queries
      ╱────────────────╲
     ╱    Unit Tests     ╲  ~70% — Pure logic, utilities, transforms
    ╱────────────────────────╲
```

### Unit Tests
- Test pure functions and business logic in isolation
- Mock external dependencies (database, HTTP, filesystem)
- Fast: entire suite < 10 seconds
- One assertion concept per test (can have multiple `expect` calls)
- Use descriptive test names: `"should reject expired JWT tokens"`
- Framework: **Vitest** (already in use)

### Integration Tests
- Test through the API layer (HTTP requests to Express routes)
- Use a real database connection (test database or in-memory)
- Test the happy path + important error scenarios
- Verify response shape, status codes, headers

### E2E Tests
- Cover critical user workflows (login → create task → verify on board)
- Use Puppeteer (already set up per qa-testing skill)
- Run against deployed environment, not local dev
- Accept slower execution; run on deploy, not every commit

### General Testing Rules
- Tests are first-class code — same quality standards as production
- No test interdependencies — each test sets up its own state
- Don't test implementation details (private methods, internal state)
- If a bug is found, write a failing test first, then fix
- Coverage target: aim for meaningful coverage (80%+ for critical paths), not 100% everywhere

---

## 6. API Design

**Relevance: HIGH**

### Sources
- https://blog.postman.com/rest-api-best-practices/
- https://www.digitalapplied.com/blog/rest-api-design-2026-engineering-reference-best-practices
- https://sesamedisk.com/rest-api-design-best-practices/

### REST Conventions

**URL Design:**
- Use plural nouns for resources: `/api/tasks`, `/api/sessions`
- Use path parameters for identity: `/api/tasks/:id`
- Use query parameters for filtering/pagination: `/api/tasks?state=todo&limit=20`
- No verbs in URLs — HTTP methods convey the action
- Consistent case: kebab-case for multi-word paths

**HTTP Methods:**
| Method | Semantics | Idempotent |
|--------|-----------|------------|
| GET | Read | Yes |
| POST | Create | No |
| PUT | Full replace | Yes |
| PATCH | Partial update | No* |
| DELETE | Remove | Yes |

**Response Standards:**
- Consistent envelope or shape across endpoints
- Always return appropriate HTTP status codes (don't return 200 for errors)
- Error responses: `{ "error": { "code": "TASK_NOT_FOUND", "message": "..." } }`
- Include pagination metadata: `{ "data": [...], "total": 42, "limit": 20, "offset": 0 }`

**Versioning:**
- Not urgently needed for internal APIs, but plan for it
- When needed: URL path prefix (`/api/v2/tasks`) is simplest for this project

---

## 7. Error Handling & Logging

**Relevance: HIGH**

### Sources
- https://grizzlypeaksoftware.com/library/nodejs-error-handling-strategies-for-production-dqz7may0
- https://betterstack.com/community/guides/logging/nodejs-logging-best-practices/
- https://oneuptime.com/blog/post/2026-02-20-nodejs-express-production/view

### Error Handling

**Express Error Middleware:**
- Use a centralized error handler as the last middleware
- Distinguish operational errors (expected, handle gracefully) from programmer errors (unexpected, crash & restart)
- Custom error classes with HTTP status codes and machine-readable codes
- Never expose stack traces or internal details to clients in production
- Always return JSON error responses, never HTML for an API

**Async Error Handling:**
- Wrap all async route handlers (or use express-async-errors)
- Handle `unhandledRejection` and `uncaughtException` at process level — log and exit gracefully
- Use try/catch in async functions, propagate errors to Express's `next()`

**Error Classification:**
```typescript
class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number,
    public code: string,
    public isOperational: boolean = true
  ) { super(message); }
}
```

### Structured Logging

**Principles:**
- JSON format for machine-parseable logs
- Include: timestamp, level, message, request ID, user context
- Levels: `error` (broken), `warn` (degraded), `info` (business events), `debug` (development)
- Never log secrets, tokens, passwords, or full request bodies with PII
- Log at request boundaries (incoming request, outgoing response, external calls)
- Correlate logs with a request ID propagated through the entire request lifecycle

**For this project specifically:**
- Worker/agent logs go to Azure Log Analytics (`ContainerAppConsoleLogs_CL`)
- Structured JSON logs are essential for KQL queries
- Include `sessionId`, `taskId`, `agentKind` in agent-related logs

---

## 8. Dependency Management & Supply Chain Security

**Relevance: HIGH**

### Sources
- https://semgrep.dev/blog/2022/the-best-free-open-source-supply-chain-tool-the-lockfile/
- https://docs.npmjs.com/cli/v8/configuring-npm/package-lock-json
- https://christiant.io/secure-pkg/
- https://github.com/lirantal/npm-security-best-practices

### Rules

1. **Always commit `package-lock.json`** — it pins every direct and transitive dependency to exact versions
2. **Use `npm ci` in CI/CD** — installs from lockfile exactly, fails on any mismatch
3. **Pin direct dependencies to exact versions** (no `^` or `~` in production apps)
4. **Run `npm audit` regularly** — fix or evaluate all known vulnerabilities
5. **Review new dependencies before adding:**
   - Is it actively maintained?
   - Does it have a reasonable download count?
   - Check for typosquatting (similar names to popular packages)
   - Prefer packages with minimal transitive dependencies
6. **Disable postinstall scripts for untrusted packages:** `--ignore-scripts` when evaluating
7. **Use `--min-release-age=1`** (npm 11.10+) to avoid installing freshly-published (potentially compromised) packages
8. **Keep dependencies up to date** — stale dependencies accumulate vulnerabilities
9. **Don't install dev dependencies in production images** — `npm ci --omit=dev`

---

## 9. Docker & Container Security

**Relevance: HIGH**

### Sources
- https://github.com/nodejs/docker-node/blob/main/docs/BestPractices.md
- https://axiom-experiment.hashnode.dev/dockerizing-nodejs-for-production-the-complete-2026-guide
- https://www.deployhq.com/blog/dockerize-nodejs-app

### Dockerfile Best Practices

1. **Use multi-stage builds:**
   - Stage 1 (builder): install all deps, compile TypeScript
   - Stage 2 (runtime): copy only compiled output + production deps into slim image
   - Reduces image size by 70-80%

2. **Run as non-root user:**
   ```dockerfile
   USER node
   ```
   The official `node:` images include a `node` user (UID 1000)

3. **Use specific base image tags** (not `:latest`):
   ```dockerfile
   FROM node:20.15-slim AS runtime
   ```

4. **Install production deps only in runtime stage:**
   ```dockerfile
   RUN npm ci --omit=dev
   ```

5. **Use `.dockerignore`** to exclude `node_modules`, `.git`, `.env`, test files

6. **Handle signals properly:**
   - Use `dumb-init` or `tini` as PID 1 (or Node's built-in signal handling)
   - Implement graceful shutdown (SIGTERM → close server → drain connections → exit)

7. **Don't store secrets in image layers:**
   - Use build secrets (`--mount=type=secret`) if needed at build time
   - Pass runtime secrets via environment variables or mounted volumes

8. **Scan images for vulnerabilities:**
   - Use Trivy, Snyk, or Docker Scout in CI
   - Block deploy on critical/high CVEs

9. **Set health checks:**
   ```dockerfile
   HEALTHCHECK --interval=30s --timeout=3s \
     CMD curl -f http://localhost:3500/health || exit 1
   ```

---

## 10. CI/CD Pipeline

**Relevance: HIGH**

### Sources
- https://inventivehq.com/blog/devsecops-pipeline-guide
- https://www.wiz.io/academy/application-security/ci-cd-security-scanning
- https://www.invicti.com/blog/web-security/iac-security-cicd-best-practices

### Pipeline Stages (recommended)

```
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│  Lint   │──▶│  Build   │──▶│  Test    │──▶│  Scan    │──▶│  Deploy  │
│ + Type  │   │ (tsc)    │   │ (vitest) │   │ (audit)  │   │ (to ACA) │
│  Check  │   │          │   │          │   │          │   │          │
└─────────┘   └──────────┘   └──────────┘   └──────────┘   └──────────┘
```

### Principles

- **Fail fast:** lint and type-check before expensive build/test steps
- **Immutable artifacts:** build the Docker image once, promote it through environments
- **Secrets never in code:** use CI secret stores (GitHub Secrets / Azure Key Vault)
- **Branch protection:** require passing CI + review before merge to main
- **Reproducible builds:** pin tool versions, use lockfiles
- **Security scanning integrated:** `npm audit`, container scanning, SAST before deploy
- **Separate build from deploy:** a green build means it CAN deploy; deploy is a conscious decision

---

## 11. Performance & Scalability

**Relevance: MEDIUM**

### Sources
- https://shattered.io/rate-limiting-nodejs/
- https://freecodecamp.org/news/nodejs-api-best-practices-for-scaling
- https://betterstack.com/community/guides/scaling-nodejs/rate-limiting-express/

### Key Practices

**Rate Limiting:**
- Apply rate limits on authentication endpoints (5-10 attempts per minute)
- Apply general API rate limiting (prevent abuse)
- Use sliding window or token bucket algorithms
- Return `429 Too Many Requests` with `Retry-After` header

**Connection Management:**
- Set appropriate server timeouts (`headersTimeout`, `requestTimeout`, `keepAliveTimeout`)
- Limit concurrent connections per client
- Implement connection draining on shutdown

**Event Loop Health:**
- Monitor event loop lag
- Never block the event loop with synchronous I/O or heavy computation
- Use `setImmediate()` to break up CPU-intensive work if worker threads aren't an option
- Consider `cluster` module or separate worker processes for CPU-bound tasks

**Caching:**
- Cache frequently-read, rarely-changing data (board structure, agent configs)
- Use appropriate HTTP caching headers for static assets
- Invalidate cache on writes

**Request Body Limits:**
- Set explicit body size limits per content type
- JSON bodies: 1KB-100KB depending on endpoint
- File uploads: explicit limits with streaming

---

## 12. Architecture & Design Principles

**Relevance: HIGH**

### Sources
- https://strapi.io/blog/solid-design-principles-javascript-typescript-guide
- https://generalistprogrammer.com/tutorials/solid-principles-complete-guide
- https://dev.to/remojansen/implementing-the-onion-architecture-in-nodejs-with-typescript-and-inversifyjs-10ad

### SOLID Principles (adapted for TypeScript)

| Principle | Application |
|-----------|-------------|
| **Single Responsibility** | Each module/file handles one concern (e.g., `task-claimer.ts` only claims tasks) |
| **Open/Closed** | Pipeline stages are parameterized by agent config, not hardcoded for specific states |
| **Liskov Substitution** | Editor and inspector agents are interchangeable in the loop logic |
| **Interface Segregation** | Small, focused interfaces (don't force agents to implement unused methods) |
| **Dependency Inversion** | High-level modules (session-manager) depend on abstractions, not database details |

### Separation of Concerns

- **Routes** → parse HTTP, validate input, call service layer
- **Service/business logic** → orchestrate operations, enforce rules
- **Data layer** → database queries, mapping to/from domain objects
- **Don't skip layers** — routes should never write raw queries

### Other Principles

- **DRY (Don't Repeat Yourself)** — but don't over-abstract either; duplication is cheaper than the wrong abstraction
- **YAGNI (You Aren't Gonna Need It)** — don't build features speculatively
- **Fail loudly** — silent failures are debugging nightmares (relevant: the `env: []` bug that silently killed worker sessions)
- **Explicit over implicit** — prefer verbose clarity over clever brevity

---

## 13. Documentation Standards

**Relevance: MEDIUM**

### Sources
- https://www.docuwriter.ai/posts/docstring-style-guide-javascript
- https://tsdoc.org/pages/intro/approach/
- https://google.github.io/styleguide/jsguide.html

### TSDoc / JSDoc

**When to document:**
- Public API functions and types (exported from a module)
- Non-obvious behavior, side effects, or constraints
- Complex algorithms or business logic
- Configuration options and their defaults

**When NOT to document:**
- Self-explanatory functions (`getUserById(id: string): User`)
- Private helpers with clear names
- Trivial getters/setters

**Format:**
```typescript
/**
 * Claims the next available task from the specified state.
 * Uses row-level locking (UPDLOCK + READPAST) for concurrency safety.
 *
 * @param claimState - Board column to claim from
 * @param workingState - Column to move the task to while working
 * @param tabIds - Optional filter to only claim from specific boards
 * @returns The claimed task, or null if none available
 */
```

### README & Architecture Docs

- Keep `README.md` focused on getting started
- Architecture decisions in `ARCHITECTURE.md`
- Don't duplicate information across files — reference instead
- Update docs when behavior changes (docs that disagree with code are worse than no docs)

---

## 14. Database & Query Safety

**Relevance: HIGH**

### Sources
- https://neo4j.com/developer/kb/protecting-against-cypher-injection/
- https://kindatechnical.com/cypher/cypher-parameters-and-prepared-queries.html
- https://neo4j.com/blog/developer/cypher-dynamism/

### Neo4j / Cypher Specific

1. **Always use parameters** — never concatenate user input into Cypher strings:
   ```typescript
   // GOOD
   session.run('MATCH (t:Task {id: $id}) RETURN t', { id: taskId })
   
   // BAD — Cypher injection risk
   session.run(`MATCH (t:Task {id: '${taskId}'}) RETURN t`)
   ```

2. **Use parameterized queries for all dynamic values** — this also enables query plan caching (major performance benefit)

3. **Validate input shapes before they reach the query layer** — a query expecting a string shouldn't receive an object

4. **Use indexes** on frequently-queried properties (task state, id)

5. **Limit result sets** — always use `LIMIT` in queries that could return unbounded results

6. **Transaction management:**
   - Use explicit transactions for multi-statement operations
   - Read transactions for queries, write transactions for mutations
   - Handle transaction failures and retries (Neo4j can kill transactions under load)

---

## 15. WebSocket Security

**Relevance: HIGH**

### Sources
- https://websocket.org/guides/security/
- https://websocket.org/guides/authentication/
- https://oneuptime.com/blog/post/2026-01-24-websocket-authentication/view

### Key Practices

1. **Always use WSS (TLS) in production** — never unencrypted WebSocket
2. **Authenticate during the upgrade handshake** — validate JWT from cookie before accepting the connection
3. **Validate Origin header** — prevent Cross-Site WebSocket Hijacking (CSWSH)
4. **Rate limit messages per client** — prevent abuse and resource exhaustion
5. **Validate message format** — don't trust incoming WebSocket messages; validate schema
6. **Implement heartbeat/ping-pong** — detect stale connections and clean up resources
7. **Re-validate authorization periodically** — tokens can expire during long-lived connections
8. **Set maximum message size** — prevent memory exhaustion from oversized messages
9. **Don't broadcast sensitive data** — only send what the connected user is authorized to see

---

## 16. Secrets Management

**Relevance: HIGH**

### Sources
- https://www.doppler.com/blog/secrets-management-env-files-to-control
- https://axiom-experiment.hashnode.dev/nodejs-secret-management-in-production-vault-aws-secrets-manager-and-zero-leakage-patterns

### Hierarchy of Controls

| Environment | Approach |
|-------------|----------|
| Local dev | `.env` file (gitignored), loaded via `dotenv` |
| CI/CD | GitHub Secrets / pipeline secret variables |
| Production | Azure Key Vault or environment variables injected by container platform |

### Rules

1. **Never commit secrets** — `.env` must be in `.gitignore`
2. **Never log secrets** — mask or redact in structured logs
3. **Never expose in error messages** — reference by key name, not value
4. **Rotate secrets periodically** — especially after team changes
5. **Use different secrets per environment** — dev ≠ staging ≠ production
6. **Encrypt at rest** — the project already uses `ENCRYPTION_KEY` for stored credentials
7. **Principle of least privilege** — each service/component only gets the secrets it needs
8. **Audit access** — know who/what can read each secret

---

## 17. Monorepo Best Practices

**Relevance: HIGH**

### Sources
- https://reintech.io/blog/npm-workspaces-monorepo-management-guide
- https://grizzlypeaksoftware.com/library/monorepo-management-with-npm-workspaces-l0dg2i1u
- https://www.robinwieruch.de/javascript-monorepos/

### npm Workspaces (current setup)

**Dependency Management:**
- Single `package-lock.json` at root — all workspaces share one lockfile
- Shared dependencies hoisted to root `node_modules`
- Workspace-specific dependencies in their own `package.json`
- Run workspace scripts: `npm run build -w backend`, `npm test -w backend`

**Structure Rules:**
- Each workspace is self-contained with its own `package.json`
- Shared types/utilities go in a shared workspace (if needed in future)
- Root `package.json` only has dev dependencies and workspace coordination scripts
- Each workspace should be independently buildable and testable

**When the project grows:**
- Consider `turbo` or `nx` for build caching and task orchestration
- Only rebuild what changed (affected packages)
- Shared TypeScript config (`tsconfig.base.json`) for consistency across workspaces

---

## 18. Observability & Monitoring

**Relevance: HIGH**

### Sources
- https://grizzlypeaksoftware.com/library/observability-for-ai-agent-systems-tpbnn8xp
- https://axiom-experiment.hashnode.dev/the-nodejs-observability-stack-in-2026-opentelemetry-prometheus-and-distributed-tracing
- https://betterstack.com/community/guides/observability/opentelemetry-nodejs-tracing/
- https://developers.redhat.com/articles/2025/06/12/how-implement-observability-nodejs-and-llama-stack

### Three Pillars of Observability

| Pillar | What it answers | Tools |
|--------|----------------|-------|
| **Logs** | What happened? (discrete events) | Structured JSON → Azure Log Analytics / KQL |
| **Metrics** | How is the system performing? (aggregates over time) | Prometheus, Azure Monitor metrics |
| **Traces** | Where did time go in a request? (distributed causality) | OpenTelemetry, Azure Application Insights |

### Key Practices

**Health Checks:**
- `/health` endpoint: returns 200 if the service can serve requests
- `/health/ready` (readiness): also checks downstream dependencies (DB, external services)
- Used by Azure Container Apps for liveness/readiness probes
- Keep health checks cheap — don't run expensive queries

**Metrics to Track (for AI agent orchestration):**
- Task completion rate, average time per task
- Agent credit consumption per task/session
- Error rate by agent kind (editor vs inspector)
- Queue depth (tasks waiting in each pipeline state)
- Worker container start time, execution duration
- WebSocket connection count (active clients)

**Distributed Tracing (future — as system grows):**
- OpenTelemetry is the industry standard (vendor-neutral)
- Auto-instruments HTTP, database drivers, etc.
- Propagate trace context through worker WebSocket messages
- Enables "follow a task from creation → claim → execution → resolution"

**AI Agent Observability (specific to this project):**
- Track token consumption and cost per step
- Monitor tool call frequency and failure rates
- Log agent decision points (what prompt was sent, what verdict came back)
- Detect stuck agents (same task retried N times without progress)

---

## 19. Resilience Patterns

**Relevance: HIGH**

### Sources
- https://oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff/view
- https://generalistprogrammer.com/tutorials/circuit-breaker-pattern-complete-guide
- https://grizzlypeaksoftware.com/library/llm-api-error-handling-and-retry-patterns-bpk0jmvq

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  // 1. Stop accepting new connections
  server.close();
  // 2. Finish in-flight requests (with timeout)
  await drainConnections(30_000);
  // 3. Close database connections
  await db.close();
  // 4. Exit cleanly
  process.exit(0);
});
```

- Handle both `SIGTERM` (container orchestrator) and `SIGINT` (Ctrl+C in dev)
- Set a maximum shutdown timeout (30s typical) — force-exit if exceeded
- Critical for Azure Container Apps: ACA sends SIGTERM before killing containers

### Retry with Exponential Backoff

```typescript
async function withRetry<T>(fn: () => Promise<T>, opts: {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}): Promise<T> {
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === opts.maxAttempts) throw err;
      const delay = Math.min(
        opts.baseDelayMs * 2 ** (attempt - 1),
        opts.maxDelayMs
      );
      await sleep(delay + Math.random() * delay * 0.1); // jitter
    }
  }
}
```

- Always add jitter to prevent thundering herd
- Set a maximum delay cap
- Only retry idempotent operations
- Know when NOT to retry (4xx client errors, auth failures)
- Respect `Retry-After` headers from rate-limited APIs

### Circuit Breaker (for external service calls)

Three states: **Closed** (normal) → **Open** (fail-fast) → **Half-Open** (probe)

- Monitor failure rate over a rolling window
- When failures exceed threshold → trip to Open → return fallback/error immediately
- After cooldown period → allow one probe request (Half-Open)
- If probe succeeds → close circuit; if fails → stay open

**When to use in this project:**
- Neo4j database calls (connection pool exhaustion, network issues)
- GitHub API calls (rate limiting, outages)
- kiro-cli process spawning (repeated immediate failures)
- Azure Container Apps Job API calls

### Timeout Everything

- Database queries: 30s max (prevent hung connections)
- HTTP calls to external services: 10-30s
- Worker task execution: 15min default (already enforced)
- WebSocket idle timeout: 5min heartbeat

---

## 20. Input Validation & Schema Enforcement

**Relevance: HIGH**

### Sources
- https://techinsights.manisuec.com/nodejs/input-validation-and-sanitization-joi-vs-zod/
- https://oneuptime.com/blog/post/2026-01-25-zod-validation-typescript/view
- https://stevekinney.com/courses/full-stack-typescript/using-zod-with-express

### Runtime Schema Validation (Zod recommended for TypeScript)

**Why runtime validation matters:**
- TypeScript types disappear at runtime — they don't protect against bad HTTP input
- User input, API responses, and environment variables all need runtime checks
- A single unvalidated field can lead to injection, crashes, or data corruption

**Zod Pattern for Express routes:**
```typescript
import { z } from 'zod';

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  priority: z.number().int().min(1).max(4),
  type: z.enum(['bug', 'feature', 'improvement']),
  tabIds: z.array(z.number().int().positive()).min(1),
});

// In route handler:
const parsed = CreateTaskSchema.safeParse(req.body);
if (!parsed.success) {
  return res.status(400).json({ error: parsed.error.flatten() });
}
// parsed.data is fully typed and validated
```

**Validation Rules:**
1. Validate at the API boundary (route handlers) — before data reaches business logic
2. Fail closed: reject anything that doesn't match the schema
3. Return clear, structured validation errors (field-level, not just "bad request")
4. Validate path/query params too, not just bodies
5. Coerce types explicitly (query params arrive as strings)
6. Sanitize after validation: trim strings, normalize unicode where appropriate
7. Define schemas once, infer TypeScript types from them (`z.infer<typeof Schema>`)

---

## 21. Linting & Formatting

**Relevance: HIGH**

### Sources
- https://oneuptime.com/blog/post/2026-02-03-eslint-prettier-typescript/view
- https://medium.com/@gabrieldrouin/node-js-2025-guide-how-to-setup-express-js-with-typescript-eslint-and-prettier-b342cd21c30d

### ESLint + Prettier (separation of concerns)

| Tool | Responsibility |
|------|---------------|
| **ESLint** | Code quality: bugs, best practices, unused variables, type-aware rules |
| **Prettier** | Code formatting: spacing, indentation, line breaks, quotes |

**Do not mix them** — use `eslint-config-prettier` to disable ESLint's formatting rules, let Prettier handle formatting exclusively.

### Recommended ESLint Configuration

```
@typescript-eslint/eslint-plugin → type-aware rules
@typescript-eslint/parser → TypeScript parsing
eslint-config-prettier → turn off formatting rules
eslint-plugin-import → import ordering and validation
```

**Key rules to enable:**
- `@typescript-eslint/no-explicit-any` (error)
- `@typescript-eslint/no-unused-vars` (error, with `_` prefix exception)
- `@typescript-eslint/strict-boolean-expressions` (warn)
- `@typescript-eslint/no-floating-promises` (error) — critical for async safety
- `no-console` (warn in production code, off in tests)
- `eqeqeq` (error) — always `===`
- `no-return-await` (error)

**Integration:**
- Run ESLint + Prettier on pre-commit (husky + lint-staged)
- Run in CI as a gate (fail the build on lint errors)
- Auto-fix formatting on save in IDE (configure `.vscode/settings.json`)

---

## 22. Configuration Management (12-Factor App)

**Relevance: HIGH**

### Sources
- https://nodejsdesignpatterns.com/blog/nodejs-environment-variables/
- https://oneuptime.com/blog/post/2026-01-06-nodejs-production-environment-variables/view
- https://reintech.io/blog/nodejs-environment-variables-best-practices-security

### The 12-Factor Principle

> Configuration that varies between deploys belongs in the environment, not in the code.

**Litmus test:** Could this codebase be open-sourced without compromising any credentials or environment-specific settings?

### Best Practices

1. **Use `.env` files for local dev only** — never in production
2. **Validate all environment variables on startup:**
   ```typescript
   const config = z.object({
     NEO4J_URI: z.string().url(),
     NEO4J_PASSWORD: z.string().min(1),
     PORT: z.coerce.number().default(3500),
     NODE_ENV: z.enum(['development', 'production', 'test']),
   }).parse(process.env);
   ```
   Fail fast with a clear error message listing ALL missing vars — not one at a time

3. **Don't scatter `process.env.X` throughout the codebase** — read config once at startup, pass it explicitly
4. **Provide sensible defaults for non-sensitive config** (port, timeouts, feature flags)
5. **Never provide defaults for secrets** — force them to be explicitly set
6. **Document every environment variable** in `.env.example` with descriptions
7. **Use different config per environment** — dev, staging, production should have different database URLs, keys, etc.
8. **Treat config as immutable after startup** — don't reload `.env` at runtime

---

## 23. Accessibility (Frontend)

**Relevance: MEDIUM**

### Sources
- https://dynomapper.com/blog/accessibility-testing/how-to-develop-for-web-accessibility/
- https://developer.mozilla.org/en-US/docs/Learn_web_development/Core/Accessibility/CSS_and_JavaScript
- https://namastedev.com/blog/building-accessible-components-with-vanilla-js/

### WCAG 2.2 AA Target (Legal Compliance)

The KiroFactory frontend is a vanilla HTML/CSS/JS application with drag-and-drop Kanban board. Key accessibility concerns:

**Keyboard Navigation:**
- All interactive elements must be reachable and operable via keyboard
- Drag-and-drop must have a keyboard alternative (e.g., arrow keys or a "move to" menu)
- Visible focus indicators on all focusable elements (`:focus-visible`)
- No keyboard traps — users can always Tab/Escape away

**Semantic HTML:**
- Use native elements (`<button>`, `<a>`, `<input>`) over `<div>` with click handlers
- Proper heading hierarchy (`h1` → `h2` → `h3`, no skipped levels)
- Use `<main>`, `<nav>`, `<aside>` landmarks
- Use `<ul>`/`<li>` for lists (including Kanban columns as lists of tasks)

**ARIA (when semantic HTML isn't sufficient):**
- `role="listbox"` / `role="option"` for custom dropdowns
- `aria-live="polite"` for dynamic content updates (task moved, new task created)
- `aria-label` or `aria-labelledby` for non-text interactive elements
- `aria-expanded` for collapsible sections

**Color & Contrast:**
- 4.5:1 contrast ratio for normal text, 3:1 for large text
- Don't convey information by color alone (priority colors need text/icon too)
- Ensure dark mode also meets contrast requirements

**Dynamic Content:**
- Announce state changes to screen readers (task moved, error occurred)
- When WebSocket pushes an update, announce it without disrupting current focus
- Modal dialogs: trap focus, return focus on close

---

## 24. Feature Flags & Progressive Rollout

**Relevance: MEDIUM**

### Sources
- https://configcat.com/blog/feature-flags-explained/
- https://designrevision.com/blog/feature-flags-best-practices
- https://datadoghq.com/knowledge-center/feature-flags/best-practices-ai-teams/

### When Feature Flags Are Useful for This Project

- **New agent capabilities** — test a new prompt strategy on one task before rolling to all
- **UI experiments** — try a new board layout without deploying a separate branch
- **Kill switches** — disable a misbehaving feature in production without redeploying
- **Gradual migration** — switch database backends, validate per-request

### Best Practices

1. **Every flag has an owner and an expiry date** — prevent flag debt
2. **Clean up flags after rollout** — a flag that's been 100% "on" for 2 weeks should be removed
3. **Limit total active flags** — >20 simultaneous flags is a smell
4. **Test both paths** — off and on
5. **Use environment-level flags for simple cases** (environment variable), external service for complex targeting
6. **Don't nest flags** — `if (flagA && flagB && !flagC)` is unmaintainable
7. **Log flag evaluation** — know which path was taken when debugging

### Simple Implementation (for this project's scale)

```typescript
// config/feature-flags.ts
export const flags = {
  NEW_PROMPT_STRATEGY: process.env.FF_NEW_PROMPT === 'true',
  PARALLEL_WORKERS: process.env.FF_PARALLEL_WORKERS === 'true',
} as const;
```

No need for a third-party service at this project's current scale.

---

## Summary: Priority Order for This Project

The following are the most impactful areas to enforce first, given the project's current state (autonomous AI agents modifying code, production deployments, multi-stage pipeline):

1. **Input validation & injection prevention** (Cypher injection, command injection in worker, Zod schemas at API boundaries)
2. **Dependency supply chain security** (lockfile discipline, `npm ci`, audit)
3. **Secrets management** (never in code, rotate, encrypt)
4. **Docker container security** (non-root, multi-stage, scan)
5. **Structured error handling & logging** (essential for debugging autonomous agent runs)
6. **Resilience patterns** (graceful shutdown, retry with backoff, circuit breakers for external calls)
7. **Conventional commits & PR discipline** (agents create PRs autonomously)
8. **TypeScript strict mode + linting** (catch bugs at compile time, not in production)
9. **Observability & monitoring** (health checks, agent metrics, tracing across worker sessions)
10. **WebSocket security** (authenticated connections, message validation)
11. **Testing strategy** (confidence that agent-created code works)
12. **Rate limiting & DoS prevention** (protect the orchestrator API)
13. **Configuration management** (validate env vars on startup, fail fast on missing config)
14. **Accessibility** (important for a web UI, even if internal — ensure keyboard/screen reader basics)
15. **Feature flags** (useful as the agent system grows — gradual prompt/strategy rollouts)
