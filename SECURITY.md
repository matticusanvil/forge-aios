# Security policy

Forge AIOS runs Claude Code, which can run commands and change files, so security problems matter here.

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private vulnerability reporting instead: the **Security** tab of this repository, then **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply within a week. Fixes for confirmed problems go out as a new release, and you'll be credited unless you'd rather not be.

## In scope

- Getting past Forge's sign-in, or reaching its API or WebSocket without it
- Tool calls running without the approval the session's rules require
- Text in files, command output or web pages being treated as a steering message from the user
- Writes to linked knowledge graphs, which are read only
- Leaks of the API token, the password hash, ntfy tokens or approval tokens

## Out of scope

- Claude Code itself: report those to Anthropic.
- What a tool call does after you approve it, or under "Allow everything".
