import type { Actor } from '@strutvane/framework/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { actorAccess, systemAccess } from '../src/access.ts'
import {
  defineImportExport,
  type ImportableOptions,
  importable,
  type RowSchema,
} from '../src/config.ts'
import { isImportExportError } from '../src/errors.ts'
import { type ImportOptions, type ImportResult, runImport } from '../src/import/run.ts'
import { sourceOf } from './helpers/bytes.ts'
import { Company, Contact, openDatabase, type TestDatabase } from './helpers/db.ts'

let db: TestDatabase
beforeAll(async () => {
  db = await openDatabase({ tenancy: false })
})
afterAll(async () => db.close())
beforeEach(async () => {
  for (const contact of await Contact.all()) await contact.forceDelete()
  for (const company of await Company.all()) await company.forceDelete()
})

const contacts = (options: ImportableOptions = {}) =>
  defineImportExport({ models: { contacts: importable(Contact, options) } }).model('contacts')

const run = (csv: string, options: Partial<ImportOptions> = {}): Promise<ImportResult> =>
  runImport({
    model: contacts(),
    source: sourceOf(csv),
    access: systemAccess(),
    mode: 'commit',
    ...options,
  })

const rows = async () =>
  (
    await Contact.query()
      .orderBy('id' as never)
      .get()
  ).map((c) => c.toJSON())

const issuesOf = (result: ImportResult) =>
  result.failures.map((f) => [f.row, ...f.issues.map((i) => `${i.field}:${i.code}`)])

describe('mapping', () => {
  it('maps headings by column name or label, case-insensitively, and ignores what may not be set', async () => {
    const result = await run(
      'Name,E-MAIL,age,Born on,id,tenant_id,api_token,internal_note,created_at,Unknown\n' +
        'Ada,ada@example.com,36,1815-12-10,999,x,secret,note,2020-01-01,?\n',
    )
    expect(result.mapping).toEqual({
      Name: 'name',
      'E-MAIL': 'email',
      age: 'age',
      'Born on': 'born_on',
      id: null,
      tenant_id: null,
      api_token: null,
      internal_note: null,
      created_at: null,
      Unknown: null,
    })
    expect(result.created).toBe(1)
    const [ada] = await rows()
    expect(ada).toMatchObject({
      name: 'Ada',
      email: 'ada@example.com',
      age: 36,
      born_on: '1815-12-10',
    })
    expect(ada?.['id']).not.toBe(999)
    // Never written, and never readable through toJSON either.
    const raw = await Contact.query().first()
    expect(raw && Reflect.get(raw, 'api_token')).toBeNull()
    expect(raw && Reflect.get(raw, 'internal_note')).toBeNull()
  })

  it('applies an explicit (saved) mapping and refuses invalid ones', async () => {
    const result = await run('Full name,Mail,Notes\nAda,ada@example.com,x\n', {
      mapping: { 'Full name': 'name', Mail: 'email', Notes: null },
    })
    expect(result.created).toBe(1)
    const fails = async (mapping: Record<string, string | null>, code: string) =>
      expect(run('a,b\n1,2\n', { mapping })).rejects.toSatisfy((e) =>
        isImportExportError(e, code as never),
      )
    await fails({ missing: 'name' }, 'unknown_source_column')
    await fails({ a: 'nope' }, 'unknown_column')
    await fails({ a: 'created_at' }, 'column_not_importable')
    // A hidden column is "unknown", exactly like a missing one: no confirmation it exists.
    await fails({ a: 'api_token' }, 'unknown_column')
    await fails({ a: 'name', b: 'name' }, 'duplicate_mapping')
  })

  it('refuses duplicate headings and files without data', async () => {
    await expect(run('name,Name\nx,y\n')).rejects.toSatisfy((e) =>
      isImportExportError(e, 'duplicate_header'),
    )
    await expect(run('\n\n , \n')).rejects.toSatisfy((e) => isImportExportError(e, 'empty_file'))
    await expect(run('')).rejects.toSatisfy((e) => isImportExportError(e, 'empty_file'))
  })

  it('imports a hidden column only when the definition allows it and the model makes it fillable', async () => {
    const csv = 'name,email,internal_note\nAda,ada@example.com,secret note\n'
    const allowed = await runImport({
      model: contacts({ allowHidden: ['internal_note'] }),
      source: sourceOf(csv),
      access: systemAccess(),
      mode: 'commit',
    })
    expect(allowed.mapping['internal_note']).toBe('internal_note')
    const raw = await Contact.query().first()
    expect(raw && Reflect.get(raw, 'internal_note')).toBe('secret note')
    // api_token is a secret the model does not make fillable: allowHidden cannot override that.
    expect(() => contacts({ allowHidden: ['api_token'] }).columns()).toThrow(
      expect.objectContaining({ code: 'column_not_importable' }),
    )
  })
})

