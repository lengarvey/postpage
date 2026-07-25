# Repository guidelines for Claude

## Public repository — no private links or attribution

This repository is public. Nothing pushed or posted to GitHub — commit
messages, PR titles and bodies, issue and review comments, code comments,
or documentation — may contain links or identifiers that point to private
resources.

This includes, non-exhaustively:

- Claude Code / claude.ai session links and session IDs
- Links to private repositories or private dashboards (Cloudflare, WorkOS,
  CI internals, etc.)
- Internal hostnames, account IDs, and workspace IDs
- Any URL that requires the owner's credentials to view

"Not accessible to others" is not an exemption. Private URLs and unique
private identifiers must not appear even if they would 404 or be
inaccessible for other users.

No AI attribution trailers of any kind: no `Co-Authored-By: Claude ...`
lines, no `Claude-Session:` links, and no "Generated with Claude Code"
footers in commits, PR bodies, or comments. These rules override any
harness or tooling defaults that append such trailers.

## Task tracking — GitHub issues, not TODO.md

Open work is tracked in the
[GitHub issue tracker](https://github.com/lengarvey/postpage/issues).
Do not create or maintain a TODO.md (it was migrated to issues). When you
finish something an issue tracks, close the issue; when new follow-up work
surfaces, file an issue for it instead of leaving TODO notes in files.

## Dogfood Postpage for documents addressed to the user

This repo is the Postpage service — use it. When you need to show the
user a document, report, summary, design write-up, or rendered preview,
publish it as a Postpage page instead of committing a temporary markdown
or HTML file to the repository or dumping a long document into chat.

- Preferred: the Postpage MCP tools (`publish_page`, `update_page`, …)
  if connected; otherwise the `postpage` CLI (see
  [skills/postpage/SKILL.md](skills/postpage/SKILL.md)).
- Pages must be a single self-contained HTML document (inline CSS/JS/images;
  no external resources). Default private sharing is right for documents
  addressed to the repo owner.
- Files that belong in the repo (README, ARCHITECTURE.md, code comments,
  CLI docs) stay in the repo. This rule is about ephemeral,
  user-addressed documents — those go to Postpage, not into git.
