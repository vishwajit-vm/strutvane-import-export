import { createMemoryDisk, createStorageManager } from '@strutvane/framework'
import type { Actor } from '@strutvane/framework/contracts'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { actorAccess, systemAccess } from '../src/access.ts'
import { defineImportExport, importable, type RowSchema } from '../src/config.ts'
import { isImportExportError } from '../src/errors.ts'
import { jobs } from '../src/jobs.ts'
import { DEFAULT_LIMITS } from '../src/limits.ts'
import { createImportExport } from '../src/service.ts'
import { fromWebStream } from '../src/source.ts'
import { readXlsx } from '../src/xlsx/read.ts'
import { all, collect } from './helpers/bytes.ts'
import { Contact, openDatabase, type TestDatabase } from './helpers/db.ts'
import { buildZip } from './helpers/xlsx.ts'

let db: TestDatabase
beforeAll(async () => {
  db = await openDatabase({ tenancy: false })
})
afterAll(async () => db.close())
beforeEach(async () => {
  for (const contact of await Contact.query().get()) await contact.forceDelete()
})

/** A rule that throws a non-row error when asked to (to simulate a crash mid-import). */
let explodeOn: string | undefined
const rules: RowSchema = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      if ((value as Record<string, unknown>)['name'] === explodeOn)
        throw new Error('worker crashed')
      return { value: value as Record<string, unknown> }
    },
  },
}

function setup(limits = {}) {
  const disk = createMemoryDisk({ name: 'local' })
  const storage = createStorageManager({ default: 'local', disks: [disk] })
  const config = defineImportExport({
    chunkSize: 2,
    limits,
    models: { contacts: importable(Contact, { uniqueBy: ['email'], rules }) },
  })
  return { disk, service: createImportExport({ config, storage }) }
}

const system = { access: systemAccess('cli') }
const text = (s: string) => new TextEncoder().encode(s)

describe('uploads', () => {
  it('stores the file under a generated key, records its checksum and detects the format', async () => {
    const { disk, service } = setup()
    const job = await service.upload(
      'contacts',
      { name: '../../etc/evil.csv', body: text('name,email\nAda,a@x.io\n') },
      system,
    )
    expect(job).toMatchObject({
      status: 'pending',
      format: 'csv',
      fileName: 'evil.csv',
      fileSize: 22,
      actorId: 'cli',
    })
    expect(job.fileKey).toMatch(/^imports\/[0-9a-f-]{36}\.upload$/)
    expect(job.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await disk.exists(job.fileKey)).toBe(true)
  })

  it('refuses (and deletes) oversized, binary and unknown files', async () => {
    const { disk, service } = setup({ maxFileBytes: 64 })
    await expect(
      service.upload('contacts', { body: text('x'.repeat(100)) }, system),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'file_too_large'))
    await expect(
      service.upload('contacts', { body: text('%PDF-1.7 ...') }, system),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'unsupported_format'))
    await expect(
      service.upload(
        'contacts',
        { body: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
        system,
      ),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'unsupported_format'))
    await expect(service.upload('nope', { body: text('a') }, system)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'model_not_registered'),
    )
    expect((await disk.list('imports')).items).toEqual([])
  })

  it('inspects headings, suggests a mapping and shows a sample', async () => {
    const { service } = setup()
    const job = await service.upload(
      'contacts',
      { body: text('Name,E-mail,Password\nAda,a@x.io,pw\nBob,b@x.io,pw\n') },
      system,
    )
    const inspection = await service.inspect(job.id, system)
    expect(inspection.headings).toEqual(['Name', 'E-mail', 'Password'])
    expect(inspection.suggested).toEqual({ Name: 'name', 'E-mail': 'email', Password: null })
    expect(inspection.sample).toEqual([
      ['Ada', 'a@x.io', 'pw'],
      ['Bob', 'b@x.io', 'pw'],
    ])
    expect(inspection.columns.find((c) => c.name === 'email')).toEqual({
      name: 'email',
      label: 'Email',
      required: true,
    })
  })
})

