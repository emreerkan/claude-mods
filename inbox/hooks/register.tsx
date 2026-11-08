import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Idea,
  IdeaDraft,
  IdeaProject,
  IdeaScope,
  IdeasFile,
  InboxFile,
  InboxItem,
  LegacyInboxFile,
  ProjectIdeas,
  Section,
} from '../types'

const PANE = 'inbox'
const MARKER = /\[inbox #(\d+)\]/g
const IDEA_MARKER = /\[idea #(\d+)\] ([^\n]*)/g
const POLL_MS = 5000
const PANE_ROWS = 28
const DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PURGE_EVERY_MS = 60 * 60 * 1000
const ASK_TOOL = 'mcp__inbox__inbox_ask'
const RESOLVE_TOOL = 'mcp__inbox__inbox_resolve'
const IDEA_TOOL = 'mcp__inbox__idea_add'
const IDEA_DONE_TOOL = 'mcp__inbox__idea_done'
const NO_DRAFT: IdeaDraft = { root: '', id: 0, title: '', description: '' }

const items = atom({ plugin: 'inbox', key: 'items' } as const, [])
const selected = atom({ plugin: 'inbox', key: 'selected' } as const, 0)
const sessionIdRef = atom({ plugin: 'inbox', key: 'sessionId' } as const, '')
const ideas = atom({ plugin: 'inbox', key: 'ideas' } as const, [])
const allIdeas = atom({ plugin: 'inbox', key: 'allIdeas' } as const, [])
const ideaScope = atom({ plugin: 'inbox', key: 'ideaScope' } as const, 'project')
const ideaKey = atom({ plugin: 'inbox', key: 'ideaKey' } as const, '')
const section = atom({ plugin: 'inbox', key: 'section' } as const, 'inbox')
const draft = atom({ plugin: 'inbox', key: 'draft' } as const, NO_DRAFT)

const SYSTEM = `# Inbox
The user keeps an inbox for your questions. When you need a decision or information from the user but you are going to keep working (subagents or workflows still running, other tasks pending), do not leave the question in prose where it scrolls away: call mcp__inbox__inbox_ask with
- subject: one line, at most 70 characters, written like an email subject;
- body: self-contained context, the options, and your recommendation. It may be answered later, in a different session, by someone who no longer has this conversation in view.
The call is shown to the user as the question itself, so do not repeat it in prose. Then carry on with work that does not depend on the answer. Ask inline only when you are blocked and ending your turn anyway.
A user message containing "[inbox #N]" answers item N; it is already resolved. If the user answers an open item any other way, call mcp__inbox__inbox_resolve with its id.

# Ideas
When the user shares an idea to keep ("I have an idea", "idea:", "note this idea", "what if we someday..."), call mcp__inbox__idea_add with
- title: at most 60 characters, naming the idea;
- description: the idea as the user put it, tightened but not embellished, with any constraints or motivation they gave.
Then acknowledge in one line and continue with what you were doing. Do not start working on the idea unless asked. A user message quoting "[idea #N]" opens a discussion of idea N.
When work that develops a recorded idea is finished (built, verified, and reported), call mcp__inbox__idea_done with its id. Not for a partial step, a plan, or a discussion alone. Done ideas are purged after 7 days, so the user can reopen a wrong one in time.`

type $ = EngineInterface

const storeKey = (root: string) => `project:${root}`

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
const parentOf = (dir: string) => dir.slice(0, dir.lastIndexOf('/')) || '/'

async function isDir($: $, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'dir'
  } catch {
    return false
  }
}

// The git repository's root; outside one, the nearest directory at or above
// `start` holding a `.claude/` folder or a CLAUDE.md. Home itself never counts:
// its `.claude/` is the user's global one. Nothing found: `start`.
async function projectRoot($: $, start: string): Promise<string> {
  try {
    const git = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: start })
    const root = git.stdout.trim()
    if (git.exitCode === 0 && root !== '') return root
  } catch {
    // git missing: fall through to the marker walk
  }

  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  let dir = start.replace(/\/+$/, '') || '/'
  while (dir !== home) {
    if ((await isDir($, join(dir, '.claude'))) || (await $.fs.exists(join(dir, 'CLAUDE.md')))) return dir
    const parent = parentOf(dir)
    if (parent === dir) break
    dir = parent
  }
  return start
}

async function load($: $, root: string): Promise<InboxFile> {
  const raw = (await $.store.get(storeKey(root))) as Partial<InboxFile> | undefined
  return { nextId: raw?.nextId ?? 1, items: raw?.items ?? [] }
}

