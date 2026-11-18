/**
 * The import engine: file rows in, model rows out, with a per-row report.
 *
 * **Three modes** (`mode`):
 *
 * | Mode | Writes | Transactions | Resumable |
 * |---|---|---|---|
 * | `dry-run` | none (everything is rolled back) | one, rolled back at the end | no |
 * | `commit` (`onError: 'skip'`, default) | the valid rows | one per chunk of `chunkSize` rows | yes, from the last committed chunk |
 * | `commit` (`onError: 'rollback'`) | all rows, or none if any row fails | one for the whole file | no (re-run it) |
 *
 * A dry run performs the **same** writes as a real import inside a transaction it always rolls
 * back, so its report includes what only the database knows: unique values (also across rows of
 * the same file), missing references, policy checks after the write. A dry run that reports no
 * errors means the real import succeeds, unless the data changes in between.
 *
 * **Per row**, inside a savepoint: coerce the cells, run the model's extra rules, find the
 * existing row by the match key (upsert, within the caller's `update` filter), check required
 * columns for new rows, `fill()` + `save()` (the ORM's mass-assignment and tenant rules apply on
 * top of ours), then check the written row against the caller's `create`/`update` filter. Any
 * row-level failure rolls back only that savepoint and becomes an issue in the report; a failure
 * that is not about the row (the database is gone, a tenancy misconfiguration) aborts the import
 * and rolls back the open transaction, so nothing half-written is left.
 *
 * **Tenancy:** with `tenantId`, everything runs inside `runWithTenant`, so every lookup and write
 * is scoped by the ORM and, on PostgreSQL, by row-level security for the transaction.
 *
 * @module
 */
import type { Logger } from '@strutvane/framework/contracts'
import type { IssueInput, Messages } from '@strutvane/framework/core'
import { renderIssues } from '@strutvane/framework/core'
import {
  type Connection,
  defaultConnection,
  ModelBase,
  runWithTenant,
} from '@strutvane/framework/database'
import { type Access, accessActor, assertAllowed } from '../access.ts'
import type { ResolvedModel } from '../config.ts'
import type { CsvDelimiter } from '../csv/parse.ts'
import { ImportExportError } from '../errors.ts'
import { defaultMessages } from '../messages.ts'
import { runtimeModel } from '../model/columns.ts'
import {
  type ByteSource,
  detectFormat,
  type FileFormat,
  readHead,
  readRows,
  type SheetRow,
} from '../source.ts'
import {
  type ColumnMapping,
  type ResolvedMapping,
  readHeadings,
  resolveMapping,
} from './mapping.ts'
import { applyRules, missingRequired, type PreparedRow, prepareRow } from './rows.ts'

/** What to do with a row that fails. */
export type OnRowError = 'skip' | 'rollback'

/** One failed row, ready for a report or the `failed_import_rows` table. */
export interface RowFailure {
  readonly row: number
  readonly issues: readonly {
    readonly field: string
    readonly code: string
    readonly message: string
    readonly params?: Readonly<Record<string, string | number | boolean>>
  }[]
}

/** Progress after a committed chunk (`commit` + `skip` only): persist it to resume later. */
export interface ChunkProgress {
  /** The last file row of the chunk: resume after it. */
  readonly lastRow: number
  readonly processed: number
  readonly created: number
  readonly updated: number
  readonly failed: number
  /** The failures of this chunk only. */
  readonly failures: readonly RowFailure[]
}

/** Options for {@link runImport}. */
export interface ImportOptions {
  readonly model: ResolvedModel
  readonly source: ByteSource
  readonly access: Access
  readonly mode: 'dry-run' | 'commit'
  readonly onError?: OnRowError
  readonly format?: FileFormat
  readonly delimiter?: CsvDelimiter
  /** Heading → column; automatic when omitted. */
  readonly mapping?: ColumnMapping
  /** Upsert: update rows whose values in these columns match (defaults to the model's `uniqueBy`). */
  readonly upsertBy?: readonly string[]
  /** Disable upserts even when the model has a `uniqueBy`. */
  readonly createOnly?: boolean
  readonly tenantId?: string
  readonly chunkSize?: number
  /** Resume: skip file rows up to and including this one (from {@link ChunkProgress.lastRow}). */
  readonly resumeAfterRow?: number
  /** Counts carried over from the run being resumed. */
  readonly resumeCounts?: {
    readonly processed: number
    readonly created: number
    readonly updated: number
    readonly failed: number
  }
  /** Called inside each chunk's transaction (`commit` + `skip`): throwing rolls the chunk back. */
  readonly onChunk?: (progress: ChunkProgress) => Promise<void>
  readonly maxReportedErrors?: number
  readonly messages?: Messages
  readonly logger?: Logger
  /** The connection (default: the app's, as models resolve it). */
  readonly connection?: Connection
}