describe('import jobs', () => {
  it('dry-runs, then commits with progress and failed rows recorded per chunk', async () => {
    const { service } = setup()
    const csv = 'name,email\nA,a@x.io\nB,\nC,c@x.io\nD,d@x.io\nE,\n'
    const job = await service.upload('contacts', { body: text(csv) }, system)
    const dry = await service.dryRun(job.id, system)
    expect(dry).toMatchObject({ dryRun: true, created: 3, failed: 2 })
    expect(await Contact.query().count()).toBe(0)
    const result = await service.start(job.id, system)
    expect(result).toMatchObject({ created: 3, failed: 2 })
    const stored = await service.job(job.id, system)
    expect(stored).toMatchObject({
      status: 'completed',
      processed: 5,
      created: 3,
      failed: 2,
      nextRow: 6,
    })
    const failures = await service.failures(job.id, system)
    expect(failures.map((f) => [f.row, f.issues.map((i) => i.code)])).toEqual([
      [3, ['required']],
      [6, ['required']],
    ])
    // Reports never hold cell values.
    expect(JSON.stringify(failures)).not.toContain('x.io')
    await expect(service.resume(job.id, system)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'job_not_resumable'),
    )
  })

  it('resumes after the last committed chunk when a run crashes, without importing a row twice', async () => {
    const { service } = setup()
    const csv = 'name,email\nA,a@x.io\nB,b@x.io\nC,c@x.io\nD,d@x.io\nE,e@x.io\n'
    const job = await service.upload('contacts', { body: text(csv) }, system)
    explodeOn = 'D'
    await expect(service.start(job.id, { ...system, createOnly: true })).rejects.toThrow(
      'worker crashed',
    )
    explodeOn = undefined
    expect(await service.job(job.id, system)).toMatchObject({
      status: 'failed',
      nextRow: 3,
      created: 2,
      errorCode: 'internal_error',
    })
    expect(await Contact.query().count()).toBe(2)
    const resumed = await service.resume(job.id, system)
    expect(resumed).toMatchObject({ created: 5, failed: 0 })
    expect(await Contact.query().count()).toBe(5)
    // The stored option (createOnly) carried over: no upserts happened on resume.
    expect((await service.job(job.id, system)).options).toMatchObject({ createOnly: true })
  })

  it('refuses to resume when the stored file changed', async () => {
    const { disk, service } = setup()
    const job = await service.upload('contacts', { body: text('name,email\nA,a@x.io\n') }, system)
    await disk.put(job.fileKey, text('name,email\nZ,z@x.io\n'))
    await expect(service.start(job.id, system)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'file_changed'),
    )
    expect(await Contact.query().count()).toBe(0)
  })

  it('stops a stale run at its next chunk once another run claims the job', async () => {
    const { service } = setup()
    const job = await service.upload('contacts', { body: text('name,email\nA,a@x.io\n') }, system)
    const first = await jobs.claimImport(job.id, systemAccess())
    await jobs.claimImport(job.id, systemAccess())
    await expect(jobs.assertClaim(job.id, first.token)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'job_not_resumable'),
    )
  })

  it('uses saved mappings, validated when saved', async () => {
    const { service } = setup()
    await service.saveMapping(
      'contacts',
      'crm export',
      { 'Full name': 'name', Mail: 'email' },
      system,
    )
    await expect(
      service.saveMapping('contacts', 'bad', { x: 'api_token' }, system),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'unknown_column'))
    await expect(
      service.saveMapping('contacts', '<script>', { x: 'name' }, system),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'invalid_option'))
    expect((await service.mappings('contacts', system)).map((m) => m.name)).toEqual(['crm export'])
    const job = await service.upload(
      'contacts',
      { body: text('Full name,Mail\nAda,a@x.io\n') },
      system,
    )
    const result = await service.start(job.id, { ...system, mappingName: 'crm export' })
    expect(result.created).toBe(1)
    await expect(service.dryRun(job.id, { ...system, mappingName: 'missing' })).rejects.toSatisfy(
      (e) => isImportExportError(e, 'invalid_option'),
    )
  })

  it('shows an actor only their own jobs', async () => {
    const { service } = setup()
    const alice: Actor = { id: 'alice', type: 'user', roles: [], attrs: {} }
    const bob: Actor = { id: 'bob', type: 'user', roles: [], attrs: {} }
    const can = { import: true, update: true, export: true }
    const job = await service.upload(
      'contacts',
      { body: text('name,email\nA,a@x.io\n') },
      { access: actorAccess(alice, can) },
    )
    expect((await service.job(job.id, { access: actorAccess(alice, can) })).id).toBe(job.id)
    await expect(service.job(job.id, { access: actorAccess(bob, can) })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'job_not_found'),
    )
    await expect(service.job('not-a-uuid', system)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'job_not_found'),
    )
  })

  it('refuses a zip bomb disguised as a workbook at import time', async () => {
    const { service } = setup()
    const bomb = buildZip([
      {
        name: 'xl/workbook.xml',
        data: Buffer.from('<workbook><sheets><sheet r:id="rId1"/></sheets></workbook>'),
      },
      { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(30 * 1024 * 1024) },
    ])
    const job = await service.upload('contacts', { body: bomb }, system)
    expect(job.format).toBe('xlsx')
    await expect(service.dryRun(job.id, system)).rejects.toSatisfy((e) =>
      isImportExportError(e, 'unsafe_file'),
    )
  })
})