// ~/.claude/ideas.json, read whole. A file that is there but does not parse is
// `undefined`: the caller must not write over it, or a hand edit gone wrong
// would cost every project's ideas.
async function loadIdeasFile($: $, path: string): Promise<IdeasFile | undefined> {
  if (!(await $.fs.exists(path))) return { version: 1, projects: {} }
  try {
    const parsed = JSON.parse(await $.fs.read(path)) as Partial<IdeasFile>
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.projects !== 'object' || parsed.projects === null) {
      return undefined
    }
    return { version: 1, projects: parsed.projects }
  } catch {
    return undefined
  }
}

// Written beside the target and moved over it, so a crash mid-write leaves the
// old file whole; where the move fails, written in place.
async function writeIdeasFile($: $, path: string, file: IdeasFile) {
  const text = `${JSON.stringify(file, null, 2)}\n`
  const temp = `${path}.${(await $.clock.now()).toString(36)}.tmp`
  await $.fs.write(temp, text)
  const moved = await $.process.run(['mv', '-f', temp, path]).catch(() => undefined)
  if (moved?.exitCode !== 0) await $.fs.write(path, text)
}

const projectIdeas = (file: IdeasFile, root: string): IdeaProject => {
  const kept = file.projects[root]
  return { nextId: kept?.nextId ?? 1, ideas: kept?.ideas ?? [] }
}

type Shown = { items: readonly InboxItem[]; ideas: readonly Idea[] }

const openIdeas = (list: readonly Idea[]) => list.filter(idea => !idea.isDone)

// Open ideas first, done ones after, each group oldest first.
const ordered = (list: readonly Idea[]) => [...openIdeas(list), ...list.filter(idea => idea.isDone)]

function paneTitle(file: Shown) {
  const parts = [`Inbox (${file.items.length})`]
  if (file.ideas.length > 0) parts.push(`Ideas (${openIdeas(file.ideas).length})`)
  return parts.join(' · ')
}

function statusText(file: Shown) {
  const parts: string[] = []
  if (file.items.length > 0) parts.push(`inbox ${file.items.length}`)
  const open = openIdeas(file.ideas).length
  if (open > 0) parts.push(`ideas ${open}`)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

// Status line, plus the pane's tab label when the pane is open (it shows as a
// tab behind other panes). Re-opening an open id only retitles it; no `focus`
// is passed, so it never takes the keyboard from another pane. With nothing
// left in either half the pane closes.
async function reflect($: $, file: Shown) {
  $.ui.status(statusText(file))
  const title = paneTitle(file)
  try {
    const pane = (await $.ui.panes()).find(one => one.id === PANE)
    if (pane === undefined) return
    if (file.items.length === 0 && file.ideas.length === 0) await $.ui.close({ id: PANE })
    else if (pane.title !== title) await $.ui.open({ id: PANE, title, closeOnEscape: true })
  } catch {
    // a surface that lists no panes: the status line still carries the counts
  }
}

// Module state: reset on hot reload, re-established by session.start.
let root = ''
let ideasPath = ''
// Serializes this session's read-modify-writes of the store and the ideas file.
let queue: Promise<unknown> = Promise.resolve()

function queued<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work)
  queue = run.catch(() => undefined)
  return run
}

// Re-reads the store before every write so what other sessions on the same
// project wrote is not clobbered.
function mutate<T>($: $, fn: (file: InboxFile) => T): Promise<T> {
  return queued(async () => {
    const file = await load($, root)
    const out = fn(file)
    await $.store.set(storeKey(root), file)
    await update($, items, () => file.items)
    await reflect($, { items: file.items, ideas: await read($, ideas) })
    return out
  })
}

// The same for this project's entry in ~/.claude/ideas.json, re-read before
// every write; other projects' entries are written back as they were read.
function mutateIdeas<T>($: $, fn: (project: IdeaProject) => T, at: string = root): Promise<T> {
  return mutateIdeasFile($, file => {
    const project = projectIdeas(file, at)
    const out = fn(project)
    file.projects[at] = project
    return out
  })
}

function mutateIdeasFile<T>($: $, fn: (file: IdeasFile) => T): Promise<T> {
  return queued(async () => {
    const file = await loadIdeasFile($, ideasPath)
    if (file === undefined) {
      $.ui.toast(`inbox: ${ideasPath} is not valid JSON; ideas are read-only until it is fixed`)
      throw new Error(`${ideasPath} is not valid JSON`)
    }
    const out = fn(file)
    await writeIdeasFile($, ideasPath, file)
    await publishIdeas($, file)
    await reflect($, { items: await read($, items), ideas: projectIdeas(file, root).ideas })
    return out
  })
}

