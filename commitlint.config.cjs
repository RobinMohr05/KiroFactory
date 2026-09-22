/**
 * commitlint configuration — enforces Conventional Commits (coding_guidelines §3).
 *
 * Runs on the commit-msg hook so agent-generated commit messages match the
 * `<type>[scope]: <description>` format the guidelines (and the auto-commit steering)
 * require before a commit is accepted.
 */
module.exports = {
  extends: ["@commitlint/config-conventional"],
};
