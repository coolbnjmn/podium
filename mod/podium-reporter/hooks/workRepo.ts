// Which repository a session is really working in. Sessions often start in a folder that is not a repository
// and do their git work in worktrees by absolute path, so the folder they started in says nothing about it.
// Pure: the mod resolves each directory to its repository with git and keeps the most recent few.

/** The most repositories remembered for one session. */
export const MAX_WORK_REPOS = 5
/** The most directories one tool call can name. */
const MAX_DIRS_PER_CALL = 3
/** Tools that change a file; a read only looks, so it never picks the repository. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** `git -C <dir>` and `cd <dir>` in a shell command; the directory is quoted or ends at whitespace or a shell operator. */
const DIR_IN_COMMAND = /(?:^|[\s;&|(])(?:git\s+-C|cd)\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|)"']+))/g

/** A plain absolute path: no variable, home shortcut, command substitution or NUL for a shell to expand. */
function plainAbsolute(p: unknown): p is string {
  return typeof p === 'string' && p.startsWith('/') && !/[$`~\0]/.test(p)
}

function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** The directories a finished tool call says the session is working in, in the order the call names them. */
export function dirsOfCall(tool: string, input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return []
  const o = input as Record<string, unknown>
  if (EDIT_TOOLS.has(tool)) {
    const f = o.file_path ?? o.notebook_path
    return plainAbsolute(f) ? [dirname(f)] : []
  }
  if (tool === 'Bash' && typeof o.command === 'string') {
    const out: string[] = []
    for (const m of o.command.slice(0, 4000).matchAll(DIR_IN_COMMAND)) {
      const d = m[1] ?? m[2] ?? m[3]
      if (plainAbsolute(d) && !out.includes(d)) out.push(d)
      if (out.length >= MAX_DIRS_PER_CALL) break
    }
    return out
  }
  return []
}

/** `root` moved to the front of the recent repositories, each listed once, at most MAX_WORK_REPOS. */
export function promoteRoot(recent: readonly string[], root: string): string[] {
  return [root, ...recent.filter((r) => r !== root)].slice(0, MAX_WORK_REPOS)
}
