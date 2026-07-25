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
