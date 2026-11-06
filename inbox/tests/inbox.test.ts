import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ASK = 'mcp__inbox__inbox_ask'
const RESOLVE = 'mcp__inbox__inbox_resolve'
const IDEA = 'mcp__inbox__idea_add'
const IDEA_DONE = 'mcp__inbox__idea_done'
const PANE_PROPS = {
  title: 'Inbox',
  isFocused: true,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
} as const

type Opened = { id: string; title?: string; focus?: true }
type Seen = {
  statuses: (string | undefined)[]
  context: readonly string[]
  filled: string
  closed: number
  opens: Opened[]
  pane: { title: string } | undefined
  store: Map<string, unknown>
  // File contents by absolute path: the fake disk under $.fs.
  disk: Map<string, string>
}

// What the engine answers beneath the plugin in a live session, recording
// what the plugin hands it.
type World = { root?: string; dirs?: readonly string[]; files?: Readonly<Record<string, string>> }

function engine(on: On, world: World = {}): Seen {
  const dirs = new Set(world.dirs ?? [])
  const seen: Seen = {
    statuses: [],
    context: [],
    filled: '',
    closed: 0,
    opens: [],
    pane: undefined,
    store: new Map(),
    disk: new Map(Object.entries(world.files ?? {})),
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'session-a' }))
  on('session.root', () => ({ value: world.root ?? '/tmp/proj' }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/u' : undefined }))
  on('fs.exists', (_, e) => ({ value: seen.disk.has(e.path) || dirs.has(e.path) }))
  on('fs.read', (_, e) => {
    const text = seen.disk.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', (_, e) => {
    seen.disk.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.stat', (_, e) =>
    dirs.has(e.path)
      ? { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
      : { deny: `ENOENT: ${e.path}` },
  )
  on('process.run', (_, e) => {
    const ran = (exitCode: number) => ({
      value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [command, , from, to] = e.argv
    if (command === 'mv' && from !== undefined && to !== undefined && seen.disk.has(from)) {
      seen.disk.set(to, seen.disk.get(from) ?? '')
      seen.disk.delete(from)
      return ran(0)
    }
    return ran(128)
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__inbox__${e.name}` } }))
  on('ui.status', (_, e) => {
    seen.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.close', () => {
    seen.closed += 1
    seen.pane = undefined
    return { value: undefined }
  })
  on('ui.panes', () => ({
    value:
      seen.pane === undefined
        ? []
        : [{ id: 'inbox', title: seen.pane.title, isShown: false, isFocused: false, isPlaced: true }],
  }))
  on('ui.open', (_, e) => {
    seen.opens.push({ id: e.id, title: e.title, focus: e.focus })
    seen.pane = { title: e.title ?? e.id }
    return { value: { isPlaced: true } }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    seen.filled = e.text
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', (_, e) => {
    seen.context = e.context ?? []
    return { text: e.text }
  })
  mock.clock(on, { now: Date.UTC(2026, 9, 7, 12) })
  on('store.get', (_, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', (_, e) => {
    seen.store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  return seen
}

describe('inbox', () => {
  test('files a question, counts it, and drops it when a reply quotes it', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj', surface: 'terminal', isInteractive: true })

    const filed = await $.tool.call({ tool: ASK, subject: 'Which DB?', body: 'Postgres or SQLite?' })
    expect(JSON.stringify(filed)).toContain('inbox #1')
    expect(seen.statuses.at(-1)).toBe('inbox 1')

    await $.tool.call({ tool: ASK, subject: 'Deploy now?', body: 'Staging is green.' })
    expect(seen.statuses.at(-1)).toBe('inbox 2')

    await $.prompt.submit({ text: '> [inbox #1] Which DB?\n\nPostgres.', wait: false, origin: { kind: 'composer' } })
    expect(seen.statuses.at(-1)).toBe('inbox 1')
    expect(seen.context.join('\n')).toContain('#2 Deploy now?')
    expect(seen.context.join('\n')).not.toContain('#1 Which DB?')

    await $.tool.call({ tool: RESOLVE, ids: [2] })
    expect(seen.statuses.at(-1)).toBeUndefined()
  })

  test('the pane replies by quoting the item into the prompt', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj2', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'Rename the table?', body: 'users -> accounts' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'inbox', surface, component: 'Pane', requestId: 'inbox', props: PANE_PROPS })
      expect(await ui.find({ text: /Rename the table\?/ })).toBeDefined()
      await ui.press({ key: 'reply' })
      expect(seen.filled).toContain('> [inbox #1] Rename the table?')
      expect(seen.filled).toContain('> users -> accounts')
      await ui.unmount()
    }
    expect(seen.closed).toBe(2)
  })

  test('retitles an open pane tab as the count changes, without taking focus', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj3', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'One', body: '' })
    expect(seen.opens).toEqual([])

    seen.pane = { title: 'Inbox (1)' }
    await $.tool.call({ tool: ASK, subject: 'Two', body: '' })
    expect(seen.opens.at(-1)).toEqual({ id: 'inbox', title: 'Inbox (2)', focus: undefined })

    const closedBefore = seen.closed
    await $.tool.call({ tool: RESOLVE, ids: [1, 2] })
    expect(seen.closed).toBe(closedBefore + 1)
    expect(seen.opens.every(one => one.focus === undefined)).toBe(true)
  })

  test('draws an inbox_ask call as the question, not as a tool row', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/tmp/proj4', surface: 'terminal', isInteractive: true })
    const props = {
      tool_use_id: 'tu1',
      tool: ASK,
      input: { subject: 'Which cache?', body: 'LSCache or **Redis**?' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: 'Filed as inbox #4. Keep working.',
    }
    for (const surface of ['terminal', 'desktop'] as const) {
      const row = await $.ui.mount({ plugin: 'inbox', surface, component: 'ToolUse', requestId: 'tu1', props })
      expect(await row.find({ type: 'Text', text: 'Which cache?' })).toBeDefined()
      expect(await row.find({ text: /LSCache or/ })).toBeDefined()
      expect(await row.find({ text: /Inbox #4/ })).toBeDefined()
      await row.unmount()

      const result = await $.ui.mount({
        plugin: 'inbox',
        surface,
        component: 'ToolResult',
        requestId: 'tu1',
        props: { tool_use_id: 'tu1', tool: ASK, output: props.output, isErrored: false },
      })
      expect(await result.find({ text: /Filed as/ })).toBeUndefined()
      await result.unmount()
    }
  })

  test('outside git, the nearest parent with CLAUDE.md or .claude/ is the project', async ($, on) => {
    const seen = engine(on, { root: '/home/u/work/site/theme', files: { '/home/u/work/site/CLAUDE.md': '' } })
    await $.session.start({ cwd: '/home/u/work/site/theme/deep', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'Where?', body: '' })
    expect([...seen.store.keys()]).toEqual(['project:/home/u/work/site'])
  })

  test("home's own .claude/ never makes home the project", async ($, on) => {
    const seen = engine(on, { root: '/home/u/notes', dirs: ['/home/u/.claude'] })
    await $.session.start({ cwd: '/home/u/notes', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'Where?', body: '' })
    expect([...seen.store.keys()]).toEqual(['project:/home/u/notes'])
  })

  test('replying with other items left brings the pane back without focus', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj6', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'First', body: '' })
    await $.tool.call({ tool: ASK, subject: 'Second', body: '' })

    const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE_PROPS })
    await ui.press({ key: 'reply' })
    expect(seen.filled).toContain('[inbox #1] First')
    expect(seen.closed).toBe(1)
    expect(seen.opens.at(-1)).toEqual({ id: 'inbox', title: 'Inbox (2)', focus: undefined })
    expect(await ui.find({ type: 'Text', text: /#2 Second/ })).toBeDefined()
    await ui.unmount()
  })

  test('records ideas and counts open ones beside the inbox', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj7', surface: 'terminal', isInteractive: true })
    const added = await $.tool.call({ tool: IDEA, title: 'Inbox digest email', description: 'Mail a daily digest.' })
    expect(JSON.stringify(added)).toContain('idea #1')
    expect(seen.statuses.at(-1)).toBe('ideas 1')
    await $.tool.call({ tool: ASK, subject: 'Q', body: '' })
    expect(seen.statuses.at(-1)).toBe('inbox 1 · ideas 1')
  })

  test('an older store record without ideas still loads', async ($, on) => {
    const seen = engine(on)
    seen.store.set('project:/tmp/proj', {
      nextId: 4,
      items: [{ id: 3, subject: 'Old', body: '', createdAt: 0, sessionId: 'x' }],
    })
    await $.session.start({ cwd: '/tmp/proj', surface: 'terminal', isInteractive: true })
    expect(seen.statuses.at(-1)).toBe('inbox 1')
    await $.tool.call({ tool: IDEA, title: 'New', description: '' })
    expect(seen.statuses.at(-1)).toBe('inbox 1 · ideas 1')
  })

  test('the ideas half discusses, edits, marks done and deletes', async ($, on) => {
    const seen = engine(on)
    await $.session.start({ cwd: '/tmp/proj8', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: ASK, subject: 'A question', body: '' })
    await $.tool.call({ tool: IDEA, title: 'Dark mode', description: 'Theme the pane.' })

    const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: PANE_PROPS })
    expect(await ui.find({ text: /A question/ })).toBeDefined()
    expect(await ui.find({ text: /Dark mode/ })).toBeDefined()
    expect(await ui.find({ key: 'discuss' })).toBeUndefined()

    await ui.press({ key: 'switch' })
    expect(await ui.find({ key: 'reply' })).toBeUndefined()

    await ui.press({ key: 'discuss' })
    expect(seen.filled).toContain('> [idea #1] Dark mode')
    expect(seen.filled).toContain('> Theme the pane.')

    await ui.press({ key: 'edit' })
    await ui.input({ key: 'edit-title', text: 'Dark mode toggle' })
    expect(await ui.find({ text: /#1 Dark mode toggle/ })).toBeDefined()

    await ui.press({ key: 'done' })
    expect(seen.statuses.at(-1)).toBe('inbox 1')
    expect(await ui.find({ text: /\[done\] Dark mode toggle/ })).toBeDefined()

    await ui.press({ key: 'delete' })
    expect(await ui.find({ text: /Dark mode/ })).toBeUndefined()
    await ui.unmount()
  })

  test('ideas live in ~/.claude/ideas.json under the project root', async ($, on) => {
    const other = { nextId: 2, ideas: [{ id: 1, title: 'Theirs', description: '', createdAt: 0, isDone: false }] }
    const seen = engine(on, {
      root: '/tmp/proj9',
      files: { '/home/u/.claude/ideas.json': JSON.stringify({ version: 1, projects: { '/elsewhere': other } }) },
    })
    await $.session.start({ cwd: '/tmp/proj9', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: IDEA, title: 'Mine', description: 'Kept on disk.' })

    const written = JSON.parse(seen.disk.get('/home/u/.claude/ideas.json') ?? '{}')
    expect(written.projects['/tmp/proj9'].ideas[0].title).toBe('Mine')
    expect(written.projects['/elsewhere']).toEqual(other)
    expect([...seen.disk.keys()].some(path => path.endsWith('.tmp'))).toBe(false)
    expect(seen.store.get('project:/tmp/proj9')).toBeUndefined()
  })

  test('ideas left in the plugin store move to the file once', async ($, on) => {
    const seen = engine(on, { root: '/tmp/proj10' })
    seen.store.set('project:/tmp/proj10', {
      nextId: 2,
      items: [{ id: 1, subject: 'Q', body: '', createdAt: 0, sessionId: 'x' }],
      nextIdeaId: 2,
      ideas: [{ id: 1, title: 'Old idea', description: '', createdAt: 5, isDone: false }],
    })
    await $.session.start({ cwd: '/tmp/proj10', surface: 'terminal', isInteractive: true })

    const written = JSON.parse(seen.disk.get('/home/u/.claude/ideas.json') ?? '{}')
    expect(written.projects['/tmp/proj10']).toEqual({
      nextId: 2,
      ideas: [{ id: 1, title: 'Old idea', description: '', createdAt: 5, isDone: false }],
    })
    expect(seen.store.get('project:/tmp/proj10')).toEqual({
      nextId: 2,
      items: [{ id: 1, subject: 'Q', body: '', createdAt: 0, sessionId: 'x' }],
    })
    expect(seen.statuses.at(-1)).toBe('inbox 1 · ideas 1')
  })

  test('an ideas.json that does not parse is never written over', async ($, on) => {
    const seen = engine(on, { root: '/tmp/proj11', files: { '/home/u/.claude/ideas.json': '{ broken' } })
    await $.session.start({ cwd: '/tmp/proj11', surface: 'terminal', isInteractive: true })
    const added = await $.tool.call({ tool: IDEA, title: 'Lost?', description: '' })
    expect(JSON.stringify(added)).toContain('could not record')
    expect(seen.disk.get('/home/u/.claude/ideas.json')).toBe('{ broken')
  })

  test('All lists every project, flags moved folders, and Move here re-files them', async ($, on) => {
    const idea = (id: number, title: string) => ({ id, title, description: '', createdAt: 0, isDone: false })
    const seen = engine(on, {
      root: '/home/u/new-site',
      dirs: ['/home/u/new-site', '/home/u/other'],
      files: {
        '/home/u/.claude/ideas.json': JSON.stringify({
          version: 1,
          projects: {
            '/home/u/new-site': { nextId: 2, ideas: [idea(1, 'Here')] },
            '/home/u/old-site': { nextId: 3, ideas: [idea(1, 'Moved A'), idea(2, 'Moved B')] },
            '/home/u/other': { nextId: 2, ideas: [idea(1, 'Elsewhere')] },
          },
        }),
      },
    })
    await $.session.start({ cwd: '/home/u/new-site', surface: 'terminal', isInteractive: true })
    const tall = { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 40 } }
    const ui = await $.ui.mount({ plugin: 'inbox', surface: 'terminal', component: 'Pane', requestId: 'inbox', props: tall })
    expect(await ui.find({ key: 'head-ideas', text: 'Ideas (1)' })).toBeDefined()
    expect(await ui.find({ key: 'head-all', text: 'All (4)' })).toBeDefined()
    expect(await ui.find({ text: /Moved A/ })).toBeUndefined()

    await ui.press({ key: 'head-all' })
    expect(await ui.find({ text: /~\/old-site  \(folder missing\)/ })).toBeDefined()
    expect(await ui.find({ text: /~\/other$/ })).toBeDefined()
    expect(await ui.find({ key: 'adopt-/home/u/new-site' })).toBeUndefined()

    await ui.press({ key: 'adopt-/home/u/old-site' })
    const written = JSON.parse(seen.disk.get('/home/u/.claude/ideas.json') ?? '{}')
    expect(written.projects['/home/u/old-site']).toBeUndefined()
    expect(written.projects['/home/u/new-site'].ideas.map((one: { id: number; title: string }) => `${one.id} ${one.title}`)).toEqual([
      '1 Here',
      '2 Moved A',
      '3 Moved B',
    ])
    expect(written.projects['/home/u/new-site'].nextId).toBe(4)
    expect(await ui.find({ key: 'head-ideas', text: 'Ideas (3)' })).toBeDefined()
    expect(seen.statuses.at(-1)).toBe('ideas 3')
    await ui.unmount()
  })

  test('idea_done marks an idea done with a stamp; quoting an idea asks for it', async ($, on) => {
    const seen = engine(on, { root: '/tmp/proj13' })
    await $.session.start({ cwd: '/tmp/proj13', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: IDEA, title: 'Auto cleanup', description: 'Purge done ideas.' })

    await $.prompt.submit({ text: '> [idea #1] Auto cleanup\n> Purge done ideas.\n\nGo.', wait: false, origin: { kind: 'composer' } })
    expect(seen.context.join('\n')).toContain('call mcp__inbox__idea_done with [1]')

    const done = await $.tool.call({ tool: IDEA_DONE, ids: [1] })
    expect(JSON.stringify(done)).toContain('Marked done: #1')
    const written = JSON.parse(seen.disk.get('/home/u/.claude/ideas.json') ?? '{}')
    expect(written.projects['/tmp/proj13'].ideas[0]).toMatchObject({ isDone: true, doneAt: Date.UTC(2026, 9, 7, 12) })
    expect(seen.statuses.at(-1)).toBeUndefined()

    await $.prompt.submit({ text: '> [idea #1] Auto cleanup\n\nAgain.', wait: false, origin: { kind: 'composer' } })
    expect(seen.context.join('\n')).not.toContain('idea_done')
  })

  test('done ideas older than 7 days are purged in every project; unstamped ones get stamped', async ($, on) => {
    const now = Date.UTC(2026, 9, 7, 12)
    const day = 24 * 60 * 60 * 1000
    const idea = (id: number, extra: object) => ({ id, title: `I${id}`, description: '', createdAt: 0, ...extra })
    const seen = engine(on, {
      root: '/tmp/proj14',
      files: {
        '/home/u/.claude/ideas.json': JSON.stringify({
          version: 1,
          projects: {
            '/tmp/proj14': {
              nextId: 4,
              ideas: [
                idea(1, { isDone: true, doneAt: now - 8 * day }),
                idea(2, { isDone: true, doneAt: now - 2 * day }),
                idea(3, { isDone: false }),
              ],
            },
            '/elsewhere': { nextId: 3, ideas: [idea(1, { isDone: true, doneAt: now - 30 * day }), idea(2, { isDone: true })] },
          },
        }),
      },
    })
    await $.session.start({ cwd: '/tmp/proj14', surface: 'terminal', isInteractive: true })

    const written = JSON.parse(seen.disk.get('/home/u/.claude/ideas.json') ?? '{}')
    expect(written.projects['/tmp/proj14'].ideas.map((one: { id: number }) => one.id)).toEqual([2, 3])
    expect(written.projects['/elsewhere'].ideas).toEqual([idea(2, { isDone: true, doneAt: now })])
  })
})
