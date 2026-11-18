/**
 * The migration the installer writes into the app (`database/migrations/<stamp>_create_import_export_tables.ts`).
 *
 * Why the app owns it (Laravel's "publish the migration"): migrations are the app's source of
 * truth in a migration-first project, `node strut migrate` replays them in its sandbox and
 * generates the schema snapshot and types from them, and the app can read and change them.
 *
 * Four tables, all `internal` (never an auto CRUD resource, screen or sidebar entry):
 *
 * - `imports`: one row per import run (the resumable job record): the stored file and its
 *   SHA-256, the options, progress counters, `next_row` (resume after this file row) and
 *   `claim_token` (which run owns the job: a stale run stops at its next chunk).
 * - `failed_import_rows`: the per-row report (row number + field/code/message issues). **Never the
 *   cell values**: they may be personal data or secrets, and a report outlives the import.
 * - `exports`: one row per export run and its stored file.
 * - `import_mappings`: saved column mappings, by model and name.
 *
 * In a tenancy app every table gets the tenant column (`t.tenant()`), so the ORM scopes the job
 * records like any other tenant data and PostgreSQL row-level security protects them.
 *
 * @module
 */

/** The migration file name suffix (after the timestamp). */
export const MIGRATION_NAME = 'create_import_export_tables'

/** The tables the migration creates. */
export const TABLES: {
  readonly imports: 'imports'
  readonly failures: 'failed_import_rows'
  readonly exports: 'exports'
  readonly mappings: 'import_mappings'
} = Object.freeze({
  imports: 'imports',
  failures: 'failed_import_rows',
  exports: 'exports',
  mappings: 'import_mappings',
})

/**
 * The migration file's source text.
 *
 * @example
 * writeFileSync(path, migrationSource({ tenancy: false }))
 */
export function migrationSource(options: { readonly tenancy: boolean }): string {
  const tenant = options.tenancy ? '\n      t.tenant()' : ''
  return `import { migration } from '@strutvane/framework/schema'

// Written by \`node strut install:import-export\` (@strutvane/import-export). The tables behind
// imports and exports: job records you can resume, the per-row error report (never the cell
// values), finished exports and saved column mappings. Internal: no API resource, screen or
// sidebar entry is generated for them.
export default migration({
  up(schema) {
    schema.create(
      'imports',
      (t) => {
        t.uuid('id').primary()${tenant}
        t.string('model', 64)
        t.string('status', 16).default('pending')
        t.boolean('dry_run').default(false)
        t.string('format', 8)
        t.string('disk', 64).nullable()
        t.string('file_key', 512)
        t.string('file_name', 255).nullable()
        t.bigInteger('file_size').default(0)
        t.string('file_sha256', 64)
        t.json('options').nullable()
        t.integer('next_row').default(0)
        t.integer('processed_rows').default(0)
        t.integer('created_rows').default(0)
        t.integer('updated_rows').default(0)
        t.integer('failed_rows').default(0)
        t.string('error_code', 64).nullable()
        t.string('claim_token', 64).nullable()
        t.string('actor_id', 64).nullable().index()
        t.timestamp('started_at').nullable()
        t.timestamp('finished_at').nullable()
        t.timestamps()
      },
      { internal: true },
    )
    schema.create(
      'failed_import_rows',
      (t) => {
        t.id()${tenant}
        t.foreignUuid('import_id').constrained('imports').cascadeOnDelete()
        t.integer('row')
        t.json('issues')
        t.timestamps()
      },
      { internal: true },
    )
    schema.create(
      'exports',
      (t) => {
        t.uuid('id').primary()${tenant}
        t.string('model', 64)
        t.string('status', 16).default('pending')
        t.string('format', 8)
        t.json('columns').nullable()
        t.string('disk', 64).nullable()
        t.string('file_key', 512).nullable()
        t.string('file_name', 255).nullable()
        t.integer('row_count').default(0)
        t.string('error_code', 64).nullable()
        t.string('actor_id', 64).nullable().index()
        t.timestamp('started_at').nullable()
        t.timestamp('finished_at').nullable()
        t.timestamps()
      },
      { internal: true },
    )
    schema.create(
      'import_mappings',
      (t) => {
        t.id()${tenant}
        t.string('model', 64)
        t.string('name', 100)
        t.json('mapping')
        t.string('actor_id', 64).nullable()
        t.timestamps()
        t.unique(['model', 'name'])
      },
      { internal: true },
    )
  },
  down(schema) {
    schema.dropIfExists('import_mappings')
    schema.dropIfExists('exports')
    schema.dropIfExists('failed_import_rows')
    schema.dropIfExists('imports')
  },
})
`
}