describe('validation', () => {
  it('coerces every column kind and reports each refusal with its field and code', async () => {
    await Company.forceCreate({ name: 'Acme' })
    const company = await Company.query().first()
    const companyId = company ? String(Reflect.get(company, 'id')) : ''
    const result = await run(
      'name,email,age,balance,score,active,tier,born_on,last_seen_at,meta,external_ref,company_id\n' +
        `Ada,ada@example.com,36,12.50,1.5e3,yes,PRO,2026-02-28,2026-11-18 10:30+01:00,"{""a"":1}",0190A000-0000-7000-8000-0000000000AA,${companyId}\n` +
        'Bob,bob@example.com,old,12.345,abc,maybe,gold,2026-02-30,yesterday,{bad,not-a-uuid,0\n' +
        ',x@example.com,3000000000,123456789.1,,,,,,,,\n',
    )
    expect(result.created).toBe(1)
    expect(issuesOf(result)).toEqual([
      [
        3,
        'age:invalid_integer',
        'balance:invalid_decimal',
        'score:invalid_number',
        'active:invalid_boolean',
        'tier:not_in_list',
        'born_on:invalid_date',
        'last_seen_at:invalid_datetime',
        'meta:invalid_json',
        'external_ref:invalid_uuid',
        'company_id:too_small',
      ],
      [4, 'name:required', 'age:too_big', 'balance:invalid_decimal'],
    ])
    const [ada] = await rows()
    expect(ada).toMatchObject({
      age: 36,
      active: true,
      tier: 'pro',
      born_on: '2026-02-28',
      last_seen_at: '2026-11-18T09:30:00.000Z',
      meta: { a: 1 },
      external_ref: '0190a000-0000-7000-8000-0000000000aa',
    })
    expect(Number(ada?.['balance'])).toBe(12.5)
    expect(ada?.['score']).toBe(1500)
    // Messages come from the catalog, with the column's label.
    const bob = result.failures[0]
    expect(bob?.issues.find((i) => i.code === 'invalid_integer')?.message).toBe(
      'Age must be a whole number.',
    )
    expect(bob?.issues.find((i) => i.code === 'not_in_list')?.message).toBe(
      'Tier must be one of: free, pro.',
    )
  })

  it('treats empty cells as null, the default, or required', async () => {
    const result = await run('name,email,age,balance,tier\nAda,ada@example.com,,,\n')
    expect(result.failed).toBe(0)
    const [ada] = await rows()
    expect(ada).toMatchObject({ age: null, tier: 'free' })
    expect(Number(ada?.['balance'])).toBe(0)
  })

  it('reports columns a new row needs but the file does not have', async () => {
    const result = await run('name\nAda\n')
    expect(issuesOf(result)).toEqual([[2, 'email:required']])
  })

  it('undoes the formula guard of an earlier export, and keeps formulas as plain text', async () => {
    await run(
      `name,email\n'=SUM(A1),a@example.com\n=HYPERLINK("x"),b@example.com\n't Hooft,c@example.com\n`,
    )
    expect((await rows()).map((r) => r['name'])).toEqual([
      '=SUM(A1)',
      '=HYPERLINK("x")',
      "'t Hooft",
    ])
  })

  it('runs the model rules (a Standard Schema) on typed values', async () => {
    const rules: RowSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          const v = value as Record<string, unknown>
          if (typeof v['email'] === 'string' && !v['email'].endsWith('@example.com'))
            return { issues: [{ message: 'Use a company address.', path: ['email'] }] }
          return { value: { ...v, name: String(v['name']).toUpperCase() } }
        },
      },
    }
    const result = await runImport({
      model: contacts({ rules }),
      source: sourceOf('name,email\nAda,ada@example.com\nEve,eve@evil.test\n'),
      access: systemAccess(),
      mode: 'commit',
    })
    expect(issuesOf(result)).toEqual([[3, 'email:invalid']])
    expect(result.failures[0]?.issues[0]?.message).toBe('Use a company address.')
    expect((await rows()).map((r) => r['name'])).toEqual(['ADA'])
    const sneaky: RowSchema = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: { ...(value as object), api_token: 'x' } }),
      },
    }
    const refused = await runImport({
      model: contacts({ rules: sneaky }),
      source: sourceOf('name,email\nAda,ada2@example.com\n'),
      access: systemAccess(),
      mode: 'commit',
    })
    expect(issuesOf(refused)).toEqual([[2, 'api_token:unknown_field']])
  })
})

