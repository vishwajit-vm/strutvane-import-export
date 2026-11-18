/**
 * Where import rows come from: format detection by magic bytes, and one row stream for CSV and
 * XLSX alike.
 *
 * The format is decided by the **bytes**, never by the file name or the MIME type the browser
 * claimed (both are attacker-controlled): a ZIP archive is read as XLSX, valid UTF-8 text as CSV,
 * and anything else (PDF, images, executables, old binary `.xls`, gzip) is `unsupported_format`.
 * The framework's `detectMime` does the sniffing, the same as for every other upload.
 *
 * @module
 */
import { detectMime } from '@strutvane/framework'
import { type CsvDelimiter, parseCsv } from './csv/parse.ts'
import { ImportExportError } from './errors.ts'
import type { ImportLimits } from './limits.ts'
import { readXlsx } from './xlsx/read.ts'

/** The file formats this package reads and writes. */
export type FileFormat = 'csv' | 'xlsx'

/** Re-openable bytes: an import reads its file more than once (detect, then rows; resume). */
export type ByteSource = () => AsyncIterable<Uint8Array>

/** One row of the file: its 1-based row number (as a spreadsheet shows it) and its cells. */
export interface SheetRow {
  readonly row: number
  readonly cells: readonly string[]
}

/** Text MIME types `detectMime` may report for a CSV (markup sniffing does not matter here). */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/html',
  'image/svg+xml',
  'application/xml',
])

/** The OLE2 compound-file signature of legacy binary `.xls` files. */
const OLE2 = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/**
 * Decide the format from the first bytes of a file.
 *
 * @example
 * detectFormat(new TextEncoder().encode('name,email\n')) // 'csv'
 */
export function detectFormat(head: Uint8Array): FileFormat {
  const mime = detectMime(head)
  if (mime === 'application/x-empty') throw new ImportExportError('empty_file')
  if (mime === 'application/zip') return 'xlsx'
  if (OLE2.every((byte, i) => head[i] === byte))
    throw new ImportExportError('unsupported_format', {
      params: { reason: 'legacy .xls workbooks are not supported; save the file as .xlsx or CSV' },
    })
  if (TEXT_TYPES.has(mime)) return 'csv'
  throw new ImportExportError('unsupported_format', { params: { reason: mime } })
}

/** Read up to `size` bytes from the start of a source (for detection). */
export async function readHead(source: ByteSource, size = 512): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of source()) {
    parts.push(chunk)
    length += chunk.byteLength
    if (length >= size) break
  }
  return Buffer.concat(parts).subarray(0, size)
}

/** Read a whole source into memory, refusing more than `maxBytes` (XLSX needs random access). */
export async function readAll(source: ByteSource, maxBytes: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const chunk of source()) {
    length += chunk.byteLength
    if (length > maxBytes)
      throw new ImportExportError('file_too_large', { params: { max: maxBytes } })
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

/** Options for {@link readRows}. */
export interface ReadRowsOptions {
  readonly format: FileFormat
  readonly limits: ImportLimits
  readonly delimiter?: CsvDelimiter
}

/**
 * Every row of the file, header included, with blank rows skipped and the row limit enforced
 * (`maxRows` data rows plus the header).
 *
 * @example
 * for await (const { row, cells } of readRows(source, { format: 'csv', limits })) …
 */
export async function* readRows(
  source: ByteSource,
  options: ReadRowsOptions,
): AsyncGenerator<SheetRow, void, undefined> {
  const { limits } = options
  const rows =
    options.format === 'csv'
      ? parseCsv(source(), {
          limits,
          ...(options.delimiter === undefined ? {} : { delimiter: options.delimiter }),
        })
      : readXlsx(await readAll(source, limits.maxFileBytes), limits)
  let count = 0
  for await (const row of rows) {
    if (row.cells.every((cell) => cell.trim() === '')) continue
    count++
    if (count > limits.maxRows + 1)
      throw new ImportExportError('too_many_rows', { params: { max: limits.maxRows } })
    yield row
  }
}

/**
 * Bytes from a web `ReadableStream` (what a storage disk returns) as an async iterable, releasing
 * the reader when the consumer stops early.
 *
 * @example
 * const source: ByteSource = () => fromWebStream(await disk.get(key))
 */
export async function* fromWebStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
