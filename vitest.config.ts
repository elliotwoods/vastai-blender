import { configDefaults, defineConfig } from 'vitest/config'

// Agent worktrees live under .claude/worktrees; each is a full checkout, so
// without this a run picks up every copy of the suite.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/.claude/**'] }
})