/** The outcome of an import. */
export interface ImportResult {
  readonly dryRun: boolean
  readonly format: FileFormat
  readonly mapping: ColumnMapping
  readonly ignoredHeadings: readonly string[]
  /** Data rows read (blank rows are not counted). */
  readonly processed: number
  readonly created: number
  readonly updated: number
  readonly failed: number
  /** The first `maxReportedErrors` failures, in file order. */
  readonly failures: readonly RowFailure[]
  /** More rows failed than the report keeps. */
  readonly truncated: boolean
  /** `commit` + `rollback` with failures: nothing was written. */
  readonly rolledBack: boolean
  /** The last file row handled. */
  readonly lastRow: number
}

/** Thrown inside a transaction to roll it back on purpose (dry runs, failed atomic imports). */
class Rollback extends Error {}

/** A write the caller's filter refuses after the fact. */
class PolicyViolation extends Error {}

const FOREIGN_KEY =
  /FOREIGN KEY constraint failed|foreign key constraint|a foreign key constraint fails/i

/** Text of an error and its causes, for classification only (never reported). */
function errorText(error: unknown): string {
  const parts: string[] = []
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 5; depth++) {
    parts.push(e.message)
    for (const key of ['detail', 'constraint', 'code'] as const) {
      const value = (e as unknown as Record<string, unknown>)[key]
      if (typeof value === 'string') parts.push(value)
    }
    e = e.cause
  }
  return parts.join(' ')
}

/**
 * Turn a write failure into row issues, or `undefined` when the failure is not about the row (the
 * caller then aborts). Database messages are never copied into the report: they can contain the
 * rejected value.
 */
function rowIssues(
  error: unknown,
  connection: Connection,
  columns: readonly string[],
): IssueInput[] | undefined {
  if (error instanceof PolicyViolation) return [{ path: [], code: 'forbidden' }]
  const code = (error as { readonly code?: unknown } | null)?.code
  const text = errorText(error)
  const columnIn = (): string | undefined =>
    columns.find((name) => new RegExp(`(^|[^a-z0-9_])${name}([^a-z0-9_]|$)`, 'i').test(text))
  if (connection.grammar.isUniqueViolation(error)) {
    const column = columnIn()
    return [{ path: column === undefined ? [] : [column], code: 'unique' }]
  }
  if (FOREIGN_KEY.test(text) || code === '23503') {
    const column = columnIn()
    return [{ path: column === undefined ? [] : [column], code: 'invalid_reference' }]
  }
  if (code === 'mass_assignment') {
    const field = (error as { readonly field?: unknown }).field
    return [{ path: typeof field === 'string' ? [field] : [], code: 'unknown_field' }]
  }
  if (code === 'invalid_value') {
    const column = columnIn()
    return [{ path: column === undefined ? [] : [column], code: 'invalid' }]
  }
  // Check constraints, NOT NULL and value-too-long errors from the engine.
  if (
    /23514|23502|22001|NOT NULL constraint failed|CHECK constraint failed|cannot be null|Data too long/i.test(
      text,
    )
  ) {
    const column = columnIn()
    return [{ path: column === undefined ? [] : [column], code: 'invalid' }]
  }
  return undefined
}

/** A bare model over any table, for tenant-scoped existence checks of referenced rows. */
function referenceModel(table: string): typeof ModelBase {
  return class Reference extends ModelBase {
    static override readonly table: string = table
  }
}

/** The most reference checks remembered per import (each answer is reused for repeated ids). */
const MAX_CACHED_REFERENCES = 10_000

/** The row's match-key values, or `undefined` when a key cell is empty (then it is a create). */
function matchKey(
  values: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): unknown[] | undefined {
  const out: unknown[] = []
  for (const key of keys) {
    const value = values[key]
    if (value === undefined || value === null) return undefined
    out.push(value)
  }
  return out
}

/**
 * Run an import (see the module comment for the modes).
 *
 * @example
 * const result = await runImport({ model: config.model('contacts'), source, access: systemAccess(), mode: 'dry-run' })
 */
export async function runImport(options: ImportOptions): Promise<ImportResult> {
  assertAllowed(options.access, 'import')
  const work = (): Promise<ImportResult> => importInScope(options)
  return options.tenantId === undefined ? work() : runWithTenant(options.tenantId, work)
}

