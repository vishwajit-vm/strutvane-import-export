/**
 * The message catalog and error definitions of `@strutvane/import-export` (RFC-0003): every code
 * this package raises or reports has an English title or message here, so the framework's problem
 * renderer and `renderIssues` never fall back to a bare code. Apps translate them with their own
 * catalogs (`lang/<locale>/*.ts`), which win over package catalogs.
 *
 * @module
 */
import {
  createMessages,
  defineMessages,
  type ErrorDefinition,
  type ErrorRegistry,
  type MessageCatalog,
  type Messages,
} from '@strutvane/framework/core'
import { ERROR_STATUS, type ImportExportErrorCode } from './errors.ts'

const TITLES: Readonly<Record<ImportExportErrorCode, string>> = {
  file_too_large: 'File too large',
  too_many_rows: 'Too many rows',
  too_many_columns: 'Too many columns',
  cell_too_long: 'Cell too long',
  invalid_encoding: 'Unreadable text',
  unsupported_format: 'Unsupported file type',
  malformed_file: 'Broken file',
  unsafe_file: 'Unsafe file',
  empty_file: 'Empty file',
  duplicate_header: 'Duplicate column heading',
  unknown_source_column: 'Unknown file column',
  unknown_column: 'Unknown column',
  duplicate_mapping: 'Column mapped twice',
  column_not_importable: 'Column cannot be imported',
  column_not_exportable: 'Column cannot be exported',
  invalid_upsert_key: 'Invalid match column',
  model_not_registered: 'Not available for import or export',
  invalid_option: 'Invalid option',
  job_not_found: 'Import or export not found',
  job_not_resumable: 'Cannot be resumed',
  file_changed: 'File changed',
  import_export_forbidden: 'Not allowed',
}

const DETAILS: Readonly<Record<ImportExportErrorCode, string>> = {
  file_too_large: 'The file is larger than {max} bytes. Split it into smaller files.',
  too_many_rows: 'The file has more than {max} rows. Split it into smaller files.',
  too_many_columns: 'A row has more than {max} columns.',
  cell_too_long: 'A cell in row {row} is longer than {max} characters.',
  invalid_encoding: 'The file is not valid UTF-8 text. Save it as "CSV UTF-8" and try again.',
  unsupported_format: 'Upload a CSV (.csv) or Excel workbook (.xlsx) file.',
  malformed_file: 'The file is damaged or incomplete ({reason}).',
  unsafe_file:
    'The file was refused because it could harm the server ({reason}). Re-save it from a spreadsheet application and try again.',
  empty_file: 'The file has no heading row or no data.',
  duplicate_header: 'The heading "{column}" appears more than once.',
  unknown_source_column: 'The file has no column named "{column}".',
  unknown_column: '"{column}" is not a column of this table.',
  duplicate_mapping: 'Two file columns are mapped to "{column}".',
  column_not_importable: '"{column}" cannot be set by an import.',
  column_not_exportable: '"{column}" cannot be exported.',
  invalid_upsert_key: 'Records can only be matched on importable columns ("{column}" is not one).',
  model_not_registered: '"{model}" is not registered in config/import-export.ts.',
  invalid_option: 'The option "{option}" is invalid: {reason}.',
  job_not_found: 'No import or export with this id exists.',
  job_not_resumable: 'This import cannot be resumed ({reason}).',
  file_changed: 'The uploaded file changed after the import started, so it cannot be resumed.',
  import_export_forbidden: 'You may not do this.',
}

/**
 * Error definitions for the framework's error registry (status and English title per code).
 *
 * @example
 * IMPORT_EXPORT_ERRORS.find((d) => d.code === 'unsafe_file')?.status // 422
 */
export const IMPORT_EXPORT_ERRORS: readonly ErrorDefinition[] = Object.freeze(
  (Object.keys(TITLES) as ImportExportErrorCode[]).map((code) =>
    Object.freeze({
      code,
      status: ERROR_STATUS[code],
      title: TITLES[code],
      owner: '@strutvane/import-export',
    }),
  ),
)

/**
 * English messages: `errors.<code>.title` / `.detail` for the errors above, and
 * `validation.<code>` for the row issues an import reports in addition to the framework's built-in
 * ones (`required`, `too_long`, `not_in_list`, `unique`, `not_found`, …).
 *
 * @example
 * IMPORT_EXPORT_MESSAGES_EN.messages['validation.invalid_integer'] // '{attribute} must be a whole number.'
 */
export const IMPORT_EXPORT_MESSAGES_EN: MessageCatalog = defineMessages('en', {
  ...Object.fromEntries(
    (Object.keys(TITLES) as ImportExportErrorCode[]).flatMap((code) => [
      [`errors.${code}.title`, TITLES[code]],
      [`errors.${code}.detail`, DETAILS[code]],
    ]),
  ),
  'validation.invalid_integer': '{attribute} must be a whole number.',
  'validation.invalid_number': '{attribute} must be a number.',
  'validation.invalid_decimal':
    '{attribute} must be a number with at most {precision} digits, {scale} after the decimal point.',
  'validation.invalid_boolean': '{attribute} must be yes/no, true/false or 1/0.',
  'validation.invalid_datetime': '{attribute} must be a date and time such as 2026-11-18 10:00.',
  'validation.invalid_json': '{attribute} must be valid JSON.',
  'validation.invalid_reference': '{attribute} must be the id of an existing record.',
  'validation.duplicate_key': 'Another row in this file has the same {attribute}.',
  'validation.forbidden': 'You may not create or change this record.',
  'validation.write_failed': 'This row could not be saved.',
  'validation.unknown_field': '{attribute} is not a column you can import.',
})

/**
 * Register this package's error codes with an error registry (idempotent; codes already present
 * are left alone, so an app may override a title).
 *
 * @example
 * registerImportExportErrors(app.make(ErrorRegistryToken))
 */
export function registerImportExportErrors(registry: ErrorRegistry): void {
  for (const definition of IMPORT_EXPORT_ERRORS)
    if (registry.get(definition.code) === undefined) registry.register(definition)
}

/**
 * A `Messages` instance with the built-in catalog and this package's: what row reports render
 * with when the caller passes none.
 *
 * @example
 * defaultMessages().format('validation.invalid_integer', { attribute: 'Age' })
 */
export function defaultMessages(): Messages {
  return createMessages({ package: [IMPORT_EXPORT_MESSAGES_EN] })
}
