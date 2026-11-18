/**
 * What may be imported into, and exported from, a model: decided from the **schema and the
 * model's own mass-assignment rules**, never from the file.
 *
 * - **Importable** = the model's `fillable` columns, minus Strutvane's own columns (`id`,
 *   timestamps, soft deletes, the tenant column) and minus every hidden or secret column (the
 *   model's `hidden`, `.hidden()`/`.secret()` in the migration, and secret-looking names such as
 *   `password` or `api_token`). A hidden column becomes importable only when the import
 *   definition lists it in `allowHidden` **and** the model makes it fillable (for a secret, the
 *   model must also list it in `allowSensitive`): two explicit decisions, in two files.
 * - **Exportable** = every column except hidden and secret ones and the tenant column. There is no
 *   override: a hidden column never leaves the server through an export.
 *
 * The ORM enforces the same rules again when a row is saved (`fill()` refuses anything not
 * fillable), so a bug here fails closed.
 *
 * @module
 */
import { humanize } from '@strutvane/framework/core'
import { ModelBase } from '@strutvane/framework/database'
import { ImportExportError } from '../errors.ts'

/**
 * What a model class looks like from here: any class made with `Model('table', …)`. The precise
 * ORM type is checked at runtime by {@link runtimeModel}, so app models of every table fit.
 *
 * @example
 * const model: ModelLike = Contact
 */
export interface ModelLike {
  readonly name: string
  readonly table: string
  new (): object
}

/** A column as the schema snapshot describes it (the fields this package reads). */
export interface SchemaColumn {
  readonly name: string
  readonly kind: string
  readonly nullable: boolean
  readonly default?: string | number | boolean | null
  readonly length?: number
  readonly precision?: number
  readonly scale?: number
  readonly values?: readonly string[]
  readonly tenant?: true
  readonly hidden?: true
  readonly secret?: true
  readonly references?: { readonly table: string; readonly column: string }
}

/** One column, as imports and exports use it. */
export interface ColumnDescriptor extends SchemaColumn {
  /** Human label for headings and messages (`email_address` → `Email address`). */
  readonly label: string
  /** The database supplies a value when the import gives none (a default, or nullable). */
  readonly optional: boolean
}

/** The columns of one model, classified. */
export interface ModelColumns {
  readonly table: string
  readonly model: string
  /** Every column, in table order. */
  readonly all: ReadonlyMap<string, ColumnDescriptor>
  /** Columns an import may set. */
  readonly importable: ReadonlyMap<string, ColumnDescriptor>
  /** Columns an export may write. */
  readonly exportable: ReadonlyMap<string, ColumnDescriptor>
  readonly primaryKey: string
}

/** The runtime static side of a model, as this package uses it. */
export interface RuntimeModel {
  readonly name: string
  readonly table: string
  info(): {
    readonly name: string
    readonly columns: ReadonlyMap<string, SchemaColumn>
    readonly primaryKey: SchemaColumn
  }
  settings(): {
    readonly fillable: ReadonlySet<string> | undefined
    readonly hidden: ReadonlySet<string>
  }
}

/** Columns the ORM fills itself. */
const SYSTEM_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
])

/**
 * Check that `model` really is an ORM model class and return its runtime side. A plain object or
 * an unrelated class is refused here, with a hint, instead of failing deep inside a query.
 *
 * @example
 * runtimeModel(Contact).info().columns.has('email') // true
 */
export function runtimeModel(model: ModelLike): RuntimeModel & typeof ModelBase {
  if (typeof model !== 'function' || !(model.prototype instanceof ModelBase))
    throw new ImportExportError('invalid_option', {
      params: {
        option: 'model',
        reason:
          'pass a model class made with Model(table, options) from @strutvane/framework/database',
      },
    })
  // The one bridge from the structural type to the ORM's runtime class, checked just above.
  return model as unknown as RuntimeModel & typeof ModelBase
}

/** Is this the tenant column (declared with `t.tenant()`, or the conventional `tenant_id`)? */
function isTenantColumn(column: SchemaColumn): boolean {
  return column.tenant === true || column.name === 'tenant_id'
}

/**
 * Classify a model's columns.
 *
 * @example
 * describeColumns(Contact, { allowHidden: [] }).importable.has('email') // true
 */
export function describeColumns(
  model: ModelLike,
  options: { readonly allowHidden?: readonly string[] } = {},
): ModelColumns {
  const runtime = runtimeModel(model)
  const info = runtime.info()
  const settings = runtime.settings()
  const fillable = settings.fillable ?? new Set<string>()
  const hidden = settings.hidden
  const allowHidden = new Set(options.allowHidden ?? [])
  for (const name of allowHidden) {
    if (!info.columns.has(name))
      throw new ImportExportError('unknown_column', { params: { column: name } })
    if (!fillable.has(name) || SYSTEM_COLUMNS.has(name))
      throw new ImportExportError('column_not_importable', { params: { column: name } })
  }
  const all = new Map<string, ColumnDescriptor>()
  const importable = new Map<string, ColumnDescriptor>()
  const exportable = new Map<string, ColumnDescriptor>()
  for (const column of info.columns.values()) {
    const descriptor: ColumnDescriptor = {
      ...column,
      label: humanize(column.name),
      optional: column.nullable || column.default !== undefined || column.kind === 'slug',
    }
    all.set(column.name, descriptor)
    const tenant = isTenantColumn(column)
    const secret = hidden.has(column.name)
    if (!tenant && !secret) exportable.set(column.name, descriptor)
    if (
      fillable.has(column.name) &&
      !SYSTEM_COLUMNS.has(column.name) &&
      !tenant &&
      (!secret || allowHidden.has(column.name))
    )
      importable.set(column.name, descriptor)
  }
  return {
    table: info.name,
    model: runtime.name,
    all,
    importable,
    exportable,
    primaryKey: info.primaryKey.name,
  }
}
