/**
 * The export engine: a model query streamed out as CSV or XLSX in bounded memory.
 *
 * - **Rows** are read with keyset pagination (`cursorPaginate`, 100 rows a page), so memory holds
 *   one page and one output chunk whatever the table size, and the read is stable while rows are
 *   added (no row is skipped or repeated the way offset paging would).
 * - **Columns** are only ever exportable ones: hidden and secret columns (the model's `hidden`,
 *   `.hidden()`/`.secret()` in the migration, secret-looking names) and the tenant column can't be
 *   selected, filtered on (a filter is an oracle) or written. Asking for one is "unknown column",
 *   the same answer as for a missing one.
 * - **Rows the caller may see**: the tenant scope (ORM + RLS) and, for an actor, the `view`
 *   filter (`wherePolicy`) apply to every page.
 * - **Cells** go through the formula guard (`cells.ts`): no exported text can run as a formula.
 *
 * @module
 */
import { runWithTenant } from '@strutvane/framework/database'
import { type Access, accessActor, assertAllowed } from '../access.ts'
import { type OutputCell, type OutputKind, toOutputCell } from '../cells.ts'
import type { ResolvedModel } from '../config.ts'
import type { CsvDelimiter } from '../csv/parse.ts'
import { csvLine, UTF8_BOM } from '../csv/write.ts'
import { ImportExportError } from '../errors.ts'
import { type ColumnDescriptor, runtimeModel } from '../model/columns.ts'
import type { FileFormat } from '../source.ts'
import { XLSX_MAX_ROWS, xlsxStream } from '../xlsx/write.ts'

/** Options for {@link exportRows}. */
export interface ExportOptions {
  readonly model: ResolvedModel
  readonly access: Access
  readonly format: FileFormat
  /** Columns to write, in order (default: the model's `exportColumns`, else every exportable one). */
  readonly columns?: readonly string[]
  /** Equality filters on exportable columns (`{ tier: 'pro' }`). */
  readonly where?: Readonly<Record<string, string | number | boolean | null>>
  /** Heading row: column names (default, re-importable as is) or human labels. */
  readonly headings?: 'columns' | 'labels'
  readonly delimiter?: CsvDelimiter
  /** Start a CSV with a UTF-8 byte-order mark, so Excel on Windows reads accents right (default true). */
  readonly bom?: boolean
  readonly tenantId?: string
  /** Stop with an error past this many rows (default: none for CSV, Excel's limit for XLSX). */
  readonly maxRows?: number
  /** Called once with the number of rows written, when the stream ends. */
  readonly onFinish?: (rows: number) => void
}

/** Rows per page read from the database (the ORM's default maximum). */
const PAGE_SIZE = 100

/** How a column kind is written. */
export function outputKind(column: ColumnDescriptor): OutputKind {
  switch (column.kind) {
    case 'id':
    case 'integer':
    case 'bigInteger':
    case 'foreignId':
    case 'decimal':
    case 'double':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'timestamp':
      return 'datetime'
    case 'json':
      return 'json'
    default:
      return 'text'
  }
}

/** Resolve the requested columns, refusing anything that is not exportable. */
export function exportColumns(
  model: ResolvedModel,
  requested?: readonly string[],
): ColumnDescriptor[] {
  const columns = model.columns()
  const names = requested ?? model.options.exportColumns ?? [...columns.exportable.keys()]
  if (names.length === 0)
    throw new ImportExportError('invalid_option', {
      params: { option: 'columns', reason: 'choose at least one column' },
    })
  const seen = new Set<string>()
  return names.map((name) => {
    const column = columns.exportable.get(name)
    // Hidden columns get the same answer as missing ones: no confirmation they exist.
    if (column === undefined)
      throw new ImportExportError('unknown_column', { params: { column: name.slice(0, 100) } })
    if (seen.has(name))
      throw new ImportExportError('duplicate_mapping', { params: { column: name } })
    seen.add(name)
    return column
  })
}

/**
 * Stream an export. Nothing is read before the first chunk is pulled, and stopping early (a client
 * that disconnects) stops the database reads.
 *
 * @example
 * for await (const chunk of exportRows({ model, access: systemAccess(), format: 'csv' })) out.write(chunk)
 */
export function exportRows(options: ExportOptions): AsyncGenerator<Uint8Array, void, undefined> {
  assertAllowed(options.access, 'export')
  const { model } = options
  const columns = exportColumns(model, options.columns)
  const where = Object.entries(options.where ?? {})
  const filterColumns = model.columns()
  for (const [name] of where) {
    if (!filterColumns.exportable.has(name))
      throw new ImportExportError('unknown_column', { params: { column: name.slice(0, 100) } })
  }
  const headings = columns.map((column) =>
    toOutputCell(options.headings === 'labels' ? column.label : column.name, 'text'),
  )
  const kinds = columns.map(outputKind)
  const limit =
    options.maxRows ?? (options.format === 'xlsx' ? XLSX_MAX_ROWS - 1 : Number.POSITIVE_INFINITY)
  const Model = runtimeModel(model.model)
  const actor = accessActor(options.access)
  const view = options.access.kind === 'actor' ? options.access.filters.view : undefined
  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    options.tenantId === undefined ? work() : runWithTenant(options.tenantId, work)

  async function* records(): AsyncGenerator<OutputCell[]> {
    let cursor: string | undefined
    let written = 0
    try {
      for (;;) {
        const page = await scoped(() => {
          let query = Model.query()
          for (const [name, value] of where) {
            query =
              value === null
                ? query.whereNull(name as never)
                : query.where(name as never, value as never)
          }
          if (actor !== null && view !== undefined) query = query.wherePolicy(view, { actor })
          return query.cursorPaginate(PAGE_SIZE, cursor)
        })
        for (const record of page.data) {
          written++
          if (written > limit)
            throw new ImportExportError('too_many_rows', { params: { max: limit } })
          yield columns.map((column, i) =>
            toOutputCell(Reflect.get(record, column.name) as never, kinds[i] ?? 'text'),
          )
        }
        if (page.nextCursor === null) break
        cursor = page.nextCursor
      }
    } finally {
      options.onFinish?.(Math.min(written, limit))
    }
  }

  if (options.format === 'xlsx')
    return xlsxStream({ sheet: model.key, header: headings, rows: records() })
  return csvStream(headings, records(), options.delimiter ?? ',', options.bom ?? true)
}

async function* csvStream(
  headings: readonly OutputCell[],
  rows: AsyncIterable<readonly OutputCell[]>,
  delimiter: CsvDelimiter,
  bom: boolean,
): AsyncGenerator<Uint8Array, void, undefined> {
  const encoder = new TextEncoder()
  let batch = `${bom ? UTF8_BOM : ''}${csvLine(headings, delimiter)}`
  for await (const row of rows) {
    batch += csvLine(row, delimiter)
    if (batch.length >= 64 * 1024) {
      yield encoder.encode(batch)
      batch = ''
    }
  }
  yield encoder.encode(batch)
}
