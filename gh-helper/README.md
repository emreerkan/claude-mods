# gh-helper

A Claude Code side pane in three sections:

- **Pings:** open GitHub issues and pull requests in an organization that carry a routing label.
- **In progress:** items whose Status is "In progress" on a GitHub Project of that organization, with assignees. Epics (label `epic`) are counted, not listed.
- **Open PRs:** open pull requests in that organization that are on the same GitHub Project, with author and draft marker.

It refreshes every 5 minutes with the `gh` CLI. Sessions on the same setting share one fetch per period (cached in the plugin store), and the In progress query asks GitHub for those items only, so a refresh costs a few GraphQL points rather than one per board item. On a rate limit the pane keeps the last result and pauses until the limit resets.

## Install

```
claude plugin marketplace add emreerkan/claude-mods
claude plugin install gh-helper@emre-mods
```

Requires an authenticated `gh` CLI with the `project` scope (`gh auth refresh -s project`).

## Use

- `/gh-helper <owner>[/<repo>] <label> [project-number]` saves the setting for the current working directory and opens the pane. Sessions started in that directory, or in any folder below it, use it automatically. With `owner/repo` every section covers that one repository; the project still belongs to the owner, and its draft items are left out.
- `/gh-helper <owner>/<repo>` with no label is repo-only mode: the pane shows that repository's open issues and open PRs, with no pings and no project.
- `/gh-helper` opens the pane with the saved setting. `r` (or the Refresh button) refreshes now.
- A ping drops out once it is closed, merged or loses the label. To clear one sooner, press its `✓`: it stays hidden until it has new activity. `u` ("N done · show") brings the hidden ones back.
- The status line shows the number of open pings. The pane opens by itself at session start when the terminal is at least 144 columns wide.