// Puts the file's ideas in state: this project's, and every project's with
// whether its folder still exists. Projects left with no ideas are not listed.
async function publishIdeas($: $, file: IdeasFile) {
  const mine = projectIdeas(file, root).ideas
  if (JSON.stringify(await read($, ideas)) !== JSON.stringify(mine)) await update($, ideas, () => mine)
  const everyone: ProjectIdeas[] = []
  for (const [at, project] of Object.entries(file.projects)) {
    if (project.ideas.length === 0 && at !== root) continue
    everyone.push({ root: at, ideas: project.ideas, isMissing: !(await $.fs.exists(at)) })
  }
  // This project first, the rest by path.
  everyone.sort((a, b) => (a.root === root ? -1 : b.root === root ? 1 : a.root.localeCompare(b.root)))
  if (JSON.stringify(await read($, allIdeas)) !== JSON.stringify(everyone)) await update($, allIdeas, () => everyone)
}

// House cleaning: an idea done more than 7 days ago is deleted, in every
// project. A done idea with no stamp (marked before stamps existed) is stamped
// now, so it gets its 7 days too. Writes only when something changes.
async function purgeDone($: $) {
  const file = await loadIdeasFile($, ideasPath)
  if (file === undefined) return
  const now = await $.clock.now()
  const isStale = (idea: Idea) => idea.isDone && (idea.doneAt === undefined || now - idea.doneAt > DONE_TTL_MS)
  if (!Object.values(file.projects).some(project => project.ideas.some(isStale))) return
  await mutateIdeasFile($, fresh => {
    for (const project of Object.values(fresh.projects)) {
      project.ideas = project.ideas.flatMap(idea => {
        if (!idea.isDone) return [idea]
        if (idea.doneAt === undefined) return [{ ...idea, doneAt: now }]
        return now - idea.doneAt > DONE_TTL_MS ? [] : [idea]
      })
    }
  })
}

const markDone = (idea: Idea, now: number): Idea => ({ ...idea, isDone: true, doneAt: now })
const reopen = ({ doneAt: _doneAt, ...idea }: Idea): Idea => ({ ...idea, isDone: false })

// Re-files another project's ideas under this one, numbered on after this
// project's own, and drops the old entry: what a moved or renamed folder needs.
function adopt($: $, from: string) {
  return mutateIdeasFile($, file => {
    const moving = file.projects[from]?.ideas ?? []
    if (from === root || moving.length === 0) return 0
    const project = projectIdeas(file, root)
    for (const idea of moving) {
      project.ideas.push({ ...idea, id: project.nextId })
      project.nextId += 1
    }
    file.projects[root] = project
    delete file.projects[from]
    return moving.length
  })
}

async function sync($: $) {
  const file = await load($, root)
  if (JSON.stringify(await read($, items)) !== JSON.stringify(file.items)) await update($, items, () => file.items)
  const kept = await loadIdeasFile($, ideasPath)
  if (kept !== undefined) await publishIdeas($, kept)
  await reflect($, { items: file.items, ideas: await read($, ideas) })
}

// Ideas kept in the plugin store before they moved to ~/.claude/ideas.json go
// to the file once, numbered on after what it holds; the store keeps the inbox
// alone. Nothing is dropped from the store unless the file took them.
async function migrateIdeas($: $) {
  const legacy = (await $.store.get(storeKey(root))) as LegacyInboxFile | undefined
  const moving = legacy?.ideas ?? []
  if (moving.length === 0) return
  await mutateIdeas($, project => {
    for (const idea of moving) {
      project.ideas.push({ ...idea, id: project.nextId })
      project.nextId += 1
    }
  })
  await mutate($, () => undefined)
}

function resolve($: $, ids: readonly number[]) {
  return mutate($, file => {
    const before = file.items.length
    file.items = file.items.filter(item => !ids.includes(item.id))
    return before - file.items.length
  })
}

function changeIdea($: $, at: string, id: number, fn: (idea: Idea) => Idea | undefined) {
  return mutateIdeas(
    $,
    project => {
      project.ideas = project.ideas.flatMap(idea => {
        if (idea.id !== id) return [idea]
        const changed = fn(idea)
        return changed === undefined ? [] : [changed]
      })
    },
    at,
  )
}

async function saveDraft($: $) {
  const held = await read($, draft)
  if (held.id === 0) return
  const title = held.title.trim().slice(0, 60)
  if (title !== '') await changeIdea($, held.root, held.id, idea => ({ ...idea, title, description: held.description.trim() }))
  await update($, draft, () => NO_DRAFT)
}

async function openPane($: $, focus: boolean) {
  const file = { items: await read($, items), ideas: await read($, ideas) }
  await $.ui.open({
    id: PANE,
    title: paneTitle(file),
    closeOnEscape: true,
    rows: PANE_ROWS,
    ...(focus ? { focus: true as const } : {}),
  })
}

