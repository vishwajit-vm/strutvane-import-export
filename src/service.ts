/**
 * The import/export service: the whole flow on top of the engines, with job records and storage.
 *
 * ```text
 * upload ──► inspect (headings, suggested mapping, sample) ──► dryRun (report) ──► start ──► [resume]
 * export ──► stored file on the disk ──► download
 * ```
 *
 * - **Uploads go to framework storage** (`config.disk`, the tenant's folder `tenants/<id>/…` in a
 *   tenancy app), under a key that never contains the client's file name. The size limit is
 *   enforced while the bytes stream in, and the format is decided from the stored bytes; a file
 *   that fails either check is deleted again.
 * - **Imports are jobs**: the stored file's SHA-256, the options and the progress are recorded, so
 *   a run that stopped (a crash, a deploy, a failing chunk) resumes after its last committed chunk
 *   with `resume(id)`, and refuses to if the stored file changed. Each chunk's progress and failed
 *   rows are written in the chunk's own transaction, so they can never disagree with the data.
 * - **One run at a time**: starting or resuming claims the job with a fresh token, checked inside
 *   every chunk; a stale run stops at its next chunk instead of importing rows twice.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import type { StorageManager } from '@strutvane/framework'
import type { Logger, StorageDisk } from '@strutvane/framework/contracts'
import { type Messages, uuidv7 } from '@strutvane/framework/core'
import { runWithTenant } from '@strutvane/framework/database'
import { type Access, assertAllowed } from './access.ts'
import type { ResolvedConfig } from './config.ts'
import { ImportExportError, isImportExportError } from './errors.ts'
import { type ExportOptions, exportColumns, exportRows } from './export/run.ts'
import { autoMap, type ColumnMapping, readHeadings } from './import/mapping.ts'
import { type ImportResult, runImport } from './import/run.ts'
import {
  type ExportJob,
  type ImportJob,
  jobs,
  type SavedMapping,
  type StoredImportOptions,
} from './jobs.ts'
import {
  type ByteSource,
  detectFormat,
  type FileFormat,
  fromWebStream,
  readHead,
  readRows,
} from './source.ts'

/** An uploaded file: its display name and its bytes. */
export interface UploadInput {
  /** The client's file name: kept for display only, never used in a storage key. */
  readonly name?: string
  readonly body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array> | Uint8Array
}

/** Who and where: every call takes the caller's access and, in a tenancy app, the tenant. */
export interface CallContext {
  readonly access: Access
  readonly tenantId?: string
}

/** What `inspect()` returns: enough to build a mapping screen. */
export interface Inspection {
  readonly job: ImportJob
  readonly headings: readonly string[]
  /** The automatic mapping (heading → column, `null` = ignored). */
  readonly suggested: ColumnMapping
  /** The importable columns, with labels, for the mapping screen. */
  readonly columns: readonly {
    readonly name: string
    readonly label: string
    readonly required: boolean
  }[]
  /** The first data rows, as text. */
  readonly sample: readonly (readonly string[])[]
}

/** Options for a dry run or a real run of an uploaded file. */
export interface RunOptions extends CallContext, StoredImportOptions {
  /** Use a saved mapping by name (an explicit `mapping` wins). */
  readonly mappingName?: string
}

/** Options for {@link ImportExportService.export}. */
export interface ExportRequest
  extends CallContext,
    Pick<ExportOptions, 'columns' | 'where' | 'headings' | 'delimiter' | 'bom'> {
  readonly model: string
  readonly format: FileFormat
}

/** Everything the service needs. */
export interface ImportExportServiceOptions {
  readonly config: ResolvedConfig
  /** Framework storage (uploads and finished exports). */
  readonly storage: StorageManager
  readonly logger?: Logger
  readonly messages?: Messages
}

/** The service. */
export interface ImportExportService {
  upload(model: string, file: UploadInput, context: CallContext): Promise<ImportJob>
  inspect(jobId: string, context: CallContext): Promise<Inspection>
  dryRun(jobId: string, options: RunOptions): Promise<ImportResult>
  start(jobId: string, options: RunOptions): Promise<ImportResult>
  resume(jobId: string, context: CallContext): Promise<ImportResult>
  job(jobId: string, context: CallContext): Promise<ImportJob>
  failures(jobId: string, context: CallContext): Promise<Awaited<ReturnType<typeof jobs.failures>>>
  saveMapping(
    model: string,
    name: string,
    mapping: ColumnMapping,
    context: CallContext,
  ): Promise<void>
  mappings(model: string, context: CallContext): Promise<SavedMapping[]>
  export(request: ExportRequest): Promise<ExportJob>
  download(
    exportId: string,
    context: CallContext,
  ): Promise<{
    readonly job: ExportJob
    readonly fileName: string
    readonly contentType: string
    readonly body: ReadableStream<Uint8Array>
  }>
}

