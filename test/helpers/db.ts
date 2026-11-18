/**
 * A real database for the import/export suites: SQLite (node:sqlite) in memory, with the schema
 * built the way an app builds it. The package's own migration (`migrationSource`) and a small app
 * migration are written to a temporary folder, replayed in the framework's migration sandbox and
 * applied by its migration runner; the replayed schema is registered with the ORM. So the tests
 * also prove the migration the installer writes is valid.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Connection,
  configureOrm,
  ModelBase,
  registerSchema,
  replayInSandbox,
  runMigrations,
  sqliteDriver,
  useConnection,
} from '@strutvane/framework/database'
import { migrationSource } from '../../src/migration.ts'

/** The test app's own tables: companies and contacts (every column kind the importer handles). */
export function appMigration(tenancy: boolean): string {
  const tenant = tenancy ? '\n      t.tenant()' : ''
  return `import { migration } from '@strutvane/framework/schema'
export default migration({
  up(schema) {
    schema.create('companies', (t) => {
      t.id()${tenant}
      t.string('name', 100)
      t.timestamps()
    })
    schema.create('contacts', (t) => {
      t.id()${tenant}
      t.string('name', 100)
      t.string('email', 255).unique()
      t.integer('age').nullable()
      t.decimal('balance', 10, 2).default(0)
      t.double('score').nullable()
      t.boolean('active').default(true)
      t.enum('tier', ['free', 'pro']).default('free')
      t.date('born_on').nullable()
      t.timestamp('last_seen_at').nullable()
      t.json('meta').nullable()
      t.uuid('external_ref').nullable()
      t.string('api_token', 80).nullable()
      t.text('internal_note').nullable().hidden()
      t.foreignId('company_id').nullable().constrained('companies')
      t.timestamps()
    })
  },
  down(schema) {
    schema.dropIfExists('contacts')
    schema.dropIfExists('companies')
  },
})
`
}

/** The runtime model options these tests use. */
interface ModelOptions {
  readonly fillable?: readonly string[]
  readonly allowSensitive?: readonly string[]
  readonly hidden?: readonly string[]
}

/** The test app's models (what `class Contact extends Model('contacts', …)` is at runtime). */
export class Company extends ModelBase {
  static override readonly table: string = 'companies'
  static override readonly options: ModelOptions = { fillable: ['name'] }
}

export class Contact extends ModelBase {
  static override readonly table: string = 'contacts'
  static override readonly options: ModelOptions = {
    fillable: [
      'name',
      'email',
      'age',
      'balance',
      'score',
      'active',
      'tier',
      'born_on',
      'last_seen_at',
      'meta',
      'external_ref',
      'internal_note',
      'company_id',
    ],
    // A *_at column looks workflow-related to the ORM: imports may set it, deliberately.
    allowSensitive: ['last_seen_at'],
  }
}

/** A database ready for imports; `close()` drops everything. */
export interface TestDatabase {
  readonly connection: Connection
  close(): Promise<void>
}

/** The replayed schema is the same for every suite of one tenancy mode: replay once per mode. */
const replays = new Map<boolean, Promise<Awaited<ReturnType<typeof replayInSandbox>>>>()

function replayFor(tenancy: boolean): Promise<Awaited<ReturnType<typeof replayInSandbox>>> {
  let replay = replays.get(tenancy)
  if (replay === undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'sv-ie-'))
    const migrations = join(dir, 'migrations')
    mkdirSync(migrations)
    writeFileSync(join(migrations, '2026_01_01_000000_create_app_tables.ts'), appMigration(tenancy))
    writeFileSync(
      join(migrations, '2026_01_02_000000_create_import_export_tables.ts'),
      migrationSource({ tenancy }),
    )
    replay = replayInSandbox(migrations, { timeoutMs: 120_000 }).finally(() =>
      rmSync(dir, { recursive: true, force: true }),
    )
    replays.set(tenancy, replay)
  }
  return replay
}

/**
 * Open a fresh in-memory database with the app and package tables, and point the ORM at it.
 *
 * @example
 * const db = await openDatabase({ tenancy: false })
 */
export async function openDatabase(options: { readonly tenancy: boolean }): Promise<TestDatabase> {
  const replay = await replayFor(options.tenancy)
  const connection = new Connection(sqliteDriver(':memory:'))
  await runMigrations(connection, replay)
  const tables = Object.fromEntries(replay.state.tables.map((table) => [table.name, table]))
  registerSchema({ version: 1, tables })
  configureOrm({
    tenancy: options.tenancy ? { column: 'tenant_id' } : false,
    preventLazyLoading: false,
  })
  useConnection(connection)
  return {
    connection,
    close: () => connection.close(),
  }
}
