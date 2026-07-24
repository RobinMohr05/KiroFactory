---
inclusion: auto
---

# Auto-Commit Convention

After completing a code change, automatically commit the work with a clear, concise commit message. Do not wait for the user to ask you to commit.

**When to commit immediately:**
- The change is straightforward and self-contained (bug fix, refactor, config update, dependency bump, new feature implementation).
- The change compiles/builds successfully.

**When NOT to commit (ask the user first):**
- The change involves a design decision the user hasn't confirmed yet.
- You're unsure whether the approach is what the user wants.
- The change is partial or experimental and might be reverted.
- Multiple alternative implementations are possible and you haven't agreed on one.

**Commit message style:**
- Use conventional commit prefixes: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `ci:`.
- Keep the subject line under 72 characters.
- Stage only the files relevant to the change (avoid `git add .`).
