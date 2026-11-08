#!/usr/bin/env python3
"""Seed or remove the inbox demo data used by inbox.tape.

    python3 docs/media/demo-data.py seed   [demo-dir]
    python3 docs/media/demo-data.py remove [demo-dir]

demo-dir defaults to ~/Development/claude-mods-demo, a clone of
https://github.com/emreerkan/claude-mods-demo. The store file name follows
Claude Code's internal scheme (<plugin>_<marketplace>-<sha256(plugin@marketplace)[:12]>.json),
which is not a documented API.
"""
import hashlib
import json
import os
import sys
import time

action = sys.argv[1] if len(sys.argv) > 1 else ''
root = os.path.realpath(os.path.expanduser(sys.argv[2] if len(sys.argv) > 2 else '~/Development/claude-mods-demo'))
config = os.environ.get('CLAUDE_CONFIG_DIR', os.path.expanduser('~/.claude'))
store = os.path.join(config, 'plugins', 'store', 'inbox_claude-mods-%s.json' % hashlib.sha256(b'inbox@claude-mods').hexdigest()[:12])
ideas_path = os.path.expanduser('~/.claude/ideas.json')
key = 'project:' + root


def load(path, empty):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return empty


def save(path, data):
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
        f.write('\n')


now = int(time.time() * 1000)
hour = 3600_000
s = load(store, {})
ideas = load(ideas_path, {'version': 1, 'projects': {}})

if action == 'seed':
    s[key] = {'nextId': 3, 'items': [
        {'id': 1, 'subject': 'orders.status: ALTER in place or add a column?',
         'body': 'The enum migration (#3) touches 2.1M rows. ALTER in place locks `orders` for ~40s; a new column with a backfill needs no lock but three deploys.\n\nI recommend the new column. Writing the rollback meanwhile.',
         'createdAt': now - 2 * hour, 'sessionId': 'demo'},
        {'id': 2, 'subject': 'Rate limit login per IP or per account?',
         'body': 'Per IP blocks a whole office behind one NAT; per account lets one IP spray many accounts.\n\nI recommend both: 5/min per account, 50/min per IP.',
         'createdAt': now - 25 * 60_000, 'sessionId': 'demo'},
    ]}
    ideas['projects'][root] = {'nextId': 4, 'ideas': [
        {'id': 1, 'title': 'Nightly digest of open pings', 'description': 'Each morning, a short summary of to-claude issues that nobody touched for 24h.', 'createdAt': now - 72 * hour, 'isDone': False},
        {'id': 2, 'title': 'Replay failed webhooks from the admin page', 'description': 'A button per failed delivery, with the last response body.', 'createdAt': now - 48 * hour, 'isDone': False},
        {'id': 3, 'title': 'Seed script for local dev data', 'description': '', 'createdAt': now - 120 * hour, 'isDone': True, 'doneAt': now - 24 * hour},
    ]}
elif action == 'remove':
    s.pop(key, None)
    ideas['projects'].pop(root, None)
else:
    sys.exit(__doc__)

save(store, s)
save(ideas_path, ideas)
print('%s: %s' % (action, root))
