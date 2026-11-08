# Changelog

Each mod is versioned on its own. Tags use the form `<mod>--v<version>`.

## Unreleased

- Marketplace renamed from `emre-mods` to `claude-mods`. Claude Code keeps each plugin's data in a file named after its marketplace, so copy your open questions and gh-helper settings to the new name first (uninstalling keeps the old files):

  ```sh
  S="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/store"
  for p in inbox gh-helper; do
    for f in "$S/${p}_emre-mods-"*.json; do
      [ -e "$f" ] && cp -n "$f" "$S/${p}_claude-mods-$(printf '%s' "$p@claude-mods" | shasum -a 256 | cut -c1-12).json"
    done
  done
  ```

  Then switch the install:

  ```sh
  claude plugin uninstall inbox@emre-mods; claude plugin uninstall gh-helper@emre-mods
  claude plugin marketplace remove emre-mods
  claude plugin marketplace add emreerkan/claude-mods
  claude plugin install inbox@claude-mods      # and/or gh-helper@claude-mods
  ```

## inbox 0.1.0

First public release: inbox pane for Claude's questions, per-project ideas list, `/inbox` and `/ideas`.

## gh-helper 0.4.0

First public release: pings, In progress and Open PRs sections; per-directory settings; repo-only mode; shared fetch cache and rate-limit backoff.