// Puts a quote in the prompt box, then hands the keyboard to it. A pane holding
// the keys would take the answer's keystrokes as hotkeys, and closing is the one
// way to hand them back; with anything left to show, the pane comes straight
// back without `focus`: shown, not typed into.
async function quoteIntoPrompt($: $, quote: string, isLeftOver: boolean) {
  const current = (await $.prompt.read()).text
  await $.prompt.fill(
    current.trim() === ''
      ? { text: `${quote}\n\n`, mode: 'replace' }
      : { text: `\n\n${quote}\n\n`, mode: 'append' },
  )
  await $.ui.close({ id: PANE })
  if (isLeftOver) await openPane($, false)
}

const quoted = (head: string, body: string) =>
  [head, ...body.split('\n')].map(line => (line === '' ? '>' : `> ${line}`)).join('\n')

async function reply($: $, item: InboxItem) {
  const list = await read($, items)
  const next = list.find(one => one.id !== item.id)
  if (next !== undefined) await update($, selected, () => next.id)
  const hasIdeas = (await read($, ideas)).length > 0
  await quoteIntoPrompt($, quoted(`[inbox #${item.id}] ${item.subject}`, item.body), next !== undefined || hasIdeas)
}

async function discuss($: $, at: string, idea: Idea) {
  const from = at === root ? '' : ` (${shortPath(at)})`
  await quoteIntoPrompt($, quoted(`[idea #${idea.id}] ${idea.title}${from}`, idea.description), true)
}

