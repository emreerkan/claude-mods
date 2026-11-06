# claude-mods

Claude Code mods by Emre Erkan, published as a plugin marketplace.

| Mod | What it does |
|---|---|
| [inbox](inbox/README.md) | When Claude needs a decision but keeps working, it files the question in an inbox pane instead of burying it in scrollback. Also keeps a per-project ideas list. |
| [gh-helper](gh-helper/README.md) | Side pane with GitHub pings (issues/PRs carrying a routing label), the In progress items of a GitHub Project, and open PRs. |

## Install

```sh
claude plugin marketplace add emreerkan/claude-mods
claude plugin install inbox@emre-mods
claude plugin install gh-helper@emre-mods
```

Or from inside Claude Code: `/plugin marketplace add emreerkan/claude-mods`, then `/plugin install inbox@emre-mods`.

## Develop

Each mod is a plugin whose `hooks/hooks.json` loads a `register.tsx` module. Run a mod's tests with:

```sh
claude plugin test inbox
claude plugin test gh-helper
```

## License

MIT
