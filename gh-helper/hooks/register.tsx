import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dismissed, HelperConfig, HelperSnapshot, Item, Section } from '../types'

const PANE = 'gh-helper'
const POLL_MS = 5 * 60 * 1000
// A cached result younger than this is reused instead of fetched again, so
// several sessions on the same setting share one fetch per period.
const FRESH_MS = POLL_MS - 30 * 1000
const STORE_KEY = 'configs'
const CACHE_KEY = 'cache'
const DISMISSED_KEY = 'dismissed'
const USAGE = 'Usage: /gh-helper <owner>[/<repo>] <label> [project-number], for example /gh-helper my-org to-claude 1;'
  + ' or /gh-helper <owner>/<repo> for that repository\'s open issues and PRs'
const emptySection: Section = { items: [], error: null }
const empty: HelperSnapshot = {
  pings: emptySection, inProgress: emptySection, openPrs: emptySection, openIssues: emptySection, checkedAt: null, rateLimitedUntil: null,
}

const snapshot = atom({ plugin: 'gh-helper', key: 'snapshot' } as const, empty)
const config = atom({ plugin: 'gh-helper', key: 'config' } as const, null)
const dismissed = atom({ plugin: 'gh-helper', key: 'dismissed' } as const, {})
// Bumped by each load of the module; a timer from an earlier load sees a newer
// value and stops, so a hot reload never leaves two pollers running.
const poller = atom({ plugin: 'gh-helper', key: 'poller' } as const, 0)

// Settings are kept per directory; a session uses the setting of its working
// directory or of the nearest parent directory that has one.
type ConfigMap = Record<string, HelperConfig>
// The last fetch, shared by every session through the plugin's store.
type Cache = HelperSnapshot & { key: string }

type SearchHit = { repository: { name: string }; number: number; title: string; url: string; updatedAt: string; commentsCount?: number }
type OpenHit = SearchHit & { author?: { login?: string }; isDraft?: boolean }
type Logins = { nodes?: { login: string }[] }
type ProjectNode = {
  content?: {
    __typename?: string
    number?: number
    title?: string
    url?: string
    repository?: { name: string }
    assignees?: Logins
    labels?: { nodes?: { name: string }[] }
    comments?: { totalCount: number }
  } | null
}
type ProjectPage = { items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProjectNode[] } }

// Asks GitHub for the In progress items only, with the fields the pane draws:
// a couple of GraphQL points a page, where `gh project item-list` costs about
// 100 a page for every item on the board.
const CONTENT = 'number title url repository { name } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } } comments { totalCount }'
const projectQuery = (ownerField: 'organization' | 'user') => `
query($owner: String!, $number: Int!, $cursor: String) {
  owner: ${ownerField}(login: $owner) { projectV2(number: $number) {
    items(first: 100, after: $cursor, query: "status:\\"In progress\\"") {
      pageInfo { hasNextPage endCursor }
      nodes { content {
        __typename
        ... on Issue { ${CONTENT} }
        ... on PullRequest { ${CONTENT} }
        ... on DraftIssue { title assignees(first: 10) { nodes { login } } }
      } }
    }
  } }
}`

const parseConfig = (args: string | undefined): HelperConfig | null => {
  const [scope, label, project] = (args ?? '').trim().split(/\s+/)
  if (!scope) return null
  const [owner, repo, ...rest] = scope.split('/')
  if (!owner || rest.length > 0 || repo === '') return null
  // No label: repo-only mode, which needs a repository (a whole owner's open
  // issues and PRs would be too many to list).
  if (!label) return repo ? { owner, repo, label: null, project: null } : null
  const number = project ? Number.parseInt(project, 10) : Number.NaN
  return { owner, repo: repo ?? null, label, project: Number.isInteger(number) && number > 0 ? number : null }
}

// `owner` or `owner/repo`, as the person typed it.
const scopeName = (cfg: HelperConfig): string => (cfg.repo ? `${cfg.owner}/${cfg.repo}` : cfg.owner)
const isRepoOnly = (cfg: HelperConfig): boolean => cfg.label === null
// What narrows a `gh search` to the setting.
const scopeArgs = (cfg: HelperConfig): string[] => (cfg.repo ? ['--repo', scopeName(cfg)] : ['--owner', cfg.owner])

