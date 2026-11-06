export type InboxItem = {
  id: number
  subject: string
  body: string
  createdAt: number
  sessionId: string
}

export type Idea = {
  id: number
  title: string
  description: string
  createdAt: number
  isDone: boolean
  // When it was marked done; done ideas are purged 7 days after.
  doneAt?: number
}

// One project's inbox in the plugin store. A record from before ideas moved to
// ~/.claude/ideas.json may still carry them; `migrateIdeas` moves them out.
export type InboxFile = {
  nextId: number
  items: InboxItem[]
}

export type LegacyInboxFile = InboxFile & { nextIdeaId?: number; ideas?: Idea[] }

// ~/.claude/ideas.json: every project's ideas, keyed by project root.
export type IdeaProject = { nextId: number; ideas: Idea[] }
export type IdeasFile = { version: 1; projects: Record<string, IdeaProject> }

export type Section = 'inbox' | 'ideas'

// Which ideas the lower half lists: this project's, or every project's.
export type IdeaScope = 'project' | 'all'

// One project's ideas as the pane shows them, with whether its folder still
// exists: a missing one was likely moved or renamed.
export type ProjectIdeas = { root: string; ideas: Idea[]; isMissing: boolean }

// The idea being edited in the pane, by its project and id; id 0 when none is.
export type IdeaDraft = { root: string; id: number; title: string; description: string }

declare module 'claude-code' {
  interface PluginState {
    inbox: {
      items: InboxItem[]
      selected: number
      sessionId: string
      ideas: Idea[]
      allIdeas: ProjectIdeas[]
      ideaScope: IdeaScope
      // The selected idea as `<root>#<id>`; '' for the first one listed.
      ideaKey: string
      section: Section
      draft: IdeaDraft
    }
  }
}
