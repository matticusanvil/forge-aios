# Contributing

Thanks for helping. A few things make changes easy to accept:

- **Open an issue first** for anything bigger than a small fix, so we can agree on the approach before you spend time on it.
- **Keep it simple.** Straightforward code over clever code, and match the style of the files around your change.
- **Run the checks:** `npm run check` and `npm test` must pass. Add a fast test in `test/unit/` for new rules or logic.
- **Behaviour that involves Claude** (steering, approvals, subagents, sessions) is covered by the live gate tests in `test/`. Run the ones your change touches against your own Forge, and say which you ran in the pull request.
- **Never commit secrets,** server addresses or personal details. CI scans every push.
- **UI changes** use the design system in `web/src/design` (the `fa-` classes); include a screenshot in the pull request.

By contributing, you agree that your contribution is licensed under the Apache License 2.0, like the rest of the project.
