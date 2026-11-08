# Contributing

Thanks for helping. Bug reports, fixes and improvements to the existing mods are welcome. For a new feature, open an issue first so we can agree on the shape before you build it.

## Layout

```
.claude-plugin/marketplace.json   the marketplace: lists every mod
<mod>/
  .claude-plugin/plugin.json      name, version, description
  hooks/hooks.json                loads the module: { "modules": ["./register.tsx"] }
  hooks/register.tsx              the mod
  types/index.d.ts                the mod's own types
  tests/*.test.ts                 tests, run with `claude plugin test`
  README.md                       user docs
```

## Dev loop

1. Fork and clone the repo.
2. Point Claude Code at your checkout instead of the published marketplace:

   ```sh
   claude plugin marketplace remove claude-mods   # if you installed from GitHub
   claude plugin marketplace add ./
   claude plugin install inbox@claude-mods
   ```

3. Edit `<mod>/hooks/register.tsx`, then start a new Claude Code session to load the change.
4. Run the tests and the manifest check:

   ```sh
   claude plugin test inbox
   claude plugin test gh-helper
   claude plugin validate .
   ```

CI runs the same commands on every PR.

## Pull requests

- One change per PR. Add or update a test for behaviour changes.
- Update the mod's `README.md` when you change a command, key, or what the mod stores or adds to the prompt.
- If you change the `SYSTEM` prompt text in inbox, say why in the PR: every user of the mod pays for it on every session.
- Leave the version alone; it is bumped at release time.

## Releases (maintainer)

1. Bump `version` in `<mod>/.claude-plugin/plugin.json`.
2. Add an entry to [CHANGELOG.md](CHANGELOG.md).
3. Tag it: `claude plugin tag <mod>` creates `<mod>--v<version>`. Push the tag.
