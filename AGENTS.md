# AGENTS.md

## Basics

- Keep code file line endings as LF.
- Never reference ADRs from user-facing docs (`README.md`): no `docs/adr/` links, no "ADR 0020". Keep any reasoning a reader needs in plain words.

## Git Commits

When creating commits, follow the repository `git-commit` skill rules:

- Use Conventional Commits title format: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `refactor`, `perf`, `docs`, `style`, `test`, `build`, `ci`, `chore`, `revert`.
- Use a meaningful scope based on the main module, package, or feature.
- Write the subject in imperative mood and describe the actual change.
- Use a concise Markdown list in the commit body, with each item describing one key change.
- Do not invent changes that are not present in the diff.
- Do not describe behavior, refactors, fixes, or tests that are not reflected in the commit.

Include at most one `Co-authored-by` trailer that matches the AI assistant actually used to produce the change.

Examples:

- `Co-authored-by: Codex <267193182+codex@users.noreply.github.com>`
- `Co-authored-by: GitHub Copilot <copilot@github.com>`
- `Co-authored-by: Claude <81847+claude@users.noreply.github.com>`

If you are not one of the listed assistants, do not add a `Co-authored-by` trailer.

Instead, ask the human collaborator to provide the exact `Co-authored-by` trailer to use. Do not invent, infer, or generate one yourself.