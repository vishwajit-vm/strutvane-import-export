/**
 * Column mapping: which file column feeds which model column.
 *
 * - **Detect:** the first non-blank row is the heading row. Headings are compared trimmed and
 *   case-insensitively; two equal headings are `duplicate_header` (which one would win?).
 * - **Auto-map:** a heading matches an importable column by name (`email`, `Email`,
 *   `email address` → `email_address`) or by label. Only importable columns are ever matched, so a
 *   file with a `password` or `tenant_id` heading simply has that column ignored, and the ignored
 *   headings are reported.
 * - **Explicit mapping** (`{ "E-mail": "email", "Notes": null }`): every heading named must exist,
 *   every target must be importable (or the primary key when it is the match key, for lookups
 *   only), and no two headings may feed one column. A saved mapping is just this object.
 *
 * @module
 */
import { ImportExportError } from '../errors.ts'
import type { ColumnDescriptor, ModelColumns } from '../model/columns.ts'

/** File heading → model column (`null` = ignore that file column). */
export type ColumnMapping = Readonly<Record<string, string | null>>

/** A mapping applied to one file's headings. */
export interface ResolvedMapping {
  /** The headings, as written in the file (trimmed). */
  readonly headings: readonly string[]
  /** For each file column index, the model column it feeds (or `undefined`: ignored). */
  readonly targets: readonly (ColumnDescriptor | undefined)[]
  /** The effective mapping (what was used, explicit or automatic): save it to reuse it. */
  readonly mapping: ColumnMapping
  /** Headings that feed nothing. */
  readonly ignored: readonly string[]
  /** Importable columns no heading feeds. */
  readonly unmapped: readonly string[]
}

/**
 * The comparable form of a heading or column name: lowercase, runs of anything but letters and
 * digits become one `_`.
 *
 * @example
 * normalizeHeading(' E-mail Address ') // 'e_mail_address'
 */
export function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
}

/** Trim the heading row and refuse duplicates. */
export function readHeadings(cells: readonly string[]): string[] {
  const headings = cells.map((cell) => cell.trim())
  const seen = new Set<string>()
  for (const heading of headings) {
    if (heading === '') continue
    const key = heading.toLowerCase()
    if (seen.has(key))
      throw new ImportExportError('duplicate_header', { params: { column: heading.slice(0, 100) } })
    seen.add(key)
  }
  if (seen.size === 0) throw new ImportExportError('empty_file')
  return headings
}

/**
 * Match headings to importable columns automatically.
 *
 * @example
 * autoMap(['Name', 'E-mail', 'password'], columns) // { Name: 'name', 'E-mail': null, password: null }
 */
export function autoMap(
  headings: readonly string[],
  columns: ModelColumns,
  lookupOnly: readonly string[] = [],
): Record<string, string | null> {
  const byKey = new Map<string, string>()
  const add = (text: string, column: string): void => {
    // Both "e_mail" and "email" find the column `email` ("E-mail", "E mail", "EMAIL").
    for (const key of [normalizeHeading(text), normalizeHeading(text).replaceAll('_', '')])
      if (!byKey.has(key)) byKey.set(key, column)
  }
  const candidates = [
    ...columns.importable.values(),
    ...lookupOnly.flatMap((name) => {
      const column = columns.all.get(name)
      return column === undefined ? [] : [column]
    }),
  ]
  for (const column of candidates) add(column.name, column.name)
  for (const column of candidates) add(column.label, column.name)
  const used = new Set<string>()
  const mapping: Record<string, string | null> = {}
  for (const heading of headings) {
    if (heading === '') continue
    const normal = normalizeHeading(heading)
    const target = byKey.get(normal) ?? byKey.get(normal.replaceAll('_', ''))
    const value = target === undefined || used.has(target) ? null : target
    if (value !== null) used.add(value)
    Object.defineProperty(mapping, heading, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return mapping
}

/**
 * Apply a mapping (or the automatic one) to a file's headings, checking every rule above.
 *
 * @example
 * resolveMapping(['Name', 'Email'], columns, { Name: 'name', Email: 'email' }).targets.length // 2
 */
export function resolveMapping(
  headings: readonly string[],
  columns: ModelColumns,
  explicit?: ColumnMapping,
  options: { readonly lookupOnly?: readonly string[] } = {},
): ResolvedMapping {
  const mapping = explicit ?? autoMap(headings, columns, options.lookupOnly)
  const index = new Map<string, number>()
  headings.forEach((heading, i) => {
    if (heading !== '') index.set(heading.toLowerCase(), i)
  })
  const targets: (ColumnDescriptor | undefined)[] = headings.map(() => undefined)
  const used = new Set<string>()
  const lookupOnly = new Set(options.lookupOnly ?? [])
  for (const [heading, target] of Object.entries(mapping)) {
    const at = index.get(heading.trim().toLowerCase())
    if (at === undefined)
      throw new ImportExportError('unknown_source_column', {
        params: { column: heading.slice(0, 100) },
      })
    if (target === null) continue
    if (typeof target !== 'string')
      throw new ImportExportError('invalid_option', {
        params: { option: 'mapping', reason: 'targets are column names or null' },
      })
    const descriptor =
      columns.importable.get(target) ??
      (lookupOnly.has(target) ? columns.all.get(target) : undefined)
    if (descriptor === undefined) {
      // Never confirm that a hidden column exists: the same answer as for a missing one.
      const visible = columns.exportable.has(target) || columns.importable.has(target)
      throw new ImportExportError(visible ? 'column_not_importable' : 'unknown_column', {
        params: { column: target.slice(0, 100) },
      })
    }
    if (used.has(target))
      throw new ImportExportError('duplicate_mapping', { params: { column: target } })
    used.add(target)
    targets[at] = descriptor
  }
  const effective: Record<string, string | null> = {}
  headings.forEach((heading, i) => {
    if (heading === '') return
    Object.defineProperty(effective, heading, {
      value: targets[i]?.name ?? null,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  })
  return {
    headings,
    targets,
    mapping: effective,
    ignored: headings.filter((heading, i) => heading !== '' && targets[i] === undefined),
    unmapped: [...columns.importable.keys()].filter((name) => !used.has(name)),
  }
}
