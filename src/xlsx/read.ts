/**
 * Read the first worksheet of an XLSX workbook as rows of text, safely.
 *
 * - The archive is read by `zip/read.ts` (zip-bomb guards) and every XML part by the DTD-free
 *   tokenizer in `xml/tokenize.ts` (no XXE, no entity expansion).
 * - **Formulas are never evaluated.** A formula cell yields the value Excel cached when the file
 *   was saved (`<v>`), or nothing; the formula text itself is ignored.
 * - Shared strings are the one part that must be held in memory; their count and every string's
 *   length are capped (`maxSharedStrings`, `maxCellChars`), and their bytes count toward the
 *   inflation budget.
 * - Numbers in a date or time format become ISO 8601 text (`2026-11-18`, `2026-11-18T10:00:00.000Z`),
 *   the form the importer's date coercion expects. Excel stores dates as day counts, and only the
 *   cell's number format says it is a date.
 * - Rows keep their spreadsheet numbers (`r="7"`), so the import report points at the row the user
 *   sees in Excel, even when empty rows were skipped in the file.
 *
 * @module
 */
import { ImportExportError } from '../errors.ts'
import type { ImportLimits } from '../limits.ts'
import { type XmlEvent, XmlTokenizer } from '../xml/tokenize.ts'
import { ZipReader } from '../zip/read.ts'

/** One row: its 1-based spreadsheet row number and its cells (missing cells are `''`). */
export interface XlsxRow {
  readonly row: number
  readonly cells: string[]
}

/** The largest workbook.xml, relationships or styles part read into memory. */
const SMALL_PART_BYTES = 4 * 1024 * 1024

const malformed = (reason: string): ImportExportError =>
  new ImportExportError('malformed_file', { params: { reason } })

/** Run the tokenizer over a streamed part. */
async function* events(zip: ZipReader, name: string): AsyncGenerator<XmlEvent> {
  const tokenizer = new XmlTokenizer()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    for await (const chunk of zip.stream(name))
      yield* tokenizer.push(decoder.decode(chunk, { stream: true }))
    yield* tokenizer.push(decoder.decode())
  } catch (error) {
    if (error instanceof TypeError)
      throw new ImportExportError('invalid_encoding', { cause: error })
    throw error
  }
  yield* tokenizer.end()
}

/** Tokenize a small part held in memory. */
function smallEvents(xml: string): XmlEvent[] {
  const tokenizer = new XmlTokenizer()
  return [...tokenizer.push(xml), ...tokenizer.end()]
}

