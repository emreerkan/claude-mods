import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const typed = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 160 } }
const NOW = Date.parse('2026-10-06T01:00:00Z')
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const fail = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })

const ping = { repository: { name: 'api' }, number: 159, title: 'Footer copy', url: 'https://github.com/acme/api/pull/159',
  updatedAt: '2026-10-06T00:30:00Z', commentsCount: 3 }
const openPr = { repository: { name: 'api' }, number: 7, title: 'Fix auth', url: 'https://github.com/acme/api/pull/7',
  updatedAt: '2026-10-06T00:00:00Z', author: { login: 'dev' }, isDraft: true, commentsCount: 1 }
const projectPage = JSON.stringify({ data: { owner: { projectV2: { items: {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: [
    { content: { __typename: 'Issue', number: 79, title: 'Build it', url: 'https://github.com/acme/api/issues/79',
      repository: { name: 'api' }, assignees: { nodes: [{ login: 'emre' }] }, labels: { nodes: [] }, comments: { totalCount: 0 } } },
    { content: { __typename: 'Issue', number: 7, title: 'Epic', url: 'https://github.com/acme/api/issues/7',
      repository: { name: 'api' }, assignees: { nodes: [] }, labels: { nodes: [{ name: 'epic' }] } } },
  ],
} } } } })

// The world beneath the plugin, and a log of every gh call it made.
function world(on: On, store: Record<string, unknown> = {}, rateLimited = false) {
  mock.store(on, store)
  mock.clock(on, { now: NOW })
  on('session.cwd', async () => ({ value: '/work/acme' }))
  on('ui.open', async () => ({ value: { isPlaced: true as const } }))
  on('ui.status', async () => ({ value: undefined }))
  const calls: string[][] = []
  on('process.run', async (_$, e) => {
    const argv = [...e.argv]
    calls.push(argv)
    if (argv[1] === 'api' && argv[2] === 'rate_limit') {
      return ok(JSON.stringify({ resources: { graphql: { remaining: 0, reset: NOW / 1000 + 1800 } } }))
    }
    if (argv[1] === 'api' && argv[2] === 'graphql') {
      return rateLimited ? fail('GraphQL: API rate limit exceeded for user ID 1.') : ok(projectPage)
    }
    if (argv.includes('--project')) return ok(JSON.stringify([openPr]))
    if (argv[1] === 'search' && !argv.includes('--label')) {
      return ok(JSON.stringify(argv[2] === 'issues' ? [{ ...ping, number: 5, url: 'https://github.com/acme/web/issues/5' }] : [openPr, ping]))
    }
    if (argv[1] === 'search' && argv[2] === 'prs') return ok(JSON.stringify([ping]))
    return ok('[]')
  })
  return calls
}

const mountPane = ($: Engine) => $.ui.mount({
  plugin: 'gh-helper', surface: 'terminal', component: 'Pane', requestId: 'gh-helper',
  props: { title: 'GitHub · acme', isFocused: true, bodyColumns: 58, placement: 'dock', scroll: { offset: 0, bodyRows: 38 }, view: {} }, viewport: { columns: 60, rows: 40 },
})

test('asks for the owner, label and project before the first search', async $ => {
  const { text } = await $.command.run({ command: 'gh-helper', args: '', ...typed })
  expect(text).toContain('Usage: /gh-helper <owner>[/<repo>] <label> [project-number]')
})

test('lists open PRs on the project board in a third section', async ($, on) => {
  const calls = world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  expect(text).toContain('1 open PR(s)')
  const prSearch = calls.find(argv => argv.includes('--project'))
  expect(prSearch).toContain('acme/3')
  expect(prSearch).not.toContain('--label')
})

test('asks GitHub for the In progress items only, never the whole board', async ($, on) => {
  const calls = world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  expect(text).toContain('2 in progress')
  expect(calls.some(argv => argv[1] === 'project')).toBe(false)
  const query = calls.find(argv => argv[2] === 'graphql')?.find(arg => arg.startsWith('query=')) ?? ''
  expect(query).toContain('status:\\"In progress\\"')
})

test('the In progress header counts epics, as the command does', async ($, on) => {
  world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  expect(text).toContain('2 in progress')
  const pane = await mountPane($)
  expect(await pane.find({ text: 'In progress · project 3 (2)' })).toBeDefined()
  expect(await pane.find({ text: '+1 epic in progress' })).toBeDefined()
})