/** Content types of the formats. */
export const CONTENT_TYPES: Readonly<Record<FileFormat, string>> = Object.freeze({
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})

async function* bytesOf(body: UploadInput['body']): AsyncGenerator<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body
    return
  }
  if (body instanceof ReadableStream) {
    yield* fromWebStream(body)
    return
  }
  yield* body
}

/** Count bytes as they pass, refusing more than `max` (the upload is never stored whole). */
async function* limited(
  source: AsyncIterable<Uint8Array>,
  max: number,
): AsyncGenerator<Uint8Array> {
  let total = 0
  for await (const chunk of source) {
    total += chunk.byteLength
    if (total > max) throw new ImportExportError('file_too_large', { params: { max } })
    yield chunk
  }
}

/** A re-openable source over a stored file. */
function storedSource(disk: StorageDisk, key: string): ByteSource {
  return () =>
    (async function* () {
      yield* fromWebStream(await disk.get(key))
    })()
}

/** The SHA-256 of a stored file, streamed. */
async function sha256Of(source: ByteSource): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of source()) hash.update(chunk)
  return hash.digest('hex')
}

/** A display name: printable, no path, at most 255 characters. */
function displayName(name: string | undefined): string | null {
  if (name === undefined) return null
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return base === '' ? null : base.slice(0, 255)
}

/**
 * Create the service.
 *
 * @example
 * const service = createImportExport({ config, storage: app.make(StorageManagerToken) })
 * const job = await service.upload('contacts', { name: file.clientName, body: file.stream() }, { access })
 */
