/**
 * A streaming CSV parser (RFC 4180, plus what spreadsheet programs really write).
 *
 * - **Encoding:** strict UTF-8. A leading byte-order mark is dropped; any invalid byte sequence
 *   fails with `invalid_encoding` instead of turning into replacement characters that would then
 *   be stored as data.
 * - **Quoting:** `"a ""quoted"" value"`, delimiters and line breaks inside quotes, CRLF, LF and lone
 *   CR line endings. Text after a closing quote is kept (`"ab"c` → `abc`, as Excel reads it); an
 *   unterminated quote at the end of the file is `malformed_file`.
 * - **Delimiter:** `,` `;` tab or `|`, given or sniffed from the first record.
 * - **Bounded memory:** the file size, the cells per row and the characters per cell are checked
 *   while reading, so a hostile file (one 2 GB cell, a row of a million empty cells) fails after at
 *   most one limit's worth of work. Rows are yielded one at a time; the caller holds the rest.
 *
 * @module
 */
import { ImportExportError } from '../errors.ts'
import type { ImportLimits } from '../limits.ts'

/** Delimiters the parser accepts. */
export type CsvDelimiter = ',' | ';' | '\t' | '|'

/** The delimiters {@link sniffDelimiter} chooses from, in tie-break order. */
export const CSV_DELIMITERS: readonly CsvDelimiter[] = Object.freeze([',', ';', '\t', '|'])

/** Options for {@link parseCsv}. */
export interface CsvParseOptions {
  /** The delimiter; sniffed from the first record when omitted. */
  readonly delimiter?: CsvDelimiter
  /** Size limits (only `maxFileBytes`, `maxColumns` and `maxCellChars` apply here). */
  readonly limits: Pick<ImportLimits, 'maxFileBytes' | 'maxColumns' | 'maxCellChars'>
}

/** One parsed record: its 1-based record number and its cells. */
export interface CsvRecord {
  readonly row: number
  readonly cells: string[]
}

/** How much text is buffered to sniff the delimiter when the first record is very long. */
const SNIFF_CHARS = 64 * 1024

/**
 * Guess the delimiter from the start of a file: the candidate that occurs most often in the first
 * record, outside quotes. Ties and no candidate at all fall back to the earlier one in
 * {@link CSV_DELIMITERS} (so plain one-column files read as comma-separated).
 *
 * @example
 * sniffDelimiter('name;email\nAda;ada@example.com') // ';'
 */
export function sniffDelimiter(sample: string): CsvDelimiter {
  const counts = new Map<CsvDelimiter, number>(CSV_DELIMITERS.map((d) => [d, 0]))
  let quoted = false
  for (const ch of sample) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === '\n' || ch === '\r')) break
    else if (!quoted && counts.has(ch as CsvDelimiter))
      counts.set(ch as CsvDelimiter, (counts.get(ch as CsvDelimiter) ?? 0) + 1)
  }
  let best: CsvDelimiter = ','
  let bestCount = 0
  for (const d of CSV_DELIMITERS) {
    const n = counts.get(d) ?? 0
    if (n > bestCount) {
      best = d
      bestCount = n
    }
  }
  return best
}

/** The parser's position inside a record. */
type State = 'field-start' | 'unquoted' | 'quoted' | 'quote-in-quoted'

/**
 * Parse CSV bytes into records, one at a time.
 *
 * @example
 * for await (const { row, cells } of parseCsv(file, { limits })) save(row, cells)
 */
export async function* parseCsv(
  source: AsyncIterable<Uint8Array>,
  options: CsvParseOptions,
): AsyncGenerator<CsvRecord, void, undefined> {
  const { limits } = options
  // fatal: invalid UTF-8 throws. ignoreBOM false (the default): a leading BOM is removed.
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let delimiter = options.delimiter
  let pending = '' // text held back until the delimiter is known
  let bytes = 0
  let state: State = 'field-start'
  let field = ''
  let cells: string[] = []
  let row = 1
  let lastWasCr = false
  let inRecord = false

  const tooLong = (): ImportExportError =>
    new ImportExportError('cell_too_long', { params: { row, max: limits.maxCellChars } })

  const endField = (): void => {
    if (cells.length >= limits.maxColumns)
      throw new ImportExportError('too_many_columns', { params: { max: limits.maxColumns } })
    cells.push(field)
    field = ''
  }

  const decode = (chunk: Uint8Array, stream: boolean): string => {
    try {
      return decoder.decode(chunk, { stream })
    } catch (error) {
      throw new ImportExportError('invalid_encoding', { cause: error })
    }
  }

  /** Feed text; returns the records completed by it. */
  function* feed(text: string, sep: string): Generator<CsvRecord> {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i)
      // "\r\n" is one line break: skip the "\n" right after a "\r" that ended a record.
      if (lastWasCr) {
        lastWasCr = false
        if (ch === '\n') continue
      }
      switch (state) {
        case 'field-start':
        case 'unquoted': {
          if (ch === '"' && state === 'field-start') {
            state = 'quoted'
            inRecord = true
          } else if (ch === sep) {
            endField()
            state = 'field-start'
            inRecord = true
          } else if (ch === '\n' || ch === '\r') {
            lastWasCr = ch === '\r'
            endField()
            const record = { row, cells }
            cells = []
            row++
            state = 'field-start'
            inRecord = false
            yield record
          } else {
            if (field.length >= limits.maxCellChars) throw tooLong()
            field += ch
            state = 'unquoted'
            inRecord = true
          }
          break
        }
        case 'quoted': {
          if (ch === '"') state = 'quote-in-quoted'
          else {
            if (field.length >= limits.maxCellChars) throw tooLong()
            field += ch
          }
          break
        }
        case 'quote-in-quoted': {
          if (ch === '"') {
            // An escaped quote ("").
            if (field.length >= limits.maxCellChars) throw tooLong()
            field += '"'
            state = 'quoted'
          } else if (ch === sep) {
            endField()
            state = 'field-start'
          } else if (ch === '\n' || ch === '\r') {
            lastWasCr = ch === '\r'
            endField()
            const record = { row, cells }
            cells = []
            row++
            state = 'field-start'
            inRecord = false
            yield record
          } else {
            // Text after the closing quote: kept, as spreadsheet programs do.
            if (field.length >= limits.maxCellChars) throw tooLong()
            field += ch
            state = 'unquoted'
          }
          break
        }
      }
    }
  }

  for await (const chunk of source) {
    bytes += chunk.byteLength
    if (bytes > limits.maxFileBytes)
      throw new ImportExportError('file_too_large', { params: { max: limits.maxFileBytes } })
    const text = decode(chunk, true)
    if (delimiter === undefined) {
      pending += text
      if (!/[\r\n]/.test(pending) && pending.length < SNIFF_CHARS) continue
      delimiter = sniffDelimiter(pending)
      const held = pending
      pending = ''
      yield* feed(held, delimiter)
      continue
    }
    yield* feed(text, delimiter)
  }
  const tail = decode(new Uint8Array(0), false)
  const sep = delimiter ?? sniffDelimiter(pending + tail)
  yield* feed(pending + tail, sep)
  // `feed` changes `state`; widen it again (TypeScript cannot see assignments made inside it).
  const last = state as State
  if (last === 'quoted')
    throw new ImportExportError('malformed_file', {
      params: { reason: `unterminated quoted cell in row ${row}` },
    })
  // A last record without a final line break.
  if (inRecord || field !== '' || cells.length > 0 || last === 'quote-in-quoted') {
    endField()
    yield { row, cells }
  }
}