async function importInScope(options: ImportOptions): Promise<ImportResult> {
  const { model: definition, access } = options
  const Model = runtimeModel(definition.model)
  const columns = definition.columns()
  const connection = options.connection ?? defaultConnection()
  const messages = options.messages ?? defaultMessages()
  const labels = Object.fromEntries([...columns.all.values()].map((c) => [c.name, c.label]))
  const dryRun = options.mode === 'dry-run'
  const onError: OnRowError = options.onError ?? 'skip'
  const chunked = !dryRun && onError === 'skip'
  const chunkSize = options.chunkSize ?? 500
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 5_000)
    throw new ImportExportError('invalid_option', {
      params: { option: 'chunkSize', reason: 'from 1 to 5000' },
    })
  const maxErrors = options.maxReportedErrors ?? 1_000
  const actor = accessActor(access)
  const filters = access.kind === 'actor' ? access.filters : {}
  const mayUpdate = access.kind === 'system' || access.can.update

  const upsertBy =
    options.createOnly === true ? [] : [...(options.upsertBy ?? definition.options.uniqueBy ?? [])]
  for (const key of upsertBy) {
    if (!columns.importable.has(key) && key !== columns.primaryKey)
      throw new ImportExportError('invalid_upsert_key', { params: { column: key.slice(0, 100) } })
  }
  const format = options.format ?? detectFormat(await readHead(options.source))
  const rows = readRows(options.source, {
    format,
    limits: definition.limits,
    ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
  })

  const counts = {
    processed: options.resumeCounts?.processed ?? 0,
    created: options.resumeCounts?.created ?? 0,
    updated: options.resumeCounts?.updated ?? 0,
    failed: options.resumeCounts?.failed ?? 0,
  }
  const failures: RowFailure[] = []
  let truncated = false
  let mapping: ResolvedMapping | undefined
  let lastRow = options.resumeAfterRow ?? 0
  const seenKeys = new Set<string>()
  const startAfter = options.resumeAfterRow ?? 0
  const writable = [...columns.importable.keys()]
  const references = new Map<string, typeof ModelBase>()
  const knownReferences = new Map<string, boolean>()

  /**
   * Check that every reference names an existing row, through the ORM, so the tenant scope
   * applies: an id from another tenant is "not found" on every engine, before any foreign key or
   * row-level security is involved.
   */
  const checkReferences = async (
    values: Readonly<Record<string, unknown>>,
  ): Promise<IssueInput[]> => {
    const issues: IssueInput[] = []
    for (const [name, value] of Object.entries(values)) {
      const target = columns.importable.get(name)?.references
      if (target === undefined || value === null || value === undefined) continue
      const cacheKey = `${target.table}\u0000${target.column}\u0000${String(value)}`
      let exists = knownReferences.get(cacheKey)
      if (exists === undefined) {
        let model = references.get(target.table)
        if (model === undefined) {
          model = referenceModel(target.table)
          references.set(target.table, model)
        }
        exists = await model
          .query()
          .where(target.column as never, value as never)
          .exists()
        if (knownReferences.size < MAX_CACHED_REFERENCES) knownReferences.set(cacheKey, exists)
      }
      if (!exists) issues.push({ path: [name], code: 'invalid_reference' })
    }
    return issues
  }

  const fail = (row: number, issues: readonly IssueInput[], chunkFailures: RowFailure[]): void => {
    counts.failed++
    const failure: RowFailure = {
      row,
      issues: renderIssues(issues, messages, { labels }).map((issue) => ({
        field: issue.field,
        code: issue.code,
        message: issue.message,
        ...(issue.params === undefined
          ? {}
          : { params: issue.params as Readonly<Record<string, string | number | boolean>> }),
      })),
    }
    chunkFailures.push(failure)
    if (failures.length < maxErrors) failures.push(failure)
    else truncated = true
  }

  /** Write one prepared row inside a savepoint; returns the issues if it failed. */
  const writeRow = async (prepared: PreparedRow): Promise<'created' | 'updated' | IssueInput[]> => {
    let values = prepared.values
    if (definition.options.rules !== undefined) {
      const ruled = await applyRules(definition.options.rules, values, columns.importable)
      if (ruled.issues.length > 0) return ruled.issues
      values = ruled.values
    }
    const key = upsertBy.length > 0 ? matchKey(values, upsertBy) : undefined
    if (key !== undefined) {
      const fingerprint = JSON.stringify(key)
      if (seenKeys.has(fingerprint))
        return upsertBy.map((column) => ({ path: [column], code: 'duplicate_key' }))
      seenKeys.add(fingerprint)
    }
    try {
      return await connection.transaction(async () => {
        let existing: InstanceType<typeof Model> | undefined
        if (key !== undefined) {
          let query = Model.query()
          upsertBy.forEach((column, i) => {
            query = query.where(column as never, key[i] as never)
          })
          if (actor !== null && filters.update !== undefined)
            query = query.wherePolicy(filters.update, { actor })
          existing = mayUpdate ? await query.first() : undefined
        }
        const lookupOnly = upsertBy.filter((column) => !columns.importable.has(column))
        if (existing === undefined && lookupOnly.length > 0)
          return lookupOnly.map((column) => ({ path: [column], code: 'not_found' }))
        const writeValues = Object.fromEntries(
          Object.entries(values).filter(([column]) => columns.importable.has(column)),
        )
        const unknown = await checkReferences(writeValues)
        if (unknown.length > 0) return unknown
        if (existing === undefined) {
          const missing = missingRequired(columns.importable, writeValues, [])
          if (missing.length > 0) return missing
          const created = Model.make()
          created.fill(writeValues)
          await created.save()
          await checkWritten(created, filters.create)
          return 'created'
        }
        existing.fill(writeValues)
        await existing.save()
        await checkWritten(existing, filters.update)
        return 'updated'
      })
    } catch (error) {
      const issues = rowIssues(error, connection, writable)
      if (issues === undefined) throw error
      return issues
    }
  }

  /** The `WITH CHECK` of an import: the written row must match the caller's filter. */
  const checkWritten = async (
    instance: InstanceType<typeof Model>,
    filter: (typeof filters)['create'],
  ): Promise<void> => {
    if (actor === null || filter === undefined) return
    const id = Reflect.get(instance, columns.primaryKey)
    const visible = await Model.query()
      .where(columns.primaryKey as never, id as never)
      .wherePolicy(filter, { actor })
      .exists()
    if (!visible) throw new PolicyViolation()
  }

  const processChunk = async (
    chunk: readonly SheetRow[],
    current: ResolvedMapping,
  ): Promise<void> => {
    const chunkFailures: RowFailure[] = []
    const before = { ...counts }
    const body = async (): Promise<void> => {
      for (const row of chunk) {
        counts.processed++
        const prepared = prepareRow(row, current)
        if (prepared.issues.length > 0) {
          fail(row.row, prepared.issues, chunkFailures)
          continue
        }
        const outcome = await writeRow(prepared)
        if (outcome === 'created') counts.created++
        else if (outcome === 'updated') counts.updated++
        else fail(row.row, outcome, chunkFailures)
      }
      const last = chunk.at(-1)
      if (last !== undefined) lastRow = last.row
      if (chunked && options.onChunk !== undefined)
        await options.onChunk({ lastRow, ...counts, failures: chunkFailures })
    }
    if (!chunked) return body()
    try {
      await connection.transaction(body)
    } catch (error) {
      // The chunk was rolled back: its counts must not survive in the result either.
      Object.assign(counts, before)
      throw error
    }
  }

  const readAll = async (): Promise<void> => {
    let chunk: SheetRow[] = []
    for await (const row of rows) {
      if (mapping === undefined) {
        const headings = readHeadings(row.cells)
        mapping = resolveMapping(headings, columns, options.mapping, {
          lookupOnly: upsertBy.filter((column) => column === columns.primaryKey),
        })
        continue
      }
      if (row.row <= startAfter) continue
      chunk.push(row)
      if (chunk.length >= chunkSize) {
        await processChunk(chunk, mapping)
        chunk = []
      }
    }
    if (mapping === undefined) throw new ImportExportError('empty_file')
    if (chunk.length > 0) await processChunk(chunk, mapping)
  }

  let rolledBack = false
  if (chunked) await readAll()
  else {
    try {
      await connection.transaction(async () => {
        await readAll()
        if (dryRun || counts.failed > 0) throw new Rollback()
      })
    } catch (error) {
      if (!(error instanceof Rollback)) throw error
      rolledBack = !dryRun
    }
  }
  const resolved = mapping as ResolvedMapping | undefined
  options.logger?.info('import finished', {
    model: definition.key,
    dryRun,
    processed: counts.processed,
    created: counts.created,
    updated: counts.updated,
    failed: counts.failed,
    rolledBack,
  })
  return {
    dryRun,
    format,
    mapping: resolved?.mapping ?? {},
    ignoredHeadings: resolved?.ignored ?? [],
    ...counts,
    ...(rolledBack ? { created: 0, updated: 0 } : {}),
    failures,
    truncated,
    rolledBack,
    lastRow,
  }
}