export function createImportExport(options: ImportExportServiceOptions): ImportExportService {
  const { config, storage } = options
  const diskFor = (tenantId: string | undefined): StorageDisk =>
    tenantId === undefined ? storage.disk(config.disk) : storage.forTenant(tenantId, config.disk)
  const diskName = config.disk ?? storage.defaultDisk
  const scoped = <T>(context: CallContext, work: () => Promise<T>): Promise<T> =>
    context.tenantId === undefined ? work() : runWithTenant(context.tenantId, work)

  const findJob = async (jobId: string, context: CallContext): Promise<ImportJob> => {
    const job = await scoped(context, () => jobs.findImport(jobId, context.access))
    if (job === undefined) throw new ImportExportError('job_not_found')
    return job
  }

  const resolveOptions = async (job: ImportJob, run: RunOptions): Promise<StoredImportOptions> => {
    let mapping = run.mapping ?? job.options.mapping
    if (run.mapping === undefined && run.mappingName !== undefined) {
      const saved = await scoped(run, () => jobs.findMapping(job.model, run.mappingName ?? ''))
      if (saved === undefined)
        throw new ImportExportError('invalid_option', {
          params: { option: 'mapping', reason: 'no saved mapping with that name' },
        })
      mapping = saved.mapping
    }
    const pick = <K extends keyof StoredImportOptions>(key: K): Partial<StoredImportOptions> => {
      const value = run[key] ?? job.options[key]
      return value === undefined ? {} : { [key]: value }
    }
    return {
      ...(mapping === undefined ? {} : { mapping }),
      ...pick('upsertBy'),
      ...pick('createOnly'),
      ...pick('onError'),
      ...pick('delimiter'),
    }
  }

  const importWith = (job: ImportJob, stored: StoredImportOptions, context: CallContext) => ({
    model: config.model(job.model),
    source: storedSource(diskFor(context.tenantId), job.fileKey),
    access: context.access,
    format: job.format,
    chunkSize: config.chunkSize,
    maxReportedErrors: config.maxReportedErrors,
    ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
    ...(stored.mapping === undefined ? {} : { mapping: stored.mapping }),
    ...(stored.upsertBy === undefined ? {} : { upsertBy: stored.upsertBy }),
    ...(stored.createOnly === undefined ? {} : { createOnly: stored.createOnly }),
    ...(stored.onError === undefined ? {} : { onError: stored.onError }),
    ...(stored.delimiter === undefined ? {} : { delimiter: stored.delimiter }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.messages === undefined ? {} : { messages: options.messages }),
  })

  /** Claim, verify the file, run in chunks with progress, and record the outcome. */
  const commit = async (
    jobId: string,
    run: RunOptions | CallContext,
    fresh: boolean,
  ): Promise<ImportResult> => {
    assertAllowed(run.access, 'import')
    const found = await findJob(jobId, run)
    if (found.dryRun)
      throw new ImportExportError('job_not_resumable', { params: { reason: 'it was a dry run' } })
    const stored = fresh ? await resolveOptions(found, run as RunOptions) : found.options
    const { job, token } = await scoped(run, () => jobs.claimImport(jobId, run.access))
    const fail = async (error: unknown): Promise<never> => {
      const code = isImportExportError(error) ? error.code : 'internal_error'
      await scoped(run, () =>
        jobs.updateImport(job.id, { status: 'failed', error_code: code }),
      ).catch(() => undefined)
      throw error
    }
    try {
      const sha = await sha256Of(storedSource(diskFor(run.tenantId), job.fileKey))
      if (sha !== job.fileSha256) throw new ImportExportError('file_changed')
      if (fresh) await scoped(run, () => jobs.updateImport(job.id, { options: stored }))
      const resuming = job.nextRow > 0
      const result = await runImport({
        ...importWith(job, stored, run),
        mode: 'commit',
        ...(resuming
          ? {
              resumeAfterRow: job.nextRow,
              resumeCounts: {
                processed: job.processed,
                created: job.created,
                updated: job.updated,
                failed: job.failed,
              },
            }
          : {}),
        onChunk: async (progress) => {
          await jobs.assertClaim(job.id, token)
          await jobs.updateImport(job.id, {
            next_row: progress.lastRow,
            processed_rows: progress.processed,
            created_rows: progress.created,
            updated_rows: progress.updated,
            failed_rows: progress.failed,
          })
          await jobs.recordFailures(job.id, progress.failures)
        },
      })
      await scoped(run, async () => {
        // A one-transaction run (onError: 'rollback') reports its failures after the fact.
        if (stored.onError === 'rollback') await jobs.recordFailures(job.id, result.failures)
        await jobs.updateImport(job.id, {
          status: result.rolledBack ? 'failed' : 'completed',
          error_code: result.rolledBack ? 'rows_failed' : null,
          next_row: result.lastRow,
          processed_rows: result.processed,
          created_rows: result.created,
          updated_rows: result.updated,
          failed_rows: result.failed,
          finished_at: new Date(),
          claim_token: null,
        })
      })
      return result
    } catch (error) {
      return fail(error)
    }
  }

  return {
    async upload(model, file, context) {
      assertAllowed(context.access, 'import')
      const definition = config.model(model)
      const disk = diskFor(context.tenantId)
      const key = `${config.importDirectory}/${uuidv7()}.upload`
      const body = Readable.toWeb(
        Readable.from(limited(bytesOf(file.body), definition.limits.maxFileBytes)),
      ) as ReadableStream<Uint8Array>
      let format: FileFormat
      let stored: Awaited<ReturnType<StorageDisk['put']>>
      try {
        stored = await disk.put(key, body, { contentType: 'application/octet-stream' })
        format = detectFormat(await readHead(storedSource(disk, key)))
      } catch (error) {
        await disk.delete(key).catch(() => undefined)
        throw error
      }
      return scoped(context, () =>
        jobs.createImport(
          {
            model,
            dryRun: false,
            format,
            disk: diskName,
            fileKey: key,
            fileName: displayName(file.name),
            fileSize: stored.size,
            fileSha256: stored.sha256,
            options: {},
          },
          context.access,
        ),
      )
    },

    async inspect(jobId, context) {
      const job = await findJob(jobId, context)
      const definition = config.model(job.model)
      const columns = definition.columns()
      const rows: string[][] = []
      for await (const row of readRows(storedSource(diskFor(context.tenantId), job.fileKey), {
        format: job.format,
        limits: definition.limits,
        ...(job.options.delimiter === undefined ? {} : { delimiter: job.options.delimiter }),
      })) {
        rows.push([...row.cells])
        if (rows.length > 5) break
      }
      const [first, ...sample] = rows
      if (first === undefined) throw new ImportExportError('empty_file')
      const headings = readHeadings(first)
      return {
        job,
        headings,
        suggested: autoMap(headings, columns),
        columns: [...columns.importable.values()].map((c) => ({
          name: c.name,
          label: c.label,
          required: !c.optional,
        })),
        sample,
      }
    },

    async dryRun(jobId, run) {
      const job = await findJob(jobId, run)
      const stored = await resolveOptions(job, run)
      return runImport({ ...importWith(job, stored, run), mode: 'dry-run' })
    },

    start: (jobId, run) => commit(jobId, run, true),
    resume: (jobId, context) => commit(jobId, context, false),
    job: (jobId, context) => findJob(jobId, context),

    async failures(jobId, context) {
      const job = await findJob(jobId, context)
      return scoped(context, () => jobs.failures(job.id))
    },

    async saveMapping(model, name, mapping, context) {
      assertAllowed(context.access, 'import')
      if (!/^[\p{L}\p{N} _.-]{1,100}$/u.test(name))
        throw new ImportExportError('invalid_option', {
          params: { option: 'name', reason: 'letters, digits, spaces, "-", "_" and "." only' },
        })
      const definition = config.model(model)
      // Validate now: a saved mapping that names a hidden or unknown column would fail every import.
      for (const target of Object.values(mapping)) {
        if (target !== null && !definition.columns().importable.has(target))
          throw new ImportExportError('unknown_column', {
            params: { column: String(target).slice(0, 100) },
          })
      }
      await scoped(context, () => jobs.saveMapping({ model, name, mapping }, context.access))
    },

    async mappings(model, context) {
      config.model(model)
      return scoped(context, () => jobs.listMappings(model))
    },

    async export(request) {
      assertAllowed(request.access, 'export')
      const definition = config.model(request.model)
      const columns = exportColumns(definition, request.columns).map((c) => c.name)
      const job = await scoped(request, () =>
        jobs.createExport(
          { model: request.model, format: request.format, columns },
          request.access,
        ),
      )
      const disk = diskFor(request.tenantId)
      const key = `${config.exportDirectory}/${job.id}.${request.format}`
      let rows = 0
      try {
        const stream = exportRows({
          model: definition,
          access: request.access,
          format: request.format,
          columns,
          onFinish: (n) => {
            rows = n
          },
          ...(request.where === undefined ? {} : { where: request.where }),
          ...(request.headings === undefined ? {} : { headings: request.headings }),
          ...(request.delimiter === undefined ? {} : { delimiter: request.delimiter }),
          ...(request.bom === undefined ? {} : { bom: request.bom }),
          ...(request.tenantId === undefined ? {} : { tenantId: request.tenantId }),
        })
        await disk.put(key, Readable.toWeb(Readable.from(stream)) as ReadableStream<Uint8Array>, {
          contentType: CONTENT_TYPES[request.format],
        })
      } catch (error) {
        await disk.delete(key).catch(() => undefined)
        const code = isImportExportError(error) ? error.code : 'internal_error'
        await scoped(request, () =>
          jobs.updateExport(job.id, {
            status: 'failed',
            error_code: code,
            finished_at: new Date(),
          }),
        ).catch(() => undefined)
        throw error
      }
      const stamp = new Date().toISOString().slice(0, 10)
      const fileName = `${request.model}-${stamp}.${request.format}`
      await scoped(request, () =>
        jobs.updateExport(job.id, {
          status: 'completed',
          disk: diskName,
          file_key: key,
          file_name: fileName,
          row_count: rows,
          finished_at: new Date(),
        }),
      )
      return { ...job, status: 'completed', disk: diskName, fileKey: key, fileName, rowCount: rows }
    },

    async download(exportId, context) {
      const job = await scoped(context, () => jobs.findExport(exportId, context.access))
      if (job === undefined || job.status !== 'completed' || job.fileKey === null)
        throw new ImportExportError('job_not_found')
      return {
        job,
        fileName: job.fileName ?? `${job.model}.${job.format}`,
        contentType: CONTENT_TYPES[job.format],
        body: await diskFor(context.tenantId).get(job.fileKey),
      }
    },
  }
}