describe('exports', () => {
  it('exports to the disk, downloads, and the file imports back unchanged (CSV and XLSX)', async () => {
    const { service } = setup()
    const job = await service.upload(
      'contacts',
      {
        body: text(
          'name,email,age,active,born_on,meta\n=1+1,a@x.io,36,yes,1990-05-01,"{""k"":[1,2]}"\nBob,b@x.io,,no,,\n',
        ),
      },
      system,
    )
    await service.start(job.id, system)
    for (const format of ['csv', 'xlsx'] as const) {
      const exported = await service.export({
        ...system,
        model: 'contacts',
        format,
        columns: ['name', 'email', 'age', 'active', 'born_on', 'meta'],
      })
      expect(exported).toMatchObject({
        status: 'completed',
        rowCount: 2,
        fileName: expect.stringMatching(new RegExp(`^contacts-.*\\.${format}$`)),
      })
      const download = await service.download(exported.id, system)
      const bytes = await collect(fromWebStream(download.body))
      if (format === 'csv') {
        const csv = bytes.toString('utf8')
        expect(csv.startsWith('﻿name,email,age,active,born_on,meta\r\n')).toBe(true)
        expect(csv).toContain("'=1+1,a@x.io,36,true,1990-05-01")
      } else {
        const rows = (await all(readXlsx(bytes, DEFAULT_LIMITS))).map((r) => r.cells)
        expect(rows[1]).toEqual(["'=1+1", 'a@x.io', '36', 'true', '1990-05-01', '{"k":[1,2]}'])
      }
      // Round trip: re-import as an upsert by email changes nothing.
      const again = await service.upload('contacts', { body: bytes }, system)
      const result = await service.start(again.id, { ...system, upsertBy: ['email'] })
      expect(result).toMatchObject({ updated: 2, created: 0, failed: 0 })
      const names = (
        await Contact.query()
          .orderBy('id' as never)
          .get()
      ).map((c) => Reflect.get(c, 'name'))
      expect(names).toEqual(['=1+1', 'Bob'])
    }
  })

  it('never exports hidden or secret columns, and refuses them as columns or filters', async () => {
    const { service } = setup()
    const raw = Contact.make()
    raw.forceFill({
      name: 'Ada',
      email: 'a@x.io',
      api_token: 'tok_secret',
      internal_note: 'private',
    })
    await raw.save()
    const exported = await service.export({ ...system, model: 'contacts', format: 'csv' })
    const csv = (
      await collect(fromWebStream((await service.download(exported.id, system)).body))
    ).toString('utf8')
    expect(csv).not.toContain('tok_secret')
    expect(csv).not.toContain('private')
    expect(csv).not.toMatch(/api_token|internal_note|tenant_id/)
    for (const columns of [['api_token'], ['internal_note'], ['nope']]) {
      await expect(
        service.export({ ...system, model: 'contacts', format: 'csv', columns }),
      ).rejects.toSatisfy((e) => isImportExportError(e, 'unknown_column'))
    }
    await expect(
      service.export({
        ...system,
        model: 'contacts',
        format: 'csv',
        where: { api_token: 'tok_secret' },
      }),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'unknown_column'))
  })

  it('exports only the rows the actor may view, and refuses actors without the right', async () => {
    const { service } = setup()
    const job = await service.upload(
      'contacts',
      { body: text('name,email,tier\nF,f@x.io,free\nP,p@x.io,pro\n') },
      system,
    )
    await service.start(job.id, system)
    const actor: Actor = { id: 'u', type: 'user', roles: [], attrs: {} }
    const access = actorAccess(
      actor,
      { import: false, update: false, export: true },
      { view: { field: 'tier', op: 'eq', value: 'pro' } },
    )
    const exported = await service.export({
      access,
      model: 'contacts',
      format: 'csv',
      columns: ['name'],
      bom: false,
    })
    const csv = (
      await collect(fromWebStream((await service.download(exported.id, { access })).body))
    ).toString('utf8')
    expect(csv).toBe('name\r\nP\r\n')
    await expect(
      service.export({
        access: actorAccess(actor, { import: true, update: true, export: false }),
        model: 'contacts',
        format: 'csv',
      }),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'import_export_forbidden'))
    // Another actor cannot download it.
    const other = actorAccess(
      { ...actor, id: 'other' },
      { import: false, update: false, export: true },
    )
    await expect(service.download(exported.id, { access: other })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'job_not_found'),
    )
  })
})