/** Resolve a relationship target against the folder of the part that owns it. */
function resolveTarget(base: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `${base}/${target}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) throw malformed('relationship target outside the package')
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

/** The worksheet part of the first sheet, and the shared strings and styles parts (if any). */
async function locateParts(
  zip: ZipReader,
): Promise<{ sheet: string; sharedStrings: string | undefined; styles: string | undefined }> {
  if (!zip.has('xl/workbook.xml'))
    throw new ImportExportError('unsupported_format', { params: { reason: 'no xl/workbook.xml' } })
  let firstSheetRel: string | undefined
  for (const event of smallEvents(await zip.text('xl/workbook.xml', SMALL_PART_BYTES))) {
    if (event.kind === 'open' && event.name === 'sheet' && firstSheetRel === undefined)
      firstSheetRel = event.attrs.get('id')
  }
  const targets = new Map<string, { type: string; target: string }>()
  if (zip.has('xl/_rels/workbook.xml.rels')) {
    for (const event of smallEvents(
      await zip.text('xl/_rels/workbook.xml.rels', SMALL_PART_BYTES),
    )) {
      if (event.kind !== 'open' || event.name !== 'Relationship') continue
      const id = event.attrs.get('Id')
      const target = event.attrs.get('Target')
      if (id !== undefined && target !== undefined && event.attrs.get('TargetMode') !== 'External')
        targets.set(id, {
          type: event.attrs.get('Type') ?? '',
          target: resolveTarget('xl', target),
        })
    }
  }
  const byType = (suffix: string): string | undefined =>
    [...targets.values()].find((t) => t.type.endsWith(`/${suffix}`))?.target
  const sheet =
    (firstSheetRel === undefined ? undefined : targets.get(firstSheetRel)?.target) ??
    'xl/worksheets/sheet1.xml'
  const sharedStrings =
    byType('sharedStrings') ??
    (zip.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : undefined)
  const styles = byType('styles') ?? (zip.has('xl/styles.xml') ? 'xl/styles.xml' : undefined)
  if (!zip.has(sheet)) throw malformed('the first worksheet is missing')
  return {
    sheet,
    sharedStrings: sharedStrings && zip.has(sharedStrings) ? sharedStrings : undefined,
    styles: styles && zip.has(styles) ? styles : undefined,
  }
}

/** Built-in number formats that are dates or times (ECMA-376 §18.8.30). */
const BUILTIN_DATE_FORMATS: ReadonlySet<number> = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57,
])
const TIME_ONLY_FORMATS: ReadonlySet<number> = new Set([18, 19, 20, 21, 45, 46, 47])

/** Does a custom format code show a date or time? (Quoted text and `[colour]` are ignored.) */
export function isDateFormatCode(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
  return /[dmyhs]/i.test(bare) && !/^[#0.,%\sE+-]*$/i.test(bare)
}

type DateStyle = 'date' | 'datetime'

/** For each cell style index: whether it shows a date or a date-time. */
async function dateStyles(
  zip: ZipReader,
  part: string | undefined,
): Promise<Map<number, DateStyle>> {
  const styles = new Map<number, DateStyle>()
  if (part === undefined) return styles
  const custom = new Map<number, string>()
  let inCellXfs = false
  let index = 0
  for (const event of smallEvents(await zip.text(part, SMALL_PART_BYTES))) {
    if (event.kind === 'open' && event.name === 'numFmt') {
      const id = Number(event.attrs.get('numFmtId'))
      custom.set(id, event.attrs.get('formatCode') ?? '')
    } else if (event.kind === 'open' && event.name === 'cellXfs') inCellXfs = !event.selfClosing
    else if (event.kind === 'close' && event.name === 'cellXfs') inCellXfs = false
    else if (inCellXfs && event.kind === 'open' && event.name === 'xf') {
      const id = Number(event.attrs.get('numFmtId') ?? '0')
      const code = custom.get(id)
      const isDate = code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormatCode(code)
      if (isDate) {
        const time =
          code === undefined
            ? TIME_ONLY_FORMATS.has(id) || id === 22
            : /[hs]/i.test(code.replace(/"[^"]*"/g, ''))
        styles.set(index, time ? 'datetime' : 'date')
      }
      index++
    }
  }
  return styles
}

/** Read the shared strings table, bounded by count and per-string length. */
async function readSharedStrings(
  zip: ZipReader,
  part: string | undefined,
  limits: Pick<ImportLimits, 'maxSharedStrings' | 'maxCellChars'>,
): Promise<string[]> {
  const strings: string[] = []
  if (part === undefined) return strings
  let current: string | undefined
  let inText = false
  let phonetic = 0
  for await (const event of events(zip, part)) {
    if (event.kind === 'open') {
      if (event.name === 'si' && !event.selfClosing) current = ''
      else if (event.name === 'si') pushString('')
      else if (event.name === 'rPh' && !event.selfClosing) phonetic++
      else if (event.name === 't' && !event.selfClosing) inText = true
    } else if (event.kind === 'close') {
      if (event.name === 'si' && current !== undefined) {
        pushString(current)
        current = undefined
      } else if (event.name === 'rPh') phonetic--
      else if (event.name === 't') inText = false
    } else if (inText && phonetic === 0 && current !== undefined) {
      current += event.text
      if (current.length > limits.maxCellChars)
        throw new ImportExportError('cell_too_long', {
          params: { row: 0, max: limits.maxCellChars },
        })
    }
  }
  return strings

  function pushString(value: string): void {
    if (strings.length >= limits.maxSharedStrings)
      throw new ImportExportError('unsafe_file', {
        params: { reason: `more than ${limits.maxSharedStrings} shared strings` },
      })
    strings.push(value)
  }
}

/** `"AB12"` → 27 (0-based column), or `undefined` when the reference is not a cell reference. */
export function columnIndex(ref: string): number | undefined {
  const match = /^([A-Z]{1,3})\d*$/.exec(ref)
  if (match === null) return undefined
  let n = 0
  for (const ch of match[1] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const MS_PER_DAY = 86_400_000
const EXCEL_EPOCH_OFFSET_DAYS = 25_569

/** An Excel date serial (1900 system) as ISO 8601 text, or `undefined` when out of range. */
export function serialToIso(serial: number, style: DateStyle): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return undefined
  // Serials below 61 sit before Excel's phantom 1900-02-29; nobody imports those dates.
  const ms = Math.round((serial - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY)
  const iso = new Date(ms).toISOString()
  return style === 'date' ? iso.slice(0, 10) : iso
}

/**
 * Yield the rows of the first worksheet.
 *
 * @example
 * for await (const { row, cells } of readXlsx(bytes, limits)) console.log(row, cells)
 */
export async function* readXlsx(
  bytes: Uint8Array,
  limits: ImportLimits,
): AsyncGenerator<XlsxRow, void, undefined> {
  if (bytes.byteLength > limits.maxFileBytes)
    throw new ImportExportError('file_too_large', { params: { max: limits.maxFileBytes } })
  const zip = ZipReader.open(bytes, limits)
  const parts = await locateParts(zip)
  const styles = await dateStyles(zip, parts.styles)
  const shared = await readSharedStrings(zip, parts.sharedStrings, limits)

  let row: { number: number; cells: string[] } | undefined
  let lastRow = 0
  let cell: { column: number; type: string; style: number } | undefined
  let nextColumn = 0
  let value = ''
  let inValue = false
  let inInline = 0
  let inText = false
  let inFormula = false

  const finishCell = (): void => {
    if (row === undefined || cell === undefined) return
    const text = cellValue(cell, value)
    if (text !== '') {
      while (row.cells.length < cell.column) row.cells.push('')
      row.cells[cell.column] = text
    }
    cell = undefined
  }

  const cellValue = (c: { type: string; style: number }, raw: string): string => {
    switch (c.type) {
      case 's': {
        const index = Number(raw)
        const text = Number.isInteger(index) ? shared[index] : undefined
        if (text === undefined && raw !== '')
          throw malformed('a shared string index is out of range')
        return text ?? ''
      }
      case 'b':
        return raw === '1' ? 'true' : raw === '0' ? 'false' : raw
      case 'e':
        return ''
      case 'inlineStr':
      case 'str':
      case 'd':
        return raw
      default: {
        const style = styles.get(c.style)
        if (style !== undefined && raw !== '') return serialToIso(Number(raw), style) ?? raw
        return raw
      }
    }
  }

  for await (const event of events(zip, parts.sheet)) {
    if (event.kind === 'open') {
      switch (event.name) {
        case 'row': {
          const r = Number(event.attrs.get('r') ?? lastRow + 1)
          if (!Number.isSafeInteger(r) || r <= lastRow) throw malformed('rows out of order')
          lastRow = r
          nextColumn = 0
          row = { number: r, cells: [] }
          if (event.selfClosing) {
            yield { row: r, cells: [] }
            row = undefined
          }
          break
        }
        case 'c': {
          if (row === undefined) throw malformed('a cell outside a row')
          const ref = event.attrs.get('r')
          const column = ref === undefined ? nextColumn : columnIndex(ref)
          if (column === undefined) throw malformed('an invalid cell reference')
          if (column >= limits.maxColumns)
            throw new ImportExportError('too_many_columns', { params: { max: limits.maxColumns } })
          nextColumn = column + 1
          cell = {
            column,
            type: event.attrs.get('t') ?? 'n',
            style: Number(event.attrs.get('s') ?? '0'),
          }
          value = ''
          if (event.selfClosing) finishCell()
          break
        }
        case 'v':
          inValue = !event.selfClosing
          break
        case 'f':
          inFormula = !event.selfClosing
          break
        case 'is':
          if (!event.selfClosing) inInline++
          break
        case 't':
          inText = inInline > 0 && !event.selfClosing
          break
      }
    } else if (event.kind === 'close') {
      switch (event.name) {
        case 'row':
          finishCell()
          if (row !== undefined) yield { row: row.number, cells: row.cells }
          row = undefined
          break
        case 'c':
          finishCell()
          break
        case 'v':
          inValue = false
          break
        case 'f':
          inFormula = false
          break
        case 'is':
          inInline--
          break
        case 't':
          inText = false
          break
      }
    } else if (cell !== undefined && !inFormula && (inValue || inText)) {
      value += event.text
      if (value.length > limits.maxCellChars)
        throw new ImportExportError('cell_too_long', {
          params: { row: row?.number ?? 0, max: limits.maxCellChars },
        })
    }
  }
}
