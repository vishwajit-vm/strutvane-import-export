/**
 * CSV output: RFC 4180 quoting and CRLF line endings, so every spreadsheet program reads the file
 * the same way. Values arrive as {@link OutputCell}s, which are already formula-guarded.
 *
 * @module
 */
import { cellText, type OutputCell } from '../cells.ts'
import type { CsvDelimiter } from './parse.ts'

/** The UTF-8 byte-order mark: lets Excel on Windows open a UTF-8 CSV with the right encoding. */
export const UTF8_BOM = '﻿'

/**
 * Quote a field when it contains the delimiter, a quote, a line break, or leading/trailing spaces
 * (which some readers would trim); quotes inside are doubled.
 *
 * @example
 * escapeCsvField('say "hi"', ',') // '"say ""hi"""'
 */
export function escapeCsvField(text: string, delimiter: CsvDelimiter): string {
  const needsQuotes =
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\n') ||
    text.includes('\r') ||
    text !== text.trim()
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * One CSV line (with its CRLF) from output cells.
 *
 * @example
 * csvLine([{ kind: 'text', text: 'Ada' }, { kind: 'number', text: '36' }], ',') // 'Ada,36\r\n'
 */
export function csvLine(cells: readonly OutputCell[], delimiter: CsvDelimiter): string {
  return `${cells.map((cell) => escapeCsvField(cellText(cell), delimiter)).join(delimiter)}\r\n`
}
