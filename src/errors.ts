/**
 * The errors of `@strutvane/import-export`, in the framework's error model (RFC-0003): a
 * `StrutvaneError` with a stable lowercase `snake_case` code and primitive params. Messages come
 * from the catalog in `messages.ts`, never from here, so wording and translations stay in one place.
 *
 * Why one class with a code union instead of a class per failure: callers branch on `code`
 * (`error.code === 'file_too_large'`), the HTTP layer renders any `StrutvaneError` as an RFC 9457
 * problem, and a new failure is one union member plus one catalog entry.
 *
 * @module
 */
import { type ErrorParams, StrutvaneError } from '@strutvane/framework/core'

/**
 * Every code this package raises (file-level and configuration failures). Row-level validation
 * problems are not errors: they are issues in the row report (see `import/report.ts`).
 *
 * @example
 * const code: ImportExportErrorCode = 'file_too_large'
 */
export type ImportExportErrorCode =
  /** The upload is larger than `limits.maxFileBytes`. */
  | 'file_too_large'
  /** More data rows than `limits.maxRows`. */
  | 'too_many_rows'
  /** A row has more cells than `limits.maxColumns`. */
  | 'too_many_columns'
  /** One cell is longer than `limits.maxCellChars`. */
  | 'cell_too_long'
  /** The bytes are not valid UTF-8 (CSV) or not valid XML text (XLSX). */
  | 'invalid_encoding'
  /** Neither CSV nor XLSX (by magic bytes, never by file name or client MIME type). */
  | 'unsupported_format'
  /** The file is structurally broken (unterminated quote, truncated ZIP, bad XML). */
  | 'malformed_file'
  /** The file tries something dangerous: a zip bomb, a DOCTYPE/entity (XXE), encrypted entries. */
  | 'unsafe_file'
  /** No header row, or no data at all. */
  | 'empty_file'
  /** Two header cells name the same column. */
  | 'duplicate_header'
  /** A mapping names a file column that does not exist. */
  | 'unknown_source_column'
  /** A mapping or export names a model column that does not exist (or may not be named). */
  | 'unknown_column'
  /** Two file columns are mapped to the same model column. */
  | 'duplicate_mapping'
  /** The column exists but may not be imported (system, tenant, hidden or secret, not fillable). */
  | 'column_not_importable'
  /** The column exists but may not be exported (hidden or secret). */
  | 'column_not_exportable'
  /** The upsert key is not a set of importable columns. */
  | 'invalid_upsert_key'
  /** The model was not registered for import/export in `config/import-export.ts`. */
  | 'model_not_registered'
  /** An option is out of range or of the wrong type. */
  | 'invalid_option'
  /** No import or export with that id is visible to the caller. */
  | 'job_not_found'
  /** The job is finished, running elsewhere, or was a dry run. */
  | 'job_not_resumable'
  /** The stored file no longer matches the checksum recorded when the import started. */
  | 'file_changed'
  /** The caller may not import into, or export from, this model. */
  | 'import_export_forbidden'

/** Default HTTP status per code (an instance may override it). */
export const ERROR_STATUS: Readonly<Record<ImportExportErrorCode, number>> = Object.freeze({
  file_too_large: 413,
  too_many_rows: 422,
  too_many_columns: 422,
  cell_too_long: 422,
  invalid_encoding: 422,
  unsupported_format: 415,
  malformed_file: 422,
  unsafe_file: 422,
  empty_file: 422,
  duplicate_header: 422,
  unknown_source_column: 422,
  unknown_column: 422,
  duplicate_mapping: 422,
  column_not_importable: 422,
  column_not_exportable: 422,
  invalid_upsert_key: 422,
  model_not_registered: 404,
  invalid_option: 422,
  job_not_found: 404,
  job_not_resumable: 409,
  file_changed: 409,
  import_export_forbidden: 403,
})

/**
 * A file-level or configuration failure. `params` carry primitives only (a column name, a limit),
 * never cell contents: a cell may hold personal data or a secret, and errors end up in logs.
 *
 * @example
 * throw new ImportExportError('file_too_large', { params: { max: 20_971_520 } })
 */
export class ImportExportError extends StrutvaneError {
  declare readonly code: ImportExportErrorCode

  constructor(
    code: ImportExportErrorCode,
    options: {
      readonly params?: ErrorParams
      readonly cause?: unknown
      readonly status?: number
    } = {},
  ) {
    super(code, {
      status: options.status ?? ERROR_STATUS[code],
      ...(options.params === undefined ? {} : { params: options.params }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
  }
}

/**
 * Is `error` an {@link ImportExportError} with this code (or any code when omitted)?
 *
 * @example
 * if (isImportExportError(error, 'unsafe_file')) report.securityEvent()
 */
export function isImportExportError(
  error: unknown,
  code?: ImportExportErrorCode,
): error is ImportExportError {
  return error instanceof ImportExportError && (code === undefined || error.code === code)
}
