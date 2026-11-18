/**
 * A streaming XLSX (Office Open XML spreadsheet) writer: one worksheet, written row by row into a
 * streamed ZIP, so an export of a million rows needs no more memory than one.
 *
 * Choices, and why:
 * - **Inline strings** (`t="inlineStr"`) instead of a shared-strings table: the table would have
 *   to be held in memory and written after the sheet. Files are a little larger; memory is flat.
 * - **Typed cells**: numbers as numbers, booleans as booleans, dates as date serials with a date
 *   format, text as text. Text is formula-guarded before it gets here (see `cells.ts`), and a text
 *   cell is never evaluated by a spreadsheet program in the first place.
 * - **No formulas, ever**: the writer has no way to emit `<f>`.
 * - Characters XML 1.0 cannot carry (most control characters, lone surrogates) are dropped, so a
 *   stray byte in the database can't produce a file Excel refuses to open.
 *
 * @module
 */
import type { OutputCell } from '../cells.ts'
import { zipStream } from '../zip/write.ts'

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** Excel's maximum number of rows and columns in one sheet. */
export const XLSX_MAX_ROWS = 1_048_576
/** Excel's maximum number of columns in one sheet. */
export const XLSX_MAX_COLUMNS = 16_384

/**
 * Escape text for XML content and attribute values, dropping characters XML 1.0 forbids.
 *
 * @example
 * xmlEscape('a < b & "c"') // 'a &lt; b &amp; &quot;c&quot;'
 */
export function xmlEscape(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
  )
}

/**
 * The column letters of a 0-based column index (`0` → `A`, `27` → `AB`).
 *
 * @example
 * columnLetters(27) // 'AB'
 */
export function columnLetters(index: number): string {
  let n = index + 1
  let letters = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    letters = String.fromCharCode(65 + rem) + letters
    n = Math.floor((n - 1) / 26)
  }
  return letters
}

/** Days between 1899-12-30 (Excel's day 0 in the 1900 date system) and 1970-01-01. */
const EXCEL_EPOCH_OFFSET_DAYS = 25_569
const MS_PER_DAY = 86_400_000

/**
 * A date as an Excel serial number (1900 date system, UTC).
 *
 * @example
 * excelSerial(new Date('2026-01-01T12:00:00Z')) // 46023.5
 */
export function excelSerial(date: Date): number {
  return date.getTime() / MS_PER_DAY + EXCEL_EPOCH_OFFSET_DAYS
}

/** The first serial Excel shows correctly (1900-03-01) and the last (9999-12-31). */
const MIN_SERIAL = 61
const MAX_SERIAL = 2_958_465

/** Style indexes in the generated styles.xml. */
const STYLE_DATE = 1
const STYLE_DATETIME = 2
const STYLE_HEADER = 3

function cellXml(cell: OutputCell, ref: string, header: boolean): string {
  const style = header ? ` s="${STYLE_HEADER}"` : ''
  switch (cell.kind) {
    case 'empty':
      return ''
    case 'text':
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(cell.text)}</t></is></c>`
    case 'number':
      return `<c r="${ref}"${style}><v>${cell.text}</v></c>`
    case 'boolean':
      return `<c r="${ref}"${style} t="b"><v>${cell.value ? 1 : 0}</v></c>`
    case 'date': {
      const serial = excelSerial(cell.date)
      // Excel has no serials before 1900-03-01 (and a phantom 1900-02-29): write older dates as
      // ISO text, which the importer reads back the same way.
      if (serial < MIN_SERIAL || serial > MAX_SERIAL) {
        const iso = cell.date.toISOString()
        return cellXml({ kind: 'text', text: cell.time ? iso : iso.slice(0, 10) }, ref, header)
      }
      return `<c r="${ref}" s="${cell.time ? STYLE_DATETIME : STYLE_DATE}"><v>${serial}</v></c>`
    }
  }
}

function rowXml(cells: readonly OutputCell[], rowNumber: number, header: boolean): string {
  const inner = cells.map((cell, i) => cellXml(cell, `${columnLetters(i)}${rowNumber}`, header))
  return `<row r="${rowNumber}">${inner.join('')}</row>`
}

/** A sheet name Excel accepts: at most 31 characters, none of `[]:*?/\`. */
export function sheetName(name: string): string {
  const clean = name
    .replace(/[[\]:*?/\\]/g, ' ')
    .trim()
    .slice(0, 31)
  return clean === '' ? 'Sheet1' : clean
}

async function* sheetXml(
  header: readonly OutputCell[],
  rows: AsyncIterable<readonly OutputCell[]>,
): AsyncGenerator<string> {
  // Rows are batched into ~64 KiB strings: one zlib write per row would be slow, one per file
  // would hold the whole sheet in memory.
  let batch = `${XML_HEAD}<worksheet xmlns="${MAIN_NS}"><sheetData>${rowXml(header, 1, true)}`
  let rowNumber = 1
  for await (const row of rows) {
    rowNumber++
    batch += rowXml(row, rowNumber, false)
    if (batch.length >= 64 * 1024) {
      yield batch
      batch = ''
    }
  }
  yield `${batch}</sheetData></worksheet>`
}

const CONTENT_TYPES = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`

const ROOT_RELS = `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`

const WORKBOOK_RELS = `${XML_HEAD}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`

/**
 * Write a one-sheet workbook as a stream of bytes.
 *
 * @example
 * const bytes = xlsxStream({ sheet: 'Contacts', header, rows })
 * await disk.put('exports/contacts.xlsx', Readable.toWeb(Readable.from(bytes)))
 */
export function xlsxStream(input: {
  readonly sheet: string
  readonly header: readonly OutputCell[]
  readonly rows: AsyncIterable<readonly OutputCell[]>
  readonly modified?: Date
}): AsyncGenerator<Uint8Array, void, undefined> {
  const workbook = `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${xmlEscape(sheetName(input.sheet))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  return zipStream(
    [
      { name: '[Content_Types].xml', content: CONTENT_TYPES },
      { name: '_rels/.rels', content: ROOT_RELS },
      { name: 'xl/workbook.xml', content: workbook },
      { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS },
      { name: 'xl/styles.xml', content: STYLES },
      { name: 'xl/worksheets/sheet1.xml', content: sheetXml(input.header, input.rows) },
    ],
    input.modified === undefined ? {} : { modified: input.modified },
  )
}