const configFor = (configs: ConfigMap, cwd: string): HelperConfig | null => {
  const match = Object.keys(configs)
    .filter(dir => cwd === dir || cwd.startsWith(dir.endsWith('/') ? dir : `${dir}/`))
    .sort((a, b) => b.length - a.length)[0]
  return match ? configs[match] ?? null : null
}

const cacheKey = (cfg: HelperConfig): string => `${scopeName(cfg)}|${cfg.label ?? ''}|${cfg.project ?? ''}`

const ago = (iso: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

const clockTime = (iso: string): string => {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const failure = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const isRateLimit = (message: string | null): boolean => message !== null && /rate limit/i.test(message)
const isDismissed = (marks: Dismissed, item: Item): boolean => !!item.updatedAt && marks[item.url] === item.updatedAt

async function gh($: EngineInterface, argv: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await $.process.run(['gh', ...argv], { timeoutMs: 30000 })
  if (exitCode !== 0) throw new Error(stderr.trim().split('\n')[0] || `gh exited ${exitCode}`)
  return stdout
}

async function searchPings($: EngineInterface, kind: 'issues' | 'prs', cfg: HelperConfig & { label: string }): Promise<Item[]> {
  const stdout = await gh($, ['search', kind, ...scopeArgs(cfg), '--label', cfg.label, '--state', 'open',
    '--json', 'repository,number,title,url,updatedAt,commentsCount', '--limit', '50'])
  return (JSON.parse(stdout) as SearchHit[]).map(hit => ({
    kind: kind === 'prs' ? 'pr' : 'issue',
    repo: hit.repository.name,
    number: hit.number,
    title: hit.title,
    url: hit.url,
    updatedAt: hit.updatedAt,
    assignees: [],
    isEpic: false,
    comments: hit.commentsCount,
  }))
}

async function loadPings($: EngineInterface, cfg: HelperConfig): Promise<Section> {
  const { label } = cfg
  if (label === null) return { items: [], error: null }
  try {
    const [issues, prs] = await Promise.all([searchPings($, 'issues', { ...cfg, label }), searchPings($, 'prs', { ...cfg, label })])
    const items = [...issues, ...prs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    return { items, error: null }
  } catch (error) {
    return { items: [], error: failure(error) }
  }
}

async function projectPages($: EngineInterface, cfg: HelperConfig, ownerField: 'organization' | 'user'): Promise<ProjectNode[]> {
  const nodes: ProjectNode[] = []
  let cursor: string | null = null
  for (let page = 0; page < 5; page++) {
    const argv = ['api', 'graphql', '-f', `query=${projectQuery(ownerField)}`,
      '-F', `owner=${cfg.owner}`, '-F', `number=${cfg.project}`]
    if (cursor) argv.push('-f', `cursor=${cursor}`)
    const parsed = JSON.parse(await gh($, argv)) as { data?: { owner?: { projectV2?: ProjectPage | null } | null } }
    const items = parsed.data?.owner?.projectV2?.items
    if (!items) throw new Error(`Project ${cfg.project} not found for ${cfg.owner}`)
    nodes.push(...items.nodes)
    if (!items.pageInfo.hasNextPage) break
    cursor = items.pageInfo.endCursor
  }
  return nodes
}

async function loadInProgress($: EngineInterface, cfg: HelperConfig): Promise<Section> {
  if (cfg.project === null || isRepoOnly(cfg)) return { items: [], error: null }
  try {
    // The owner may be a user rather than an organization; GitHub answers that
    // with a "Could not resolve to an Organization" error.
    const nodes = await projectPages($, cfg, 'organization').catch((error: unknown) => {
      if (/could not resolve to an organization/i.test(failure(error))) return projectPages($, cfg, 'user')
      throw error
    })
    // The board belongs to the owner and may span repositories; a repo
    // setting keeps that repository's items (draft items belong to none).
    const repoPrefix = cfg.repo ? `https://github.com/${scopeName(cfg)}/`.toLowerCase() : null
    const items = nodes
      .filter(({ content }) => !repoPrefix || (content?.url ?? '').toLowerCase().startsWith(repoPrefix))
      .map(({ content }): Item => {
        const type = content?.__typename ?? ''
        return {
          kind: type === 'PullRequest' ? 'pr' : type === 'DraftIssue' ? 'draft' : 'issue',
          repo: content?.repository?.name ?? '',
          number: content?.number ?? null,
          title: content?.title ?? '',
          url: content?.url ?? '',
          updatedAt: null,
          assignees: (content?.assignees?.nodes ?? []).map(node => node.login),
          isEpic: (content?.labels?.nodes ?? []).some(label => label.name.toLowerCase() === 'epic'),
          comments: content?.comments?.totalCount,
        }
      })
    return { items, error: null }
  } catch (error) {
    return { items: [], error: failure(error) }
  }
}

// Open issues or PRs in the scope: on the project board in the full mode
// (PRs only), all of them in repo-only mode.
async function loadOpen($: EngineInterface, cfg: HelperConfig, kind: 'issues' | 'prs'): Promise<Section> {
  const onBoard = isRepoOnly(cfg) ? [] : cfg.project === null || kind === 'issues' ? null : ['--project', `${cfg.owner}/${cfg.project}`]
  if (onBoard === null) return { items: [], error: null }
  try {
    const fields = `repository,number,title,url,updatedAt,author,commentsCount${kind === 'prs' ? ',isDraft' : ''}`
    const stdout = await gh($, ['search', kind, ...scopeArgs(cfg), ...onBoard,
      '--state', 'open', '--json', fields, '--sort', 'updated', '--limit', '100'])
    const items = (JSON.parse(stdout) as OpenHit[]).map((hit): Item => ({
      kind: kind === 'prs' ? 'pr' : 'issue',
      repo: hit.repository.name,
      number: hit.number,
      title: hit.title,
      url: hit.url,
      updatedAt: hit.updatedAt,
      assignees: [],
      isEpic: false,
      author: hit.author?.login,
      isDraft: hit.isDraft ?? false,
      comments: hit.commentsCount,
    }))
    return { items, error: null }
  } catch (error) {
    return { items: [], error: failure(error) }
  }
}

// When the limit resets, from `gh api rate_limit` (core bucket, which the pane
// does not otherwise use). Falls back to one poll period from now.
async function rateLimitReset($: EngineInterface, message: string, now: number): Promise<number> {
  try {
    const limits = JSON.parse(await gh($, ['api', 'rate_limit'])) as {
      resources?: Record<string, { remaining: number; reset: number }>
    }
    const bucket = limits.resources?.[/graphql/i.test(message) ? 'graphql' : 'search']
    if (bucket && bucket.reset * 1000 > now) return bucket.reset * 1000
  } catch {
    // Fall through to the fallback.
  }
  return now + POLL_MS
}

const pruneDismissed = (marks: Dismissed, pings: Section): Dismissed => {
  if (pings.error) return marks
  const open = new Set(pings.items.map(item => item.url))
  return Object.fromEntries(Object.entries(marks).filter(([url]) => open.has(url)))
}

async function publish($: EngineInterface, cfg: HelperConfig, result: HelperSnapshot): Promise<void> {
  const marks = ((await $.store.get(DISMISSED_KEY)) ?? {}) as Dismissed
  await update($, snapshot, () => result)
  await update($, dismissed, () => marks)
  const count = result.pings.items.filter(item => !isDismissed(marks, item)).length
  $.ui.status(count > 0 && cfg.label ? `${count} ping${count === 1 ? '' : 's'} (${cfg.label})` : undefined)
}

// force: the person asked (Refresh, the command); skips the shared cache but
// still waits out a rate limit, since asking again would only fail again.
async function refresh($: EngineInterface, force = false): Promise<void> {
  const cfg = await read($, config)
  if (!cfg) return
  const key = cacheKey(cfg)
  const now = await $.clock.now()
  const cached = (await $.store.get(CACHE_KEY)) as Cache | undefined
  // Spread over `empty` so a result saved by an older version, missing a
  // section, still draws.
  const previous = cached?.key === key ? { ...empty, ...cached } : null

  if (previous) {
    const limited = previous.rateLimitedUntil !== null && Date.parse(previous.rateLimitedUntil) > now
    const fresh = previous.checkedAt !== null && now - Date.parse(previous.checkedAt) < FRESH_MS
    if (limited || (fresh && !force)) return publish($, cfg, previous)
  }

  const [pings, inProgress, openPrs, openIssues] = await Promise.all([
    loadPings($, cfg), loadInProgress($, cfg), loadOpen($, cfg, 'prs'), loadOpen($, cfg, 'issues'),
  ])
  const limitMessage = [pings.error, inProgress.error, openPrs.error, openIssues.error].find(isRateLimit) ?? null
  const until = limitMessage ? new Date(await rateLimitReset($, limitMessage, now)).toISOString() : null

  // A section that failed keeps the items it had, under the error.
  const settle = (fresh: Section, old: Section | undefined): Section => {
    if (!fresh.error) return fresh
    const error = until && isRateLimit(fresh.error) ? `Rate-limited until ${clockTime(until)}; showing the last result.` : fresh.error
    return { items: old?.items ?? [], error }
  }
  const result: HelperSnapshot = {
    pings: settle(pings, previous?.pings),
    inProgress: settle(inProgress, previous?.inProgress),
    openPrs: settle(openPrs, previous?.openPrs),
    openIssues: settle(openIssues, previous?.openIssues),
    checkedAt: new Date(now).toISOString(),
    rateLimitedUntil: until,
  }
  await $.store.set(CACHE_KEY, { ...result, key } satisfies Cache)
  const marks = ((await $.store.get(DISMISSED_KEY)) ?? {}) as Dismissed
  await $.store.set(DISMISSED_KEY, pruneDismissed(marks, pings))
  await publish($, cfg, result)
}

async function dismiss($: EngineInterface, item: Item): Promise<void> {
  if (!item.updatedAt) return
  const marks = ((await $.store.get(DISMISSED_KEY)) ?? {}) as Dismissed
  const next = { ...marks, [item.url]: item.updatedAt }
  await $.store.set(DISMISSED_KEY, next)
  const cfg = await read($, config)
  if (cfg) await publish($, cfg, await read($, snapshot))
}

async function restoreDismissed($: EngineInterface): Promise<void> {
  await $.store.set(DISMISSED_KEY, {})
  const cfg = await read($, config)
  if (cfg) await publish($, cfg, await read($, snapshot))
}

async function startPolling($: EngineInterface): Promise<void> {
  const generation = (await read($, poller)) + 1
  await update($, poller, () => generation)
  const timer = $.clock.every(POLL_MS, () => {
    void read($, poller).then(current => (current === generation ? refresh($) : timer.cancel()))
  })
}

async function openPane($: EngineInterface, cfg: HelperConfig): Promise<void> {
  await $.ui.open({ id: PANE, title: `GitHub · ${scopeName(cfg)}` })
}

// "1 comment", "3 comments"; nothing for none (or a draft item, which has no count).
const commentLabel = (item: Item): string | null =>
  item.comments ? `${item.comments} comment${item.comments === 1 ? '' : 's'}` : null

const itemLabel = (item: Item): string => {
  const prefix = item.kind === 'pr' ? 'PR ' : item.kind === 'draft' ? 'Draft ' : ''
  return item.number === null ? `${prefix}${item.repo}`.trim() : `${prefix}${item.repo}#${item.number}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'gh-helper',
      description: 'Open the GitHub pane; set it for this directory with /gh-helper <owner>[/<repo>] [<label> [project-number]]',
    })
    const configs = ((await $.store.get(STORE_KEY)) ?? {}) as ConfigMap
    const stored = configFor(configs, await $.session.cwd())
    if (stored) {
      await update($, config, () => stored)
      await refresh($)
      await startPolling($)
      void openPane($, stored)
    }
    return next(e)
  })

  on('command.run', { command: 'gh-helper' }, async ($, e) => {
    const given = parseConfig(e.args)
    const had = await read($, config)
    if (given) {
      const configs = ((await $.store.get(STORE_KEY)) ?? {}) as ConfigMap
      await $.store.set(STORE_KEY, { ...configs, [await $.session.cwd()]: given })
      await update($, config, () => given)
      if (!had) await startPolling($)
    }
    const cfg = given ?? had
    if (!cfg) return { text: USAGE }
    await refresh($, true)
    await openPane($, cfg)
    const { pings, inProgress, openPrs, openIssues } = await read($, snapshot)
    if (!cfg.label) {
      return { text: `${scopeName(cfg)}: ${openIssues.items.length} open issue(s), ${openPrs.items.length} open PR(s).` }
    }
    const project = cfg.project === null
      ? 'no project set'
      : `${inProgress.items.length} in progress, ${openPrs.items.length} open PR(s)`
    return { text: `${pings.items.length} open ping(s) for ${cfg.label}; ${project}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Link, Button } = $.ui.resolve(e)
    const cfg = await read($, config)
    const { pings, inProgress, openPrs, openIssues, checkedAt, rateLimitedUntil } = await read($, snapshot)
    const marks = await read($, dismissed)
    const now = await $.clock.now()
    if (!cfg) {
      return <Text dimColor>{USAGE}</Text>
    }

    // The header row plus each bordered section's border, title and overflow
    // line take about 1 + 3 rows a section; each item takes two rows.
    const sections = cfg.label === null ? 2 : 3
    const rows = e.viewport?.rows ?? 24
    const perSection = Math.max(1, Math.floor((rows - 1 - 3 * sections) / (2 * sections)))

    const list = (section: Section, emptyText: string, showAssignees: boolean, canDismiss: boolean) => {
      const shown = section.items.filter(item => !(canDismiss && isDismissed(marks, item)))
      const visible = shown.filter(item => !item.isEpic)
      const epics = shown.length - visible.length
      return (
        <Box flexDirection="column">
          {section.error && <Text color={isRateLimit(section.error) ? 'yellow' : 'red'}>{section.error}</Text>}
          {!section.error && visible.length === 0 && <Text dimColor>{emptyText}</Text>}
          {visible.slice(0, perSection).map(item => (
            <Box flexDirection="column" key={item.url || `${item.repo}:${item.title}`}>
              <Box>
                {canDismiss && (
                  <Button key={`done:${item.url}`} label="✓" plain dimColor hover={{ color: 'green' }}
                    onPress={() => dismiss($, item)} />
                )}
                {canDismiss && <Text> </Text>}
                <Link href={item.url}>{itemLabel(item)}</Link>
                {commentLabel(item) && <Text dimColor>{` · ${commentLabel(item)}`}</Text>}
              </Box>
              <Text wrap="truncate-end" dimColor>
                {`  ${item.isDraft ? '[draft] ' : ''}${item.title}`
                  + (item.author ? ` · ${item.author}` : '')
                  + (showAssignees && item.assignees.length > 0 ? ` · ${item.assignees.join(', ')}` : '')
                  + (item.updatedAt ? ` · ${ago(item.updatedAt, now)}` : '')}
              </Text>
            </Box>
          ))}
          {visible.length > perSection && <Text dimColor>{`+${visible.length - perSection} more`}</Text>}
          {epics > 0 && <Text dimColor>{`+${epics} epic${epics === 1 ? '' : 's'} in progress`}</Text>}
        </Box>
      )
    }

    const pingCount = pings.items.filter(item => !isDismissed(marks, item)).length
    const doneCount = pings.items.length - pingCount
    // Epics included, as in the command's summary; the list shows them as "+N epics".
    const inProgressCount = inProgress.items.length
    const limited = rateLimitedUntil !== null && Date.parse(rateLimitedUntil) > now

    const header = (
      <Box>
        <Text dimColor>
          {checkedAt ? `Checked ${ago(checkedAt, now)} ago ` : 'Loading… '}
        </Text>
        {limited && rateLimitedUntil && <Text color="yellow">{`(paused until ${clockTime(rateLimitedUntil)}) `}</Text>}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($, true)} />
      </Box>
    )

    if (cfg.label === null) {
      return (
        <Box flexDirection="column" height="100%">
          {header}
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>{`Open issues (${openIssues.items.length})`}</Text>
            {list(openIssues, 'No open issues.', false, false)}
          </Box>
          <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
            <Text bold>{`Open PRs (${openPrs.items.length})`}</Text>
            {list(openPrs, 'No open PRs.', false, false)}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" height="100%">
        {header}
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          <Box>
            <Text bold>{`Pings · ${cfg.label} (${pingCount}) `}</Text>
            {doneCount > 0 && (
              <Button key="restore" label={`${doneCount} done · show`} hotkey="u" plain dimColor
                onPress={() => restoreDismissed($)} />
            )}
          </Box>
          {list(pings, 'No open pings.', false, true)}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text bold>
            {cfg.project === null ? 'In progress' : `In progress · project ${cfg.project} (${inProgressCount})`}
          </Text>
          {cfg.project === null
            ? <Text dimColor>{`Add a project number: /gh-helper ${scopeName(cfg)} ${cfg.label} <project-number>`}</Text>
            : list(inProgress, 'Nothing in progress.', true, false)}
        </Box>
        <Box flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          <Text bold>
            {cfg.project === null ? 'Open PRs' : `Open PRs · project ${cfg.project} (${openPrs.items.length})`}
          </Text>
          {cfg.project === null
            ? <Text dimColor>{`Add a project number: /gh-helper ${scopeName(cfg)} ${cfg.label} <project-number>`}</Text>
            : list(openPrs, 'No open PRs.', false, false)}
        </Box>
      </Box>
    )
  })
}
