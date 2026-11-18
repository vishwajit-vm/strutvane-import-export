/**
 * One file row → typed model values, or the issues that stop it. Pure: no database here, so the
 * column rules can be tested exhaustively and a dry run and a real import judge every row alike.
 *
 * @module
 */
import type { IssueInput } from '@strutvane/framework/core'
import { unescapeFormulaPrefix } from '../cells.ts'
import type { RowSchema } from '../config.ts'
import { coerceCell } from '../model/coerce.ts'
import type { ColumnDescriptor } from '../model/columns.ts'
import type { ResolvedMapping } from './mapping.ts'

/** A row after the column checks. */
export interface PreparedRow {
  /** The row number in the file (as a spreadsheet shows it). */
  readonly row: number
  /** Typed values by column (`undefined` values are left out). */
  readonly values: Record<string, unknown>
  /** Problems found; the row is written only when this is empty. */
  readonly issues: IssueInput[]
}

/** Text-like kinds, where a formula-guard prefix from an earlier export is undone. */
const TEXT_KINDS: ReadonlySet<string> = new Set(['string', 'text', 'slug', 'enum', 'json'])

/** Define an own data property (keys come from the schema, but never through the prototype). */
function put(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Coerce every mapped cell of a row.
 *
 * @example
 * prepareRow({ row: 2, cells: ['Ada', '36'] }, mapping).values // { name: 'Ada', age: 36 }
 */
export function prepareRow(
  row: { readonly row: number; readonly cells: readonly string[] },
  mapping: ResolvedMapping,
): PreparedRow {
  const values: Record<string, unknown> = {}
  const issues: IssueInput[] = []
  mapping.targets.forEach((column, i) => {
    if (column === undefined) return
    const raw = row.cells[i] ?? ''
    const text = TEXT_KINDS.has(column.kind) ? unescapeFormulaPrefix(raw) : raw
    const result = coerceCell(column, text)
    if (!result.ok) {
      issues.push({
        path: [column.name],
        code: result.code,
        ...(result.params === undefined ? {} : { params: result.params }),
      })
    } else if (result.value !== undefined) put(values, column.name, result.value)
  })
  return { row: row.row, values, issues }
}

/**
 * Columns a new row needs but the row does not give (not nullable, no default, not generated).
 *
 * @example
 * missingRequired(importable, { name: 'Ada' }) // [{ path: ['email'], code: 'required' }]
 */
export function missingRequired(
  importable: ReadonlyMap<string, ColumnDescriptor>,
  values: Readonly<Record<string, unknown>>,
  issues: readonly IssueInput[],
): IssueInput[] {
  const reported = new Set(issues.map((issue) => String(issue.path[0] ?? '')))
  const missing: IssueInput[] = []
  for (const column of importable.values()) {
    if (column.optional || Object.hasOwn(values, column.name) || reported.has(column.name)) continue
    missing.push({ path: [column.name], code: 'required' })
  }
  return missing
}

/**
 * Run the model's extra validator. Its output replaces the values (so it may normalise them),
 * but it may only produce columns that are importable: anything else is reported, not written.
 *
 * @example
 * const { values, issues } = await applyRules(schema, prepared.values, importable)
 */
export async function applyRules(
  schema: RowSchema,
  values: Record<string, unknown>,
  importable: ReadonlyMap<string, ColumnDescriptor>,
): Promise<{ values: Record<string, unknown>; issues: IssueInput[] }> {
  const result = await schema['~standard'].validate(values)
  if (result.issues !== undefined) {
    return {
      values,
      issues: result.issues.map((issue) => {
        const path = (issue.path ?? []).map((segment) => {
          const key = typeof segment === 'object' ? segment.key : segment
          return typeof key === 'number' ? key : String(key)
        })
        const raw = (issue as { readonly code?: unknown }).code
        const code = typeof raw === 'string' && /^[a-z][a-z0-9_]*$/.test(raw) ? raw : 'invalid'
        return { path, code, message: issue.message }
      }),
    }
  }
  const output: Record<string, unknown> = {}
  const issues: IssueInput[] = []
  for (const [key, value] of Object.entries(result.value)) {
    if (!importable.has(key)) issues.push({ path: [key], code: 'unknown_field' })
    else if (value !== undefined) put(output, key, value)
  }
  return { values: output, issues }
}
