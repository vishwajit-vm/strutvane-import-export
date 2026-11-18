/**
 * Resource limits for reading untrusted files. Every reader enforces them **while** it reads, so
 * a hostile file is refused after at most one limit's worth of work: memory stays bounded by
 * these numbers, never by the size of the input.
 *
 * Why these defaults: 20 MiB and 100,000 rows cover the spreadsheets people actually export from
 * other tools, while a single import can still finish synchronously in chunks (queues come in
 * framework 0.3). Raise them per model or in `config/import-export.ts`, never by removing them.
 *
 * @module
 */
import { ImportExportError } from './errors.ts'

/**
 * Limits for one import file.
 *
 * @example
 * const limits: ImportLimits = { ...DEFAULT_LIMITS, maxRows: 500_000 }
 */
export interface ImportLimits {
  /** Largest upload in bytes (the stored file, compressed for XLSX). */
  readonly maxFileBytes: number
  /** Most data rows (the header row is not counted). */
  readonly maxRows: number
  /** Most cells in one row. */
  readonly maxColumns: number
  /** Longest cell, in characters. */
  readonly maxCellChars: number
  /**
   * XLSX only: the most bytes all ZIP entries we read may inflate to (the zip-bomb guard). A
   * spreadsheet's XML compresses about 10:1, so the default allows ~10x `maxFileBytes`.
   */
  readonly maxUncompressedBytes: number
  /** XLSX only: the highest compression ratio one entry may have (zip-bomb guard). */
  readonly maxCompressionRatio: number
  /** XLSX only: the most entries the archive may list. */
  readonly maxZipEntries: number
  /** XLSX only: the most shared strings the workbook may define. */
  readonly maxSharedStrings: number
}

/**
 * The defaults: 20 MiB, 100,000 rows, 200 columns, 32,767 characters per cell (Excel's own cell
 * limit), 200 MiB inflated, ratio 200:1, 1,000 ZIP entries, 1,000,000 shared strings.
 *
 * @example
 * DEFAULT_LIMITS.maxRows // 100000
 */
export const DEFAULT_LIMITS: ImportLimits = Object.freeze({
  maxFileBytes: 20 * 1024 * 1024,
  maxRows: 100_000,
  maxColumns: 200,
  maxCellChars: 32_767,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxZipEntries: 1_000,
  maxSharedStrings: 1_000_000,
})

/**
 * Merge overrides into the defaults and check every value is a positive safe integer (a limit of
 * `0`, `NaN` or `Infinity` would silently disable a guard, so it is refused).
 *
 * @example
 * resolveLimits({ maxRows: 10 }).maxRows // 10
 */
export function resolveLimits(overrides: Partial<ImportLimits> = {}): ImportLimits {
  const merged: ImportLimits = { ...DEFAULT_LIMITS, ...definedOnly(overrides) }
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ImportExportError('invalid_option', {
        params: { option: key, reason: 'a limit must be a positive whole number' },
      })
  }
  return Object.freeze(merged)
}

function definedOnly(values: Partial<ImportLimits>): Partial<ImportLimits> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Partial<ImportLimits>
}
