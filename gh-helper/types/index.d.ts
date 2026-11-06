export type Item = { kind: 'issue' | 'pr' | 'draft'; repo: string; number: number | null; title: string; url: string; updatedAt: string | null; assignees: string[]; isEpic: boolean; author?: string; isDraft?: boolean; comments?: number }
// repo set: one repository (`/gh-helper owner/repo ...`); settings saved before
// it existed have no repo field and cover the whole owner. label null: repo-only
// mode, the repository's open issues and PRs with no pings and no project.
export type HelperConfig = { owner: string; repo?: string | null; label: string | null; project: number | null }
export type Section = { items: Item[]; error: string | null }
export type HelperSnapshot = { pings: Section; inProgress: Section; openPrs: Section; openIssues: Section; checkedAt: string | null; rateLimitedUntil: string | null }
// Pings marked done in the pane: url → the updatedAt it had then. A ping with
// newer activity shows again.
export type Dismissed = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'gh-helper': { snapshot: HelperSnapshot; config: HelperConfig | null; dismissed: Dismissed; poller: number }
  }
}
