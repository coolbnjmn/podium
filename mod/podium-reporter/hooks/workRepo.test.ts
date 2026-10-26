import { describe, test, expect } from 'claude-code/testing'
import { dirsOfCall, MAX_WORK_REPOS, promoteRoot } from './workRepo.ts'
import { dropWorkRoot, gitCwdOf, newSession, noteWorkRoot, setRootBase } from './state.ts'

describe('dirsOfCall', () => {
  test('an edit names the folder of its file; a read names nothing', () => {
    expect(dirsOfCall('Edit', { file_path: '/w/pulse-a/src/x.ts' })).toEqual(['/w/pulse-a/src'])
    expect(dirsOfCall('Write', { file_path: '/w/pulse-a/README.md' })).toEqual(['/w/pulse-a'])
    expect(dirsOfCall('NotebookEdit', { notebook_path: '/w/nb/a.ipynb' })).toEqual(['/w/nb'])
    expect(dirsOfCall('Read', { file_path: '/w/other/a.ts' })).toEqual([])
  })

  test('a shell command names the folders after git -C and cd, quoted or not', () => {
    expect(dirsOfCall('Bash', { command: 'git -C /w/a status && cd "/w/b c" && ls; cd /w/d' })).toEqual(['/w/a', '/w/b c', '/w/d'])
    expect(dirsOfCall('Bash', { command: "cd '/w/e' && git log" })).toEqual(['/w/e'])
    expect(dirsOfCall('Bash', { command: 'git status' })).toEqual([])
  })

  test('only plain absolute paths count: no variables, home shortcuts, substitutions or relative paths', () => {
    expect(dirsOfCall('Bash', { command: 'cd $HOME/x; cd ~/y; cd ../z; cd rel; git -C `pwd` log; cd /w/ok' })).toEqual(['/w/ok'])
    expect(dirsOfCall('Edit', { file_path: 'relative.ts' })).toEqual([])
    expect(dirsOfCall('Edit', { file_path: '/w/$X/a.ts' })).toEqual([])
  })

  test('ignores malformed input and caps one call at three folders', () => {
    expect(dirsOfCall('Edit', null)).toEqual([])
    expect(dirsOfCall('Edit', { file_path: 42 })).toEqual([])
    expect(dirsOfCall('Bash', { command: 7 })).toEqual([])
    expect(dirsOfCall('Bash', { command: 'cd /a; cd /b; cd /c; cd /d; cd /e' })).toHaveLength(3)
    expect(dirsOfCall('Grep', { file_path: '/w/a/x' })).toEqual([])
  })
})

describe('promoteRoot', () => {
  test('moves a repository to the front once, and keeps the most recent few', () => {
    expect(promoteRoot(['/a', '/b'], '/b')).toEqual(['/b', '/a'])
    expect(promoteRoot([], '/a')).toEqual(['/a'])
    const many = promoteRoot(['/1', '/2', '/3', '/4', '/5'], '/6')
    expect(many).toHaveLength(MAX_WORK_REPOS)
    expect(many[0]).toBe('/6')
    expect(many).not.toContain('/5')
  })
})

describe('the session', () => {
  const s0 = newSession({ id: 's', cwd: '/Users/x/Code', startedAt: 0 })

  test('reads git where it started until a repository is noted, then in the latest one', () => {
    expect(gitCwdOf(s0)).toBe('/Users/x/Code')
    const s1 = noteWorkRoot(noteWorkRoot(s0, '/w/a'), '/w/b')
    expect(gitCwdOf(s1)).toBe('/w/b')
    expect(s1.workRoots).toEqual(['/w/b', '/w/a'])
    expect(noteWorkRoot(s1, '/w/b')).toBe(s1)
  })

  test('forgets a repository that cannot be read, falls back to the next, and drops its base', () => {
    let s = noteWorkRoot(noteWorkRoot(s0, '/w/a'), '/w/b')
    s = { ...setRootBase(setRootBase(s, '/w/a', 'aaa'), '/w/b', 'bbb'), gitBase: 'bbb' }
    const d = dropWorkRoot(s, '/w/b')
    expect(gitCwdOf(d)).toBe('/w/a')
    expect(d.rootBases).toEqual({ '/w/a': 'aaa' })
    expect(d.gitBase).toBeNull()
    expect(dropWorkRoot(d, '/w/missing')).toBe(d)
  })

  test('keeps a base only for repositories still listed', () => {
    let s = noteWorkRoot(s0, '/w/a')
    s = setRootBase(s, '/w/a', 'aaa')
    s = noteWorkRoot(s, '/w/b')
    s = setRootBase(s, '/w/b', 'bbb')
    expect(s.rootBases).toEqual({ '/w/a': 'aaa', '/w/b': 'bbb' })
    expect(setRootBase(s, '/w/b', 'bbb')).toBe(s)
  })
})