// A project root as the pane names it: home as ~.
let home = ''
const shortPath = (path: string) => (home !== '' && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`

// The rows of `list` around `index` that fit in `room`, keeping the selection in view.
function windowed<T>(list: readonly T[], index: number, room: number): { rows: T[]; first: number } {
  const size = Math.max(1, room)
  const first = Math.max(0, Math.min(index - Math.floor(size / 2), list.length - size))
  return { rows: list.slice(first, first + size), first }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The session's project root, not its cwd: a shell cd does not move it.
    root = await projectRoot($, await $.session.root())
    home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
    ideasPath = `${home}/.claude/ideas.json`
    const id = await $.session.id()
    await update($, sessionIdRef, () => id)

    await $.command.register({
      name: 'inbox',
      description: 'Open the questions Claude filed, and your ideas, for this project',
    })
    await $.command.register({
      name: 'ideas',
      description: 'Open the ideas recorded for this project',
    })
    await $.tool.register({
      name: 'inbox_ask',
      description:
        'File a question for the user in their project inbox without blocking. Use when you will keep working before they can answer. Returns the item id.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', maxLength: 80, description: 'One-line subject, like an email subject.' },
          body: { type: 'string', description: 'Self-contained question: context, options, recommendation.' },
        },
        required: ['subject', 'body'],
      },
    })
    await $.tool.register({
      name: 'inbox_resolve',
      description: 'Remove inbox items the user has answered outside the inbox.',
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'integer' } } },
        required: ['ids'],
      },
    })
    await $.tool.register({
      name: 'idea_add',
      description: "Record an idea the user shared in the project's idea list. Returns the idea id.",
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', maxLength: 60, description: 'Short name for the idea.' },
          description: { type: 'string', description: 'The idea as the user put it, tightened, not embellished.' },
        },
        required: ['title', 'description'],
      },
    })

    await $.tool.register({
      name: 'idea_done',
      description:
        "Mark recorded ideas done once the work developing them is finished. Done ideas are purged after 7 days.",
      inputSchema: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'integer' } } },
        required: ['ids'],
      },
    })

    await migrateIdeas($).catch(() => undefined)
    await sync($)
    await purgeDone($).catch(() => undefined)
    $.clock.every(POLL_MS, () => sync($))
    $.clock.every(PURGE_EVERY_MS, () => purgeDone($).catch(() => undefined))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'inbox:rules', text: SYSTEM, scope: 'session' }] }
  })

  on('tool.call', { tool: ASK_TOOL }, async ($, e) => {
    const input = e as unknown as { subject?: unknown; body?: unknown }
    const subject = (String(input.subject ?? '').split('\n')[0] ?? '').trim().slice(0, 80)
    const body = String(input.body ?? '').trim()
    if (subject === '') return { deny: 'inbox_ask needs a subject.' }
    const sessionId = await read($, sessionIdRef)
    const createdAt = await $.clock.now()
    const id = await mutate($, file => {
      const item: InboxItem = { id: file.nextId, subject, body, createdAt, sessionId }
      file.nextId += 1
      file.items.push(item)
      return item.id
    })
    return { result: `Filed as inbox #${id}. Keep working; the answer arrives as a user message quoting [inbox #${id}].` }
  }).catch(() => ({ deny: 'inbox: could not file the question; ask it inline instead.' }))

  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    const raw = (e as unknown as { ids?: unknown }).ids
    const ids = Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : []
    const removed = await resolve($, ids)
    return { result: `Resolved ${removed} inbox item(s).` }
  }).catch(() => ({ deny: 'inbox: could not resolve those items.' }))

  on('tool.call', { tool: IDEA_TOOL }, async ($, e) => {
    const input = e as unknown as { title?: unknown; description?: unknown }
    const title = (String(input.title ?? '').split('\n')[0] ?? '').trim().slice(0, 60)
    const description = String(input.description ?? '').trim()
    if (title === '') return { deny: 'idea_add needs a title.' }
    const createdAt = await $.clock.now()
    const id = await mutateIdeas($, project => {
      const idea: Idea = { id: project.nextId, title, description, createdAt, isDone: false }
      project.nextId += 1
      project.ideas.push(idea)
      return idea.id
    })
    return { result: `Recorded as idea #${id}. Acknowledge in one line and carry on.` }
  }).catch(() => ({ deny: 'inbox: could not record the idea.' }))

  on('tool.call', { tool: IDEA_DONE_TOOL }, async ($, e) => {
    const raw = (e as unknown as { ids?: unknown }).ids
    const ids = Array.isArray(raw) ? raw.map(Number).filter(Number.isInteger) : []
    const now = await $.clock.now()
    const marked = await mutateIdeas($, project => {
      const hits = project.ideas.filter(idea => ids.includes(idea.id) && !idea.isDone).map(idea => idea.id)
      project.ideas = project.ideas.map(idea => (hits.includes(idea.id) ? markDone(idea, now) : idea))
      return hits
    })
    return {
      result:
        marked.length === 0
          ? 'No open idea with those ids in this project.'
          : `Marked done: ${marked.map(id => `#${id}`).join(', ')}. Purged in 7 days unless reopened.`,
    }
  }).catch(() => ({ deny: 'inbox: could not mark those ideas done.' }))

  on('prompt.submit', async ($, e, next) => {
    // Only what the user typed answers items; task notifications and peer messages pass through.
    if (e.origin.kind !== 'composer') return next(e)
    const answered = [...e.text.matchAll(MARKER)].map(m => Number(m[1]))
    const list = await read($, items)
    const sessionId = await read($, sessionIdRef)
    const context: string[] = []

    for (const item of list.filter(one => answered.includes(one.id))) {
      if (item.sessionId !== sessionId) {
        context.push(
          `The user is answering inbox #${item.id}, filed in an earlier session (${stamp(item.createdAt)}). Full question:\nSubject: ${item.subject}\n${item.body}`,
        )
      }
    }
    if (answered.length > 0) await resolve($, answered)

    // A quoted idea of this project (Discuss writes "[idea #N] <title>") opens
    // work on it; the note lets that work close the idea when it is done.
    const mine = await read($, ideas)
    for (const [, id, rest] of e.text.matchAll(IDEA_MARKER)) {
      const idea = mine.find(one => one.id === Number(id) && !one.isDone)
      if (idea !== undefined && (rest ?? '').trim() === idea.title) {
        context.push(
          `This message opens idea #${idea.id} (${idea.title}). If you build it, call mcp__inbox__idea_done with [${idea.id}] once the work is finished and verified.`,
        )
      }
    }

    const open = list.filter(one => !answered.includes(one.id))
    if (open.length > 0) {
      context.push(
        `Open inbox items (call mcp__inbox__inbox_resolve if this message answers any):\n${open
          .map(one => `#${one.id} ${one.subject}`)
          .join('\n')}`,
      )
    }

    return context.length === 0 ? next(e) : next({ ...e, context: [...(e.context ?? []), ...context] })
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'inbox' }, async $ => {
    await sync($)
    const list = await read($, items)
    const kept = await read($, ideas)
    if (list.length === 0 && kept.length === 0) return { text: 'Inbox is empty, and no ideas yet.' }
    await update($, section, () => (list.length > 0 ? 'inbox' : 'ideas'))
    await openPane($, true)
    return { text: `Inbox opened: ${list.length} open question(s), ${openIdeas(kept).length} open idea(s).` }
  })

  on('command.run', { command: 'ideas' }, async $ => {
    await sync($)
    const kept = await read($, ideas)
    if (kept.length === 0) return { text: 'No ideas for this project yet. Say "idea: ..." and Claude records it.' }
    await update($, section, () => 'ideas')
    await openPane($, true)
    return { text: `Ideas opened: ${openIdeas(kept).length} open idea(s).` }
  })

  // The transcript row of an inbox_ask call reads as the question itself, not
  // as a tool call: subject, body, and how to answer.
  on('ui.render', { component: 'ToolUse', props: { tool: ASK_TOOL } }, async ($, e, next) => {
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const input = (e.props.input ?? {}) as { subject?: unknown; body?: unknown }
    const subject = String(input.subject ?? '').trim()
    if (subject === '' || e.props.isErrored || e.props.isInterrupted) return next(e)
    const body = String(input.body ?? '').trim()
    const filed = /inbox #(\d+)/.exec(String(e.props.output ?? ''))?.[1]

    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text bold>{subject}</Text>
        {body !== '' && <Markdown key="body" text={body} />}
        <Text dimColor>
          {filed === undefined
            ? 'Filing to inbox...'
            : `Inbox #${filed}. Answer here, or later with /inbox and r.`}
        </Text>
      </Box>
    )
  })

  // The result row under it repeats nothing the question row lacks.
  on('ui.render', { component: 'ToolResult', props: { tool: ASK_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse', props: { tool: RESOLVE_TOOL } }, async ($, e, next) => {
    const { Text } = $.ui.resolve(e)
    const ids = (e.props.input as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(ids) || e.props.isErrored) return next(e)
    return <Text dimColor> Resolved inbox {ids.map(id => `#${String(id)}`).join(', ')}</Text>
  })

  on('ui.render', { component: 'ToolResult', props: { tool: RESOLVE_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse', props: { tool: IDEA_TOOL } }, async ($, e, next) => {
    const { Text } = $.ui.resolve(e)
    const title = String((e.props.input as { title?: unknown } | undefined)?.title ?? '').trim()
    if (title === '' || e.props.isErrored || e.props.isInterrupted) return next(e)
    const id = /idea #(\d+)/.exec(String(e.props.output ?? ''))?.[1]
    return <Text dimColor> {id === undefined ? 'Recording idea...' : `Idea #${id} saved: ${title}`}</Text>
  })

  on('ui.render', { component: 'ToolUse', props: { tool: IDEA_DONE_TOOL } }, async ($, e, next) => {
    const { Text } = $.ui.resolve(e)
    const ids = (e.props.input as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(ids) || e.props.isErrored) return next(e)
    return <Text dimColor> Idea {ids.map(id => `#${String(id)}`).join(', ')} done (purged in 7 days)</Text>
  })

  on('ui.render', { component: 'ToolResult', props: { tool: IDEA_DONE_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolResult', props: { tool: IDEA_TOOL } }, async ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // One pane, two halves: the inbox above, ideas below. `s` moves the keys
  // between them; the active half alone draws its hotkeyed buttons, so the
  // same letters act on whichever half is active.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    // Mobile draws no Input: there an idea is read, not edited.
    const Input = 'Input' in ui ? ui.Input : undefined
    const list = await read($, items)
    const kept = ordered(await read($, ideas))
    const sessionId = await read($, sessionIdRef)
    const active: Section = await read($, section)
    const held = await read($, draft)
    const total = Math.max(10, e.props.scroll.bodyRows)
    const top = Math.floor((total - 1) / 2)
    const bottom = total - 1 - top
    const rule = '─'.repeat(Math.max(1, e.props.bodyColumns - 1))

    const switchTo = (to: Section) => update($, section, () => to)
    const header = (name: Section, label: string) => (
      <Box>
        <Button
          key={`head-${name}`}
          plain
          dimColor={active !== name}
          label={`${active === name ? '>' : ' '} ${label}`}
          onPress={() => switchTo(name)}
        />
      </Box>
    )
    const switchButton = (
      <Button key="switch" hotkey="s" label="Switch" onPress={() => switchTo(active === 'inbox' ? 'ideas' : 'inbox')} />
    )

    // Inbox half.
    const wantedItem = await read($, selected)
    const itemIndex = Math.max(0, list.findIndex(item => item.id === wantedItem))
    const currentItem = list[itemIndex]
    const stepItem = (by: number) => {
      const target = list[(itemIndex + by + list.length) % list.length]
      return target === undefined ? undefined : update($, selected, () => target.id)
    }
    const isStale = (item: InboxItem) => item.sessionId !== sessionId
    const itemRows = windowed(list, itemIndex, Math.max(1, Math.min(list.length, top - 7)))

    const inboxHalf = (
      <Box flexDirection="column" height={top} overflow="hidden">
        {header('inbox', `Inbox (${list.length})`)}
        {currentItem === undefined ? (
          <Text dimColor>  No open questions.</Text>
        ) : (
          <Box flexDirection="column">
            {itemRows.rows.map(item => (
              <Button
                key={`item-${item.id}`}
                plain
                dimColor={item.id !== currentItem.id}
                label={`${item.id === currentItem.id ? '›' : ' '} #${item.id} ${item.subject}${isStale(item) ? '  (earlier session)' : ''}`}
                onPress={() => update($, selected, () => item.id).then(() => switchTo('inbox'))}
              />
            ))}
            <Box marginTop={1} flexDirection="column">
              <Text bold>
                #{currentItem.id} {currentItem.subject}
              </Text>
              <Text dimColor>
                {stamp(currentItem.createdAt)}
                {isStale(currentItem) ? ', earlier session' : ''}
              </Text>
              <Markdown key="item-body" text={currentItem.body === '' ? '_No details._' : currentItem.body} />
            </Box>
          </Box>
        )}
        {active === 'inbox' && (
          <Box marginTop={1}>
            {currentItem !== undefined && (
              <Button key="reply" variant="primary" hotkey="r" autoFocus label="Reply" onPress={() => reply($, currentItem)} />
            )}
            {currentItem !== undefined && (
              <Button key="dismiss" hotkey="d" label="Dismiss" onPress={() => resolve($, [currentItem.id])} />
            )}
            {list.length > 1 && <Button key="prev" hotkey="k" label="Prev" onPress={() => stepItem(-1)} />}
            {list.length > 1 && <Button key="next" hotkey="j" label="Next" onPress={() => stepItem(1)} />}
            {switchButton}
          </Box>
        )}
      </Box>
    )

    // Ideas half: this project's ideas, or with `a` every project's, grouped
    // under a row per project. A row for another project offers Move here,
    // which re-files its ideas under this one: the fix for a moved folder.
    const scope: IdeaScope = await read($, ideaScope)
    const everyone = await read($, allIdeas)
    type Row =
      | { kind: 'group'; project: ProjectIdeas }
      | { kind: 'idea'; at: string; idea: Idea; key: string }
    const ideaRow = (at: string, idea: Idea): Row => ({ kind: 'idea', at, idea, key: `${at}#${idea.id}` })
    const rows: Row[] =
      scope === 'project'
        ? kept.map(idea => ideaRow(root, idea))
        : everyone.flatMap(project => [
            { kind: 'group' as const, project },
            ...ordered(project.ideas).map(idea => ideaRow(project.root, idea)),
          ])
    const entries = rows.filter((row): row is Extract<Row, { kind: 'idea' }> => row.kind === 'idea')
    const wantedKey = await read($, ideaKey)
    const current = entries.find(row => row.key === wantedKey) ?? entries[0]
    const currentIdea = current?.idea
    const entryIndex = current === undefined ? 0 : entries.indexOf(current)
    const stepIdea = (by: number) => {
      const target = entries[(entryIndex + by + entries.length) % entries.length]
      return target === undefined ? undefined : update($, ideaKey, () => target.key)
    }
    const shown = windowed(rows, current === undefined ? 0 : rows.indexOf(current), Math.max(1, Math.min(rows.length, bottom - 7)))
    const openHere = openIdeas(kept).length
    const openAll = everyone.reduce((sum, project) => sum + openIdeas(project.ideas).length, 0)
    const isEditing = held.id !== 0 && entries.some(row => row.at === held.root && row.idea.id === held.id)
    const setScope = (to: IdeaScope) => update($, ideaScope, () => to).then(() => switchTo('ideas'))
    const currentProject = everyone.find(project => project.root === current?.at)
    const now = await $.clock.now()
    const purgeIn = (idea: Idea) => {
      if (idea.doneAt === undefined) return ''
      const days = Math.max(0, Math.ceil((idea.doneAt + DONE_TTL_MS - now) / (24 * 60 * 60 * 1000)))
      return days === 0 ? ', purged soon (m to reopen)' : `, purged in ${days}d (m to reopen)`
    }

    const editor = isEditing && Input !== undefined && (
      <Box flexDirection="column" marginTop={1}>
        <Input
          key="edit-title"
          label="Title"
          value={held.title}
          autoFocus
          onInput={(value: string) => update($, draft, d => ({ ...d, title: value }))}
          onSubmit={(value: string) => update($, draft, d => ({ ...d, title: value })).then(() => saveDraft($))}
        />
        <Input
          key="edit-description"
          label="Description"
          value={held.description}
          onInput={(value: string) => update($, draft, d => ({ ...d, description: value }))}
          onSubmit={(value: string) => update($, draft, d => ({ ...d, description: value })).then(() => saveDraft($))}
        />
        <Box>
          <Button key="edit-save" variant="primary" label="Save" onPress={() => saveDraft($)} />
          <Button key="edit-cancel" label="Cancel" onPress={() => update($, draft, () => NO_DRAFT)} />
        </Box>
      </Box>
    )

    const ideasHeader = (
      <Box justifyContent="space-between" width={Math.max(20, e.props.bodyColumns - 2)}>
        <Button
          key="head-ideas"
          plain
          dimColor={active !== 'ideas' || scope !== 'project'}
          label={`${active === 'ideas' ? '>' : ' '} Ideas (${openHere})`}
          onPress={() => setScope('project')}
        />
        <Button
          key="head-all"
          plain
          dimColor={active !== 'ideas' || scope !== 'all'}
          label={`All (${openAll})`}
          onPress={() => setScope('all')}
        />
      </Box>
    )

    const groupRow = (project: ProjectIdeas) => (
      <Box key={`group-${project.root}`} marginTop={1}>
        <Text bold={project.root === root} dimColor={project.root !== root}>
          {project.root === root ? 'This project' : shortPath(project.root)}
          {project.isMissing ? '  (folder missing)' : ''}
        </Text>
        {project.root !== root && project.ideas.length > 0 && (
          <Button
            key={`adopt-${project.root}`}
            plain
            label={`  [Move ${project.ideas.length} here]`}
            onPress={() => adopt($, project.root)}
          />
        )}
      </Box>
    )

    const ideasHalf = (
      <Box flexDirection="column" height={bottom} overflow="hidden">
        {ideasHeader}
        {current === undefined || currentIdea === undefined ? (
          <Text dimColor>
            {scope === 'project'
              ? '  No ideas here yet. Say "I have an idea..." and it lands here.'
              : '  No ideas in any project yet.'}
          </Text>
        ) : (
          <Box flexDirection="column">
            {shown.rows.map(row =>
              row.kind === 'group' ? (
                groupRow(row.project)
              ) : (
                <Button
                  key={`idea-${row.key}`}
                  plain
                  dimColor={row.idea.isDone || row.key !== current.key}
                  label={`${row.key === current.key ? '›' : ' '} #${row.idea.id} ${row.idea.isDone ? '[done] ' : ''}${row.idea.title}`}
                  onPress={() => update($, ideaKey, () => row.key).then(() => switchTo('ideas'))}
                />
              ),
            )}
            {editor || (
              <Box marginTop={1} flexDirection="column">
                <Text bold dimColor={currentIdea.isDone}>
                  #{currentIdea.id} {currentIdea.title}
                </Text>
                <Text dimColor>
                  {stamp(currentIdea.createdAt)}
                  {currentIdea.isDone ? `, done${purgeIn(currentIdea)}` : ''}
                  {current.at !== root ? `, ${shortPath(current.at)}` : ''}
                </Text>
                <Markdown
                  key="idea-body"
                  text={currentIdea.description === '' ? '_No description._' : currentIdea.description}
                />
              </Box>
            )}
          </Box>
        )}
        {active === 'ideas' && !isEditing && (
          <Box marginTop={1}>
            {currentIdea !== undefined && current !== undefined && (
              <Button
                key="discuss"
                variant="primary"
                hotkey="r"
                autoFocus
                label="Discuss"
                onPress={() => discuss($, current.at, currentIdea)}
              />
            )}
            {currentIdea !== undefined && current !== undefined && Input !== undefined && (
              <Button
                key="edit"
                hotkey="e"
                label="Edit"
                onPress={() =>
                  update($, draft, () => ({
                    root: current.at,
                    id: currentIdea.id,
                    title: currentIdea.title,
                    description: currentIdea.description,
                  }))
                }
              />
            )}
            {currentIdea !== undefined && current !== undefined && (
              <Button
                key="done"
                hotkey="m"
                label={currentIdea.isDone ? 'Reopen' : 'Done'}
                onPress={async () => {
                  const now = await $.clock.now()
                  await changeIdea($, current.at, currentIdea.id, idea => (idea.isDone ? reopen(idea) : markDone(idea, now)))
                }}
              />
            )}
            {currentIdea !== undefined && current !== undefined && (
              <Button
                key="delete"
                hotkey="d"
                label="Delete"
                onPress={() => changeIdea($, current.at, currentIdea.id, () => undefined)}
              />
            )}
            {currentProject !== undefined && current !== undefined && current.at !== root && (
              <Button key="adopt" hotkey="v" label="Move here" onPress={() => adopt($, current.at)} />
            )}
            {entries.length > 1 && <Button key="idea-prev" hotkey="k" label="Prev" onPress={() => stepIdea(-1)} />}
            {entries.length > 1 && <Button key="idea-next" hotkey="j" label="Next" onPress={() => stepIdea(1)} />}
            <Button key="scope" hotkey="a" label={scope === 'project' ? 'All' : 'This project'} onPress={() => setScope(scope === 'project' ? 'all' : 'project')} />
            {switchButton}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingLeft={1}>
        {inboxHalf}
        <Text dimColor>{rule}</Text>
        {ideasHalf}
      </Box>
    )
  })
}
