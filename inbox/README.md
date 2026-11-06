# inbox

A project-bound inbox for the questions Claude asks while it keeps working.

When Claude needs a decision from you but has other work running (subagents, workflows, pending tasks), a question in prose scrolls away. This mod gives Claude an `inbox_ask` tool instead: the question lands in an inbox pane with a subject and a self-contained body, and Claude carries on with work that doesn't depend on the answer.

It also keeps an ideas list. Say "idea: …" or "what if we someday …" and Claude records it with `idea_add` without starting on it. Ideas are marked done when the work is built and verified, and done ideas are purged after 7 days.

## Install

```sh
claude plugin marketplace add emreerkan/claude-mods
claude plugin install inbox@emre-mods
```

## Use

- `/inbox` opens the questions and ideas for the current project; `/ideas` opens the ideas.
- Reply to an item with `r`: the pane quotes it into the prompt as `[inbox #N]`, and sending the reply resolves it.
- Open items are bound to the project directory, so a question asked in one session can be answered in a later one.

## Data

- Questions: the plugin store, keyed by project.
- Ideas: `~/.claude/ideas.json`.
