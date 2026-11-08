# Recordings

The GIFs are recorded with [VHS](https://github.com/charmbracelet/vhs) against demo data, never a real project.

1. Clone the demo repository: `git clone https://github.com/emreerkan/claude-mods-demo ~/Development/claude-mods-demo`. Its issues, PRs and project board (#2) feed the gh-helper pane.
2. Seed the inbox: `python3 docs/media/demo-data.py seed`.
3. Record from the repository root: `vhs docs/media/inbox.tape`, then `vhs docs/media/gh-helper.tape`. Record the inbox first: once gh-helper has a setting for the demo folder, its pane opens by itself in wide terminals.
4. Remove the inbox demo data: `python3 docs/media/demo-data.py remove`.

The tapes start Claude Code with the variables of a parent Claude session unset, so you can also run them from inside one. The first launch in the demo folder asks whether you trust it; the tape answers yes.
