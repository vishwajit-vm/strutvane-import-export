import { defineConfig, mergeConfig } from 'vitest/config'
import { sharedConfig } from './vitest.shared.ts'

// Repo-specific overrides. Shared defaults come from strutvane-tooling.
// - The database suites replay real migrations in the framework's sandbox (a child process) and
//   run on SQLite (node:sqlite), so they get a longer timeout on a busy machine.
// - Entry points that only re-export (index.ts) and the CLI/installer glue that needs a whole
//   app are excluded from coverage by the shared config / below; their logic lives in tested
//   modules.
export default mergeConfig(
  sharedConfig,
  defineConfig({
    test: {
      include: ['test/**/*.test.ts'],
      testTimeout: 60_000,
      hookTimeout: 120_000,
      coverage: {
        include: ['src/**/*.ts'],
        exclude: ['src/**/index.ts'],
      },
    },
  }),
)
