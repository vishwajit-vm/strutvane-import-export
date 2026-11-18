/**
 * `config/import-export.ts`: which models may be imported and exported, and how.
 *
 * Deny by default: a model that is not listed here cannot be imported or exported, whatever a
 * request or a command line names. Listing it is the decision to allow it, made once, in code
 * review, next to the rules that go with it (which hidden columns are allowed, the match key, the
 * extra validation, the default export columns).
 *
 * ```ts
 * // config/import-export.ts
 * import { defineImportExport, importable } from '@strutvane/import-export'
 * import { Contact } from '../app/models/contact.ts'
 *
 * export default defineImportExport({
 *   disk: 'local',
 *   models: {
 *     contacts: importable(Contact, { uniqueBy: ['email'] }),
 *   },
 * })
 * ```
 *
 * @module
 */
import type { StandardSchemaV1 } from '@strutvane/framework/contracts'
import { ImportExportError } from './errors.ts'
import { type ImportLimits, resolveLimits } from './limits.ts'
import { describeColumns, type ModelColumns, type ModelLike } from './model/columns.ts'

/** An extra validator for imported rows: any Standard Schema (Zod 4, Valibot, ArkType…). */
export type RowSchema = StandardSchemaV1<Record<string, unknown>, Record<string, unknown>>

/** Per-model options. */
export interface ImportableOptions {
  /**
   * Hidden or secret columns an import may set anyway. Each must also be `fillable` on the model
   * (and, for a secret, in its `allowSensitive`). Exports never include them.
   */
  readonly allowHidden?: readonly string[]
  /** The default match key for upserts: existing rows with these values are updated. */
  readonly uniqueBy?: readonly string[]
  /** Extra row validation after the column checks (runs on typed values). */
  readonly rules?: RowSchema
  /** The columns an export writes by default (all exportable columns when omitted). */
  readonly exportColumns?: readonly string[]
  /** The permission prefix (`contact` → `contact.create`); defaults to the registry key. */
  readonly resourceType?: string
  /** Limits for this model's files (merged over the global ones). */
  readonly limits?: Partial<ImportLimits>
}

/** One registered model. */
export interface ImportableModel {
  readonly model: ModelLike
  readonly options: ImportableOptions
}

/**
 * Register a model with its options.
 *
 * @example
 * importable(Contact, { uniqueBy: ['email'], exportColumns: ['name', 'email'] })
 */
export function importable(model: ModelLike, options: ImportableOptions = {}): ImportableModel {
  return Object.freeze({ model, options: Object.freeze({ ...options }) })
}

/** The whole configuration. */
export interface ImportExportConfig {
  /** The storage disk for uploads and finished exports (default: the app's default disk). */
  readonly disk?: string
  /** Folder for uploaded import files on that disk (default `imports`). */
  readonly importDirectory?: string
  /** Folder for finished exports on that disk (default `exports`). */
  readonly exportDirectory?: string
  /** Rows per transaction when committing an import (default 500, at most 5,000). */
  readonly chunkSize?: number
  /** Row errors kept in a report (default 1,000; every error is still counted). */
  readonly maxReportedErrors?: number
  /** Limits for every import (per-model `limits` win). */
  readonly limits?: Partial<ImportLimits>
  /** The models that may be imported or exported, by key (`contacts`). */
  readonly models: Readonly<Record<string, ImportableModel>>
}

/** A model entry with everything resolved. */
export interface ResolvedModel {
  readonly key: string
  readonly model: ModelLike
  readonly options: ImportableOptions
  readonly resourceType: string
  readonly limits: ImportLimits
  /** The classified columns (read from the schema on first use, then cached). */
  columns(): ModelColumns
}

/** The resolved configuration. */
export interface ResolvedConfig {
  readonly disk: string | undefined
  readonly importDirectory: string
  readonly exportDirectory: string
  readonly chunkSize: number
  readonly maxReportedErrors: number
  readonly limits: ImportLimits
  /** The registered model, or `model_not_registered`. */
  model(key: string): ResolvedModel
  /** Every registered key. */
  keys(): readonly string[]
}

const KEY = /^[a-z][a-z0-9_-]{0,63}$/
const FOLDER = /^[a-z0-9][a-z0-9/_-]{0,127}$/

function option(name: string, reason: string): ImportExportError {
  return new ImportExportError('invalid_option', { params: { option: name, reason } })
}

function wholeNumber(
  name: string,
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  const n = value ?? fallback
  if (!Number.isSafeInteger(n) || n < 1 || n > max)
    throw option(name, `a whole number from 1 to ${max}`)
  return n
}

/**
 * Validate and freeze the configuration. Model columns are read lazily (the schema is registered
 * when the app boots, after config files load).
 *
 * @example
 * export default defineImportExport({ models: { contacts: importable(Contact) } })
 */
export function defineImportExport(config: ImportExportConfig): ResolvedConfig {
  const importDirectory = config.importDirectory ?? 'imports'
  const exportDirectory = config.exportDirectory ?? 'exports'
  for (const [name, folder] of [
    ['importDirectory', importDirectory],
    ['exportDirectory', exportDirectory],
  ] as const) {
    if (!FOLDER.test(folder) || folder.includes('..') || folder.includes('//'))
      throw option(name, 'lowercase letters, digits, "-", "_" and "/" only')
  }
  const limits = resolveLimits(config.limits)
  const models = new Map<string, ResolvedModel>()
  for (const [key, entry] of Object.entries(config.models)) {
    if (!KEY.test(key)) throw option(`models.${key}`, 'keys are lowercase, like "contacts"')
    let columns: ModelColumns | undefined
    const resourceType = entry.options.resourceType ?? key
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(resourceType))
      throw option(`models.${key}.resourceType`, 'letters, digits, "-" and "_" only')
    models.set(key, {
      key,
      model: entry.model,
      options: entry.options,
      resourceType,
      limits: resolveLimits({ ...limits, ...entry.options.limits }),
      columns() {
        columns ??= describeColumns(entry.model, {
          ...(entry.options.allowHidden === undefined
            ? {}
            : { allowHidden: entry.options.allowHidden }),
        })
        return columns
      },
    })
  }
  return Object.freeze({
    disk: config.disk,
    importDirectory,
    exportDirectory,
    chunkSize: wholeNumber('chunkSize', config.chunkSize, 500, 5_000),
    maxReportedErrors: wholeNumber('maxReportedErrors', config.maxReportedErrors, 1_000, 100_000),
    limits,
    model(key: string): ResolvedModel {
      const found = Object.hasOwn(config.models, key) ? models.get(key) : undefined
      if (found === undefined)
        throw new ImportExportError('model_not_registered', { params: { model: key.slice(0, 64) } })
      return found
    },
    keys: () => [...models.keys()],
  })
}