describe('dry run', () => {
  it('writes nothing and reports exactly what a real import would', async () => {
    await run('name,email\nExisting,taken@example.com\n')
    const csv =
      'name,email,company_id\nAda,ada@example.com,\nDup,taken@example.com,\nTwin,ada@example.com,\nOrphan,o@example.com,424242\nOk,ok@example.com,\n'
    const dry = await run(csv, { mode: 'dry-run' })
    // Dup clashes with a stored row, Twin with Ada from the same file, Orphan names no company.
    expect(dry).toMatchObject({
      dryRun: true,
      processed: 5,
      created: 2,
      failed: 3,
      rolledBack: false,
    })
    expect(issuesOf(dry)).toEqual([
      [3, 'email:unique'],
      [4, 'email:unique'],
      [5, 'company_id:invalid_reference'],
    ])
    expect((await rows()).map((r) => r['email'])).toEqual(['taken@example.com'])
    const real = await run(csv)
    expect(issuesOf(real)).toEqual(issuesOf(dry))
    expect(real.created).toBe(dry.created)
  })
})

describe('commit modes', () => {
  it('skip: commits the valid rows and reports the rest', async () => {
    const result = await run('name,email\nAda,ada@example.com\nBad,\nBob,bob@example.com\n')
    expect(result).toMatchObject({
      processed: 3,
      created: 2,
      failed: 1,
      rolledBack: false,
      lastRow: 4,
    })
    expect(await Contact.query().count()).toBe(2)
  })

  it('rollback: writes nothing when any row fails, everything when none does', async () => {
    const bad = await run('name,email\nAda,ada@example.com\nBad,\n', { onError: 'rollback' })
    expect(bad).toMatchObject({ rolledBack: true, created: 0, failed: 1 })
    expect(await Contact.query().count()).toBe(0)
    const good = await run('name,email\nAda,ada@example.com\nBob,bob@example.com\n', {
      onError: 'rollback',
    })
    expect(good).toMatchObject({ rolledBack: false, created: 2 })
    expect(await Contact.query().count()).toBe(2)
  })

  it('upserts by the match key: updates existing rows, creates new ones, refuses a key twice', async () => {
    await run('name,email,age\nAda,ada@example.com,30\n')
    const result = await run(
      'name,email,age\nAda Lovelace,ada@example.com,36\nBob,bob@example.com,40\nAgain,ada@example.com,1\n',
      { upsertBy: ['email'] },
    )
    expect(result).toMatchObject({ created: 1, updated: 1, failed: 1 })
    expect(issuesOf(result)).toEqual([[4, 'email:duplicate_key']])
    expect((await rows()).map((r) => [r['name'], r['age']])).toEqual([
      ['Ada Lovelace', 36],
      ['Bob', 40],
    ])
    // The model's uniqueBy is the default key; createOnly turns upserts off.
    const viaModel = await runImport({
      model: contacts({ uniqueBy: ['email'] }),
      source: sourceOf('name,email\nAda L.,ada@example.com\n'),
      access: systemAccess(),
      mode: 'commit',
    })
    expect(viaModel.updated).toBe(1)
    const createOnly = await runImport({
      model: contacts({ uniqueBy: ['email'] }),
      source: sourceOf('name,email\nAda L.,ada@example.com\n'),
      access: systemAccess(),
      mode: 'commit',
      createOnly: true,
    })
    expect(issuesOf(createOnly)).toEqual([[2, 'email:unique']])
  })

  it('upserts by primary key (lookup only: the id is never written)', async () => {
    await run('name,email\nAda,ada@example.com\n')
    const [ada] = await rows()
    const result = await run(
      `id,name,email\n${ada?.['id']},Ada L.,ada@example.com\n999999,Ghost,ghost@example.com\n`,
      {
        upsertBy: ['id'],
      },
    )
    expect(result.updated).toBe(1)
    expect(issuesOf(result)).toEqual([[3, 'id:not_found']])
  })

  it('refuses a match key that is not importable', async () => {
    await expect(run('name\nx\n', { upsertBy: ['api_token'] })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'invalid_upsert_key'),
    )
  })

  it('commits chunk by chunk: a failing chunk is rolled back alone, and the import resumes after the last good one', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `P${i},p${i}@example.com`).join('\n')
    const csv = `name,email\n${lines}\n`
    const progress: number[] = []
    await expect(
      run(csv, {
        chunkSize: 3,
        onChunk: async (p) => {
          if (p.lastRow === 7) throw new Error('job store down')
          progress.push(p.lastRow)
        },
      }),
    ).rejects.toThrow('job store down')
    expect(progress).toEqual([4])
    expect(await Contact.query().count()).toBe(3)
    const resumed = await run(csv, {
      chunkSize: 3,
      resumeAfterRow: 4,
      resumeCounts: { processed: 3, created: 3, updated: 0, failed: 0 },
    })
    expect(resumed).toMatchObject({ processed: 10, created: 10, lastRow: 11 })
    expect(await Contact.query().count()).toBe(10)
  })

  it('aborts (and rolls back the open chunk) when the failure is not about a row', async () => {
    const csv = 'name,email\nAda,ada@example.com\nBob,bob@example.com\n'
    let calls = 0
    const broken = {
      ...db.connection,
      grammar: db.connection.grammar,
      transaction: <T>(fn: () => Promise<T>) =>
        db.connection.transaction(async () => {
          calls++
          if (calls === 3) throw new Error('connection reset')
          return fn()
        }),
    } as typeof db.connection
    await expect(run(csv, { connection: broken })).rejects.toThrow('connection reset')
    expect(await Contact.query().count()).toBe(0)
  })

  it('caps the report but counts every failure', async () => {
    const lines = Array.from({ length: 30 }, () => 'x,').join('\n')
    const result = await run(`name,email\n${lines}\n`, { maxReportedErrors: 5 })
    expect(result.failed).toBe(30)
    expect(result.failures).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })
})

