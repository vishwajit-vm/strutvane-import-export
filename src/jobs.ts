/**
 * The job records: `imports`, `failed_import_rows`, `exports` and `import_mappings` (created by the
 * migration in `migration.ts`), read and written through the ORM.
 *
 * Going through the ORM (not raw SQL) is the point: in a tenancy app these tables carry the tenant
 * column, so every lookup and write here is scoped to the active tenant by the ORM, and by
 * row-level security on PostgreSQL, exactly like app data. On top of that, an actor only ever
 * sees their own jobs (`actor_id`); system access (the CLI) sees every job of the tenant.
 *
 * @module
 */
import { uuidv7 } from '@strutvane/framework/core'
import { ModelBase } from '@strutvane/framework/database'
import { type Access, accessActorId } from './access.ts'
import { ImportExportError } from './errors.ts'
import type { ColumnMapping } from './import/mapping.ts'
import type { OnRowError, RowFailure } from './import/run.ts'
import { TABLES } from './migration.ts'
import type { FileFormat } from './source.ts'

/** The lifecycle of a job. */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

/** What an import was asked to do (stored with the job, reused on resume). */
export interface StoredImportOptions {
  readonly mapping?: ColumnMapping
  readonly upsertBy?: readonly string[]
  readonly createOnly?: boolean
  readonly onError?: OnRowError
  readonly delimiter?: ',' | ';' | '\t' | '|'
}

/** An import job, as stored. */
export interface ImportJob {
  readonly id: string
  readonly model: string
  readonly status: JobStatus
  readonly dryRun: boolean
  readonly format: FileFormat
  readonly disk: string | null
  readonly fileKey: string
  readonly fileName: string | null
  readonly fileSize: number
  readonly fileSha256: string
  readonly options: StoredImportOptions
  readonly nextRow: number
  readonly processed: number
  readonly created: number
  readonly updated: number
  readonly failed: number
  readonly errorCode: string | null
  readonly actorId: string | null
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
}

/** An export job, as stored. */
export interface ExportJob {
  readonly id: string
  readonly model: string
  readonly status: JobStatus
  readonly format: FileFormat
  readonly columns: readonly string[]
  readonly disk: string | null
  readonly fileKey: string | null
  readonly fileName: string | null
  readonly rowCount: number
  readonly errorCode: string | null
  readonly actorId: string | null
  readonly startedAt: Date | null
  readonly finishedAt: Date | null
}

/** A saved column mapping. */
export interface SavedMapping {
  readonly model: string
  readonly name: string
  readonly mapping: ColumnMapping
}

/** The ORM models of the package tables (bare: only trusted code here writes them). */
class ImportRecord extends ModelBase {
  static override readonly table: string = TABLES.imports
}
class FailureRecord extends ModelBase {
  static override readonly table: string = TABLES.failures
}
class ExportRecord extends ModelBase {
  static override readonly table: string = TABLES.exports
}
class MappingRecord extends ModelBase {
  static override readonly table: string = TABLES.mappings
}

/** Read one attribute of a record. */
function get(record: object, column: string): unknown {
  return Reflect.get(record, column)
}
const text = (value: unknown): string => (typeof value === 'string' ? value : String(value ?? ''))
const textOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : text(value)
const count = (value: unknown): number => (typeof value === 'number' ? value : Number(value ?? 0))
const dateOrNull = (value: unknown): Date | null =>
  value instanceof Date
    ? value
    : value === null || value === undefined
      ? null
      : new Date(String(value))
