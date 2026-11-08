# Changelog

Each mod is versioned on its own. Tags use the form `<mod>--v<version>`.

## Unreleased

- Marketplace renamed from `emre-mods` to `claude-mods`. If you installed from the old name, run:

  ```sh
  claude plugin marketplace remove emre-mods
  claude plugin marketplace add emreerkan/claude-mods
  claude plugin install inbox@claude-mods      # and/or gh-helper@claude-mods
  ```

## inbox 0.1.0

First public release: inbox pane for Claude's questions, per-project ideas list, `/inbox` and `/ideas`.

## gh-helper 0.4.0

First public release: pings, In progress and Open PRs sections; per-directory settings; repo-only mode; shared fetch cache and rate-limit backoff.
