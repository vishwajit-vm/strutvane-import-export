/**
 * Who is importing or exporting, and which rows they may touch.
 *
 * Every import and export takes an {@link Access}, and there is no default: forgetting it is a
 * type error, not "allow everything". Two kinds exist:
 *
 * - **`systemAccess()`**: trusted server code and the operator's own CLI (`node strut import`),
 *   exactly like a seeder. No row filter; the tenant still applies.
 * - **`actorAccess(...)`** / **`accessFromPermissions(...)`**: a signed-in user (an HTTP upload, a
 *   UI screen). The decision mirrors the framework's CRUD routes: the action is allowed when the
 *   PermissionProvider's `can()` says yes or its row filter is not `false`, and the row filters
 *   then narrow every read (exports, upsert lookups) and are re-checked after every write (a
 *   created row must match the `create` filter, an updated row the `update` filter, inside the
 *   same transaction). Rows outside the filter are "not found", never "forbidden" (no enumeration).
 *
 * @module
 */
import type { Actor, PermissionProvider, QueryFilter } from '@strutvane/framework/contracts'
import { ImportExportError } from './errors.ts'

/** Row filters per action (portable `QueryFilter`s, compiled by the ORM's `wherePolicy`). */
export interface AccessFilters {
  readonly view?: QueryFilter
  readonly create?: QueryFilter
  readonly update?: QueryFilter
}

/** The caller of an import or export. */
export type Access =
  | { readonly kind: 'system'; readonly actorId?: string }
  | {
      readonly kind: 'actor'
      readonly actor: Actor
      /** What the caller may do at all. */
      readonly can: { readonly import: boolean; readonly update: boolean; readonly export: boolean }
      readonly filters: AccessFilters
    }

/**
 * Trusted code: the CLI, a scheduled job, a seeder.
 *
 * @example
 * await runImport({ …, access: systemAccess() })
 */
export function systemAccess(actorId?: string): Access {
  return actorId === undefined ? { kind: 'system' } : { kind: 'system', actorId }
}

/**
 * A signed-in user with explicit rights and filters (when the app decides them itself).
 *
 * @example
 * actorAccess(actor, { import: true, update: false, export: true }, { view: ownRows })
 */
export function actorAccess(
  actor: Actor,
  can: { readonly import: boolean; readonly update: boolean; readonly export: boolean },
  filters: AccessFilters = {},
): Access {
  return { kind: 'actor', actor, can, filters }
}

const FALSE: QueryFilter = { op: 'false' }

/**
 * Build an actor's access from the app's PermissionProvider (`@strutvane/auth`), for the
 * permissions `<resourceType>.view`, `.create` and `.update`.
 *
 * @example
 * const access = await accessFromPermissions(permissions, actor, 'contact')
 */
export async function accessFromPermissions(
  permissions: PermissionProvider,
  actor: Actor | null,
  resourceType: string,
): Promise<Access> {
  if (actor === null) throw new ImportExportError('import_export_forbidden', { status: 401 })
  const decide = async (
    action: 'view' | 'create' | 'update',
  ): Promise<{ allowed: boolean; filter: QueryFilter }> => {
    const permission = `${resourceType}.${action}` as const
    const decision = await permissions.can(actor, permission, { type: resourceType })
    const filter = await permissions.filterFor(actor, permission, resourceType)
    // Same rule as the CRUD routes: allowed when can() says yes or the filter leaves some rows.
    return {
      allowed: decision.allowed || filter.op !== 'false',
      filter: decision.allowed || filter.op !== 'false' ? filter : FALSE,
    }
  }
  const [view, create, update] = await Promise.all([
    decide('view'),
    decide('create'),
    decide('update'),
  ])
  return {
    kind: 'actor',
    actor,
    can: { import: create.allowed || update.allowed, update: update.allowed, export: view.allowed },
    filters: { view: view.filter, create: create.filter, update: update.filter },
  }
}

/** The actor id recorded on jobs (`undefined` for anonymous system work). */
export function accessActorId(access: Access): string | undefined {
  return access.kind === 'actor' ? access.actor.id : access.actorId
}

/** The actor, for `wherePolicy`, or `null` for system access. */
export function accessActor(access: Access): Actor | null {
  return access.kind === 'actor' ? access.actor : null
}

/** Throw unless the caller may do `action` at all. */
export function assertAllowed(access: Access, action: 'import' | 'export'): void {
  if (access.kind === 'system') return
  if (!access.can[action]) throw new ImportExportError('import_export_forbidden')
}