const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function toImportJob(record: object): ImportJob {
  return {
    id: text(get(record, 'id')),
    model: text(get(record, 'model')),
    status: text(get(record, 'status')) as JobStatus,
    dryRun: get(record, 'dry_run') === true || get(record, 'dry_run') === 1,
    format: text(get(record, 'format')) as FileFormat,
    disk: textOrNull(get(record, 'disk')),
    fileKey: text(get(record, 'file_key')),
    fileName: textOrNull(get(record, 'file_name')),
    fileSize: count(get(record, 'file_size')),
    fileSha256: text(get(record, 'file_sha256')),
    options: json<StoredImportOptions>(get(record, 'options'), {}),
    nextRow: count(get(record, 'next_row')),
    processed: count(get(record, 'processed_rows')),
    created: count(get(record, 'created_rows')),
    updated: count(get(record, 'updated_rows')),
    failed: count(get(record, 'failed_rows')),
    errorCode: textOrNull(get(record, 'error_code')),
    actorId: textOrNull(get(record, 'actor_id')),
    startedAt: dateOrNull(get(record, 'started_at')),
    finishedAt: dateOrNull(get(record, 'finished_at')),
  }
}

function toExportJob(record: object): ExportJob {
  return {
    id: text(get(record, 'id')),
    model: text(get(record, 'model')),
    status: text(get(record, 'status')) as JobStatus,
    format: text(get(record, 'format')) as FileFormat,
    columns: json<string[]>(get(record, 'columns'), []),
    disk: textOrNull(get(record, 'disk')),
    fileKey: textOrNull(get(record, 'file_key')),
    fileName: textOrNull(get(record, 'file_name')),
    rowCount: count(get(record, 'row_count')),
    errorCode: textOrNull(get(record, 'error_code')),
    actorId: textOrNull(get(record, 'actor_id')),
    startedAt: dateOrNull(get(record, 'started_at')),
    finishedAt: dateOrNull(get(record, 'finished_at')),
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Find a record by id, visible to `access` (own jobs for an actor). */
async function findRecord(
  Model: typeof ModelBase,
  id: string,
  access: Access,
): Promise<ModelBase | undefined> {
  // A malformed id is "not found", like any id the caller may not see.
  if (!UUID.test(id)) return undefined
  let query = Model.query().where('id' as never, id.toLowerCase() as never)
  if (access.kind === 'actor') query = query.where('actor_id' as never, access.actor.id as never)
  return query.first()
}

/** The new attributes of a fresh import job. */
export interface NewImportJob {
  readonly model: string
  readonly dryRun: boolean
  readonly format: FileFormat
  readonly disk: string | null
  readonly fileKey: string
  readonly fileName: string | null
  readonly fileSize: number
  readonly fileSha256: string
  readonly options: StoredImportOptions
}

/**
 * The job store. Every method runs on the models' connection, in the active tenant.
 *
 * @example
 * const job = await jobs.createImport({ … }, access)
 */
export const jobs: {
  createImport(input: NewImportJob, access: Access): Promise<ImportJob>
  findImport(id: string, access: Access): Promise<ImportJob | undefined>
  claimImport(id: string, access: Access): Promise<{ job: ImportJob; token: string }>
  assertClaim(id: string, token: string): Promise<void>
  updateImport(id: string, patch: Readonly<Record<string, unknown>>): Promise<void>
  recordFailures(importId: string, failures: readonly RowFailure[]): Promise<void>
  failures(importId: string, options?: { readonly limit?: number }): Promise<RowFailure[]>
  createExport(
    input: { model: string; format: FileFormat; columns: readonly string[] },
    access: Access,
  ): Promise<ExportJob>
  findExport(id: string, access: Access): Promise<ExportJob | undefined>
  updateExport(id: string, patch: Readonly<Record<string, unknown>>): Promise<void>
  saveMapping(mapping: SavedMapping, access: Access): Promise<void>
  findMapping(model: string, name: string): Promise<SavedMapping | undefined>
  listMappings(model: string): Promise<SavedMapping[]>
} = {
  async createImport(input, access) {
    const record = ImportRecord.make()
    record.forceFill({
      id: uuidv7(),
      model: input.model,
      status: 'pending',
      dry_run: input.dryRun,
      format: input.format,
      disk: input.disk,
      file_key: input.fileKey,
      file_name: input.fileName,
      file_size: input.fileSize,
      file_sha256: input.fileSha256,
      options: input.options,
      actor_id: accessActorId(access) ?? null,
    })
    await record.save()
    return toImportJob(record)
  },

  async findImport(id, access) {
    const record = await findRecord(ImportRecord, id, access)
    return record === undefined ? undefined : toImportJob(record)
  },

  /**
   * Take ownership of a job for a run: a fresh claim token is written, so a run that still holds
   * an older token (a crashed process brought back, a double click) stops at its next chunk.
   * Completed jobs and dry runs cannot be claimed.
   */
  async claimImport(id, access) {
    const record = await findRecord(ImportRecord, id, access)
    if (record === undefined) throw new ImportExportError('job_not_found')
    const job = toImportJob(record)
    if (job.status === 'completed')
      throw new ImportExportError('job_not_resumable', {
        params: { reason: 'it has already completed' },
      })
    const token = uuidv7()
    record.forceFill({
      status: 'running',
      claim_token: token,
      error_code: null,
      started_at: job.startedAt ?? new Date(),
    })
    await record.save()
    return { job: toImportJob(record), token }
  },

  async assertClaim(id, token) {
    const record = await ImportRecord.query()
      .where('id' as never, id as never)
      .first()
    if (record === undefined || get(record, 'claim_token') !== token)
      throw new ImportExportError('job_not_resumable', {
        params: { reason: 'another run took it over' },
      })
  },

  async updateImport(id, patch) {
    const record = await ImportRecord.query()
      .where('id' as never, id as never)
      .first()
    if (record === undefined) throw new ImportExportError('job_not_found')
    record.forceFill(patch)
    await record.save()
  },

  async recordFailures(importId, failures) {
    for (const failure of failures) {
      const record = FailureRecord.make()
      record.forceFill({ import_id: importId, row: failure.row, issues: failure.issues })
      await record.save()
    }
  },

  async failures(importId, options = {}) {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100)
    const page = await FailureRecord.query()
      .where('import_id' as never, importId as never)
      .orderBy('row' as never)
      .limit(limit)
      .get()
    return page.map((record) => ({
      row: count(get(record, 'row')),
      issues: json<RowFailure['issues']>(get(record, 'issues'), []),
    }))
  },

  async createExport(input, access) {
    const record = ExportRecord.make()
    record.forceFill({
      id: uuidv7(),
      model: input.model,
      status: 'running',
      format: input.format,
      columns: [...input.columns],
      actor_id: accessActorId(access) ?? null,
      started_at: new Date(),
    })
    await record.save()
    return toExportJob(record)
  },

  async findExport(id, access) {
    const record = await findRecord(ExportRecord, id, access)
    return record === undefined ? undefined : toExportJob(record)
  },

  async updateExport(id, patch) {
    const record = await ExportRecord.query()
      .where('id' as never, id as never)
      .first()
    if (record === undefined) throw new ImportExportError('job_not_found')
    record.forceFill(patch)
    await record.save()
  },

  async saveMapping(mapping, access) {
    const existing = await MappingRecord.query()
      .where('model' as never, mapping.model as never)
      .where('name' as never, mapping.name as never)
      .first()
    const record = existing ?? MappingRecord.make()
    record.forceFill({
      model: mapping.model,
      name: mapping.name,
      mapping: mapping.mapping,
      actor_id: accessActorId(access) ?? null,
    })
    await record.save()
  },

  async findMapping(model, name) {
    const record = await MappingRecord.query()
      .where('model' as never, model as never)
      .where('name' as never, name as never)
      .first()
    return record === undefined
      ? undefined
      : { model, name, mapping: json<ColumnMapping>(get(record, 'mapping'), {}) }
  },

  async listMappings(model) {
    const records = await MappingRecord.query()
      .where('model' as never, model as never)
      .orderBy('name' as never)
      .limit(100)
      .get()
    return records.map((record) => ({
      model,
      name: text(get(record, 'name')),
      mapping: json<ColumnMapping>(get(record, 'mapping'), {}),
    }))
  },
}