describe('access', () => {
  const actor: Actor = { id: 'u1', type: 'user', roles: [], attrs: {} }

  it('refuses an actor who may not import', async () => {
    await expect(
      run('name,email\nAda,a@example.com\n', {
        access: actorAccess(actor, { import: false, update: false, export: true }),
      }),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'import_export_forbidden'))
  })

  it('checks every written row against the create filter, inside the savepoint', async () => {
    const access = actorAccess(
      actor,
      { import: true, update: true, export: true },
      { create: { field: 'tier', op: 'eq', value: 'free' } },
    )
    const result = await run('name,email,tier\nFree,f@example.com,free\nPro,p@example.com,pro\n', {
      access,
    })
    expect(issuesOf(result)).toEqual([[3, ':forbidden']])
    expect((await rows()).map((r) => r['tier'])).toEqual(['free'])
  })

  it('limits upsert lookups to rows the actor may update, and refuses updates without the right', async () => {
    await run('name,email,tier\nMine,mine@example.com,free\nTheirs,theirs@example.com,pro\n')
    const access = actorAccess(
      actor,
      { import: true, update: true, export: true },
      {
        update: { field: 'tier', op: 'eq', value: 'free' },
        create: { field: 'tier', op: 'eq', value: 'free' },
      },
    )
    const result = await run(
      'name,email,tier\nMine 2,mine@example.com,free\nTheirs 2,theirs@example.com,free\n',
      {
        access,
        upsertBy: ['email'],
      },
    )
    // The pro row is invisible to this actor: it is treated as new, and the unique index refuses it.
    expect(result.updated).toBe(1)
    expect(issuesOf(result)).toEqual([[3, 'email:unique']])
    expect((await rows()).map((r) => r['name'])).toEqual(['Mine 2', 'Theirs'])
    const noUpdate = actorAccess(actor, { import: true, update: false, export: true })
    const created = await run('name,email\nMine 3,mine@example.com\n', {
      access: noUpdate,
      upsertBy: ['email'],
    })
    expect(issuesOf(created)).toEqual([[2, 'email:unique']])
  })
})
