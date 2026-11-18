/**
 * From spreadsheet text to typed values, column by column, with a stable lowercase issue code for
 * every refusal (RFC-0003). Spreadsheet cells are always text here; the column's kind from the
 * schema decides what the text must look like.
 *
 * The rules are strict on purpose: nothing is guessed, rounded or truncated. `12.345` for a
 * two-decimal column is an error, not `12.35`; `31/12/2026` is an error, not a guess between
 * day-first and month-first. A wrong guess would be stored silently; an error is fixed once.
 *
 * @module
 */
import type { ErrorParams } from '@strutvane/framework/core'
import type { ColumnDescriptor } from './columns.ts'

/** The outcome for one cell: a value (`undefined` = leave it to the database), or an issue. */
export type Coerced =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly params?: ErrorParams }

const ok = (value: unknown): Coerced => ({ ok: true, value })
const fail = (code: string, params?: ErrorParams): Coerced =>
  params === undefined ? { ok: false, code } : { ok: false, code, params }

const INT32 = { min: -2_147_483_648, max: 2_147_483_647 }
const TRUE_WORDS: ReadonlySet<string> = new Set(['true', 'yes', 'y', '1', 'on'])
const FALSE_WORDS: ReadonlySet<string> = new Set(['false', 'no', 'n', '0', 'off'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/i

/** Is `y-m-d` a real calendar date? */
function realDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/**
 * Parse an ISO 8601 date-time. A value without a zone is taken as UTC (spreadsheets carry no
 * zone; the alternative, the server's zone, would make the result depend on where it runs).
 *
 * @example
 * parseDateTime('2026-11-18 10:30')?.toISOString() // '2026-11-18T10:30:00.000Z'
 */
export function parseDateTime(text: string): Date | undefined {
  const m = DATETIME.exec(text)
  if (m === null) return undefined
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0', zone] = m
  if (!realDate(Number(y), Number(mo), Number(d))) return undefined
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return undefined
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  ms += Number(frac.padEnd(3, '0').slice(0, 3))
  if (zone !== undefined && zone.toUpperCase() !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1
    const digits = zone.slice(1).replace(':', '')
    const offset = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))
    if (offset > 18 * 60) return undefined
    ms -= sign * offset * 60_000
  }
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function coerceInteger(text: string, column: ColumnDescriptor): Coerced {
  const m = /^([+-]?\d+)(?:\.0+)?$/.exec(text)
  if (m === null) return fail('invalid_integer')
  const n = Number(m[1])
  if (!Number.isSafeInteger(n))
    return fail(
      n < 0 ? 'too_small' : 'too_big',
      n < 0 ? { min: Number.MIN_SAFE_INTEGER } : { max: Number.MAX_SAFE_INTEGER },
    )
  if (column.kind === 'integer' && (n < INT32.min || n > INT32.max))
    return n < 0 ? fail('too_small', { min: INT32.min }) : fail('too_big', { max: INT32.max })
  if ((column.kind === 'id' || column.kind === 'foreignId') && n < 1)
    return fail('too_small', { min: 1 })
  return ok(n)
}

function coerceDecimal(text: string, column: ColumnDescriptor): Coerced {
  const precision = column.precision ?? 8
  const scale = column.scale ?? 2
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text)
  const whole = (m?.[2] ?? '').replace(/^0+(?=\d)/, '')
  const fraction = (m?.[3] ?? '').replace(/0+$/, '')
  if (m === null || (m[2] === '' && (m[3] ?? '') === '')) return fail('invalid_number')
  if (fraction.length > scale || whole.length > precision - scale)
    return fail('invalid_decimal', { precision, scale })
  return ok(
    `${m[1] === '-' ? '-' : ''}${whole === '' ? '0' : whole}${fraction === '' ? '' : `.${fraction}`}`,
  )
}

/**
 * Coerce one cell for one column. Empty text means "no value": `null` for a nullable column,
 * `undefined` (left to the database default) when the column has one, otherwise `required`.
 *
 * @example
 * coerceCell(ageColumn, '36')   // { ok: true, value: 36 }
 * coerceCell(ageColumn, 'old')  // { ok: false, code: 'invalid_integer' }
 */
export function coerceCell(column: ColumnDescriptor, raw: string): Coerced {
  const text = raw.trim()
  if (text === '') {
    if (column.nullable) return ok(null)
    if (column.optional) return ok(undefined)
    return fail('required')
  }
  switch (column.kind) {
    case 'id':
    case 'integer':
    case 'bigInteger':
    case 'foreignId':
      return coerceInteger(text, column)
    case 'decimal':
      return coerceDecimal(text, column)
    case 'double': {
      const n = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text) ? Number(text) : Number.NaN
      return Number.isFinite(n) ? ok(n) : fail('invalid_number')
    }
    case 'boolean': {
      const word = text.toLowerCase()
      if (TRUE_WORDS.has(word)) return ok(true)
      if (FALSE_WORDS.has(word)) return ok(false)
      return fail('invalid_boolean')
    }
    case 'date': {
      const m = DATE.exec(text)
      return m !== null && realDate(Number(m[1]), Number(m[2]), Number(m[3]))
        ? ok(text)
        : fail('invalid_date')
    }
    case 'timestamp': {
      const date = parseDateTime(text)
      return date === undefined ? fail('invalid_datetime') : ok(date)
    }
    case 'json': {
      try {
        return ok(JSON.parse(text))
      } catch {
        return fail('invalid_json')
      }
    }
    case 'enum': {
      const values = column.values ?? []
      if (values.includes(text)) return ok(text)
      // Spreadsheets love to capitalise: accept a case-insensitive match, store the real value.
      const match = values.find((v) => v.toLowerCase() === text.toLowerCase())
      return match !== undefined ? ok(match) : fail('not_in_list', { options: values.join(', ') })
    }
    case 'uuid':
      return UUID.test(text) ? ok(text.toLowerCase()) : fail('invalid_uuid')
    default: {
      // string, text, slug: the text as given (trimmed), within the column's length.
      if (column.length !== undefined && [...text].length > column.length)
        return fail('too_long', { max: column.length })
      return ok(text)
    }
  }
}