test('a fresh shared result is reused instead of fetched again', async ($, on) => {
  const cache = {
    key: 'acme|to-claude|3', checkedAt: new Date(NOW - 60 * 1000).toISOString(), rateLimitedUntil: null,
    pings: { items: [], error: null }, inProgress: { items: [], error: null }, openPrs: { items: [], error: null },
  }
  const calls = world(on, { configs: { '/work/acme': { owner: 'acme', label: 'to-claude', project: 3 } }, cache })
  on('command.register', async () => ({ value: { command: 'gh-helper' } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  expect(calls.filter(argv => argv[0] === 'gh')).toHaveLength(0)
})

test('a rate limit pauses fetching and keeps the last result', async ($, on) => {
  const calls = world(on, {}, true)
  await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  const pane = await mountPane($)
  expect(await pane.find({ text: /Rate-limited until/ })).toBeDefined()
  const before = calls.length
  await pane.press({ key: 'refresh' })
  expect(calls.length).toBe(before)
})

test('the check mark drops a ping until it has new activity', async ($, on) => {
  world(on)
  await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  const pane = await mountPane($)
  expect(await pane.find({ text: 'PR api#159' })).toBeDefined()
  await pane.press({ key: `done:${ping.url}` })
  expect(await pane.find({ text: 'PR api#159' })).toBeUndefined()
  expect(await pane.find({ key: 'restore' })).toBeDefined()
  await pane.press({ key: 'restore' })
  expect(await pane.find({ text: 'PR api#159' })).toBeDefined()
})

test('an owner/repo setting narrows every search to that repository', async ($, on) => {
  const calls = world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme/web to-claude 3', ...typed })
  const searches = calls.filter(argv => argv[1] === 'search')
  expect(searches).toHaveLength(3)
  for (const argv of searches) {
    expect(argv).toContain('acme/web')
    expect(argv).not.toContain('--owner')
  }
  expect(calls.find(argv => argv.includes('--project'))).toContain('acme/3')
  // The board's two items are in acme/api, so none are kept.
  expect(text).toContain('0 in progress')
})

test('a malformed owner/repo is refused', async ($, on) => {
  world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme/web/extra to-claude', ...typed })
  expect(text).toContain('Usage:')
})

test('owner/repo with no label is repo-only: open issues and PRs, no pings or project', async ($, on) => {
  const calls = world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme/web', ...typed })
  expect(text).toBe('acme/web: 1 open issue(s), 2 open PR(s).')
  expect(calls.some(argv => argv.includes('--label') || argv.includes('--project') || argv[2] === 'graphql')).toBe(false)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^Pings/ })).toBeUndefined()
  expect(await pane.find({ text: /^In progress/ })).toBeUndefined()
  expect(await pane.find({ text: 'Open issues (1)' })).toBeDefined()
  expect(await pane.find({ text: 'Open PRs (2)' })).toBeDefined()
})

test('an owner with no label and no repo is refused', async ($, on) => {
  world(on)
  const { text } = await $.command.run({ command: 'gh-helper', args: 'acme', ...typed })
  expect(text).toContain('Usage:')
})

test('a result saved by an older version, missing a section, still draws', async ($, on) => {
  const cache = {
    key: 'acme/web||', checkedAt: new Date(NOW - 60 * 1000).toISOString(), rateLimitedUntil: null,
    pings: { items: [], error: null }, inProgress: { items: [], error: null }, openPrs: { items: [], error: null },
  }
  const calls = world(on, { configs: { '/work/acme': { owner: 'acme', repo: 'web', label: null, project: null } }, cache })
  on('command.register', async () => ({ value: { command: 'gh-helper' } }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/work/acme', surface: 'terminal', isInteractive: true })
  expect(calls).toHaveLength(0)
  const pane = await mountPane($)
  expect(await pane.find({ text: /^Open issues/ })).toBeDefined()
})

test('shows the comment count beside each link, and nothing when there are none', async ($, on) => {
  const calls = world(on)
  await $.command.run({ command: 'gh-helper', args: 'acme to-claude 3', ...typed })
  const pane = await mountPane($)
  expect(await pane.find({ text: ' · 3 comments' })).toBeDefined()
  expect(await pane.find({ text: ' · 1 comment' })).toBeDefined()
  expect(await pane.find({ text: / · 0 comment/ })).toBeUndefined()
  for (const argv of calls.filter(argv => argv[1] === 'search')) {
    expect(argv.find(arg => arg.includes('commentsCount'))).toBeDefined()
  }
  expect(calls.find(argv => argv[2] === 'graphql')?.find(arg => arg.includes('comments { totalCount }'))).toBeDefined()
})
