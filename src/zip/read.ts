/**
 * A defensive ZIP reader for XLSX workbooks, on `node:zlib` alone.
 *
 * An XLSX file is a ZIP archive, and ZIP archives are a classic way to exhaust a server: a few
 * kilobytes that inflate to gigabytes (a "zip bomb"), overlapping or duplicated entries, sizes
 * that lie. This reader assumes all of that:
 *
 * - The whole archive is in memory, already bounded by `maxFileBytes` (an XLSX needs random access
 *   to its central directory anyway).
 * - At most `maxZipEntries` entries; duplicate names, encrypted entries, ZIP64 and multi-disk
 *   archives, and compression methods other than stored/deflate are refused.
 * - Every entry is inflated as a **stream**, counting bytes as they come out: more than the size
 *   the entry declared, more than `maxCompressionRatio` times its compressed size, or more than
 *   the shared `maxUncompressedBytes` budget for the whole workbook stops the inflater at once.
 * - The CRC-32 of every fully read entry is checked.
 *
 * @module
 */
import { Readable } from 'node:stream'
import { crc32, createInflateRaw } from 'node:zlib'
import { ImportExportError } from '../errors.ts'

/** Limits for one archive. */
export interface ZipLimits {
  readonly maxZipEntries: number
  readonly maxCompressionRatio: number
  readonly maxUncompressedBytes: number
}

/** One entry of the central directory. */
export interface ZipEntry {
  readonly name: string
  readonly method: 0 | 8
  readonly crc: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localHeaderOffset: number
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff
/** Entries up to this size skip the ratio check (the shared budget still applies). */
const RATIO_FLOOR_BYTES = 1024 * 1024

const unsafe = (reason: string): ImportExportError =>
  new ImportExportError('unsafe_file', { params: { reason } })
const malformed = (reason: string): ImportExportError =>
  new ImportExportError('malformed_file', { params: { reason } })

/**
 * A parsed archive. Create it with {@link ZipReader.open}; read entries with
 * {@link ZipReader.stream} or {@link ZipReader.text}. All entries share one inflation budget.
 *
 * @example
 * const zip = ZipReader.open(bytes, limits)
 * const xml = await zip.text('xl/workbook.xml', 1024 * 1024)
 */
export class ZipReader {
  readonly #bytes: Buffer
  readonly #entries: ReadonlyMap<string, ZipEntry>
  readonly #limits: ZipLimits
  #inflated = 0

  private constructor(bytes: Buffer, entries: ReadonlyMap<string, ZipEntry>, limits: ZipLimits) {
    this.#bytes = bytes
    this.#entries = entries
    this.#limits = limits
  }

  /** Parse the central directory. Throws `unsafe_file` / `malformed_file` on anything suspicious. */
  static open(bytes: Uint8Array, limits: ZipLimits): ZipReader {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const eocd = findEndOfCentralDirectory(buffer)
    const disk = buffer.readUInt16LE(eocd + 4)
    const cdDisk = buffer.readUInt16LE(eocd + 6)
    const count = buffer.readUInt16LE(eocd + 10)
    const cdSize = buffer.readUInt32LE(eocd + 12)
    const cdOffset = buffer.readUInt32LE(eocd + 16)
    if (disk !== 0 || cdDisk !== 0 || buffer.readUInt16LE(eocd + 8) !== count)
      throw unsafe('multi-disk archives are not supported')
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
      throw unsafe('ZIP64 archives are not supported')
    if (count > limits.maxZipEntries) throw unsafe(`more than ${limits.maxZipEntries} entries`)
    if (cdOffset + cdSize > eocd) throw malformed('central directory out of bounds')
    const entries = new Map<string, ZipEntry>()
    let pos = cdOffset
    for (let i = 0; i < count; i++) {
      if (pos + 46 > eocd || buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE)
        throw malformed('bad central directory entry')
      const flags = buffer.readUInt16LE(pos + 8)
      const method = buffer.readUInt16LE(pos + 10)
      const crc = buffer.readUInt32LE(pos + 16)
      const compressedSize = buffer.readUInt32LE(pos + 20)
      const uncompressedSize = buffer.readUInt32LE(pos + 24)
      const nameLength = buffer.readUInt16LE(pos + 28)
      const extraLength = buffer.readUInt16LE(pos + 30)
      const commentLength = buffer.readUInt16LE(pos + 32)
      const localHeaderOffset = buffer.readUInt32LE(pos + 42)
      const nameEnd = pos + 46 + nameLength
      if (nameEnd + extraLength + commentLength > eocd) throw malformed('entry name out of bounds')
      if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) throw unsafe('encrypted entries')
      if (method !== 0 && method !== 8) throw unsafe(`compression method ${method}`)
      if (
        compressedSize === 0xffffffff ||
        uncompressedSize === 0xffffffff ||
        localHeaderOffset === 0xffffffff
      )
        throw unsafe('ZIP64 entries are not supported')
      const name = new TextDecoder('utf-8', { fatal: false }).decode(
        buffer.subarray(pos + 46, nameEnd),
      )
      if (entries.has(name)) throw unsafe(`duplicate entry "${safeName(name)}"`)
      entries.set(name, {
        name,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localHeaderOffset,
      })
      pos = nameEnd + extraLength + commentLength
    }
    return new ZipReader(buffer, entries, limits)
  }

  /** Every entry name, in directory order. */
  names(): string[] {
    return [...this.#entries.keys()]
  }

  /** Is there an entry with this exact name? */
  has(name: string): boolean {
    return this.#entries.has(name)
  }

  /**
   * Inflate one entry as a stream of chunks, enforcing the declared size, the ratio and the
   * shared budget while it runs, and the CRC-32 at the end.
   */
  async *stream(name: string): AsyncGenerator<Uint8Array, void, undefined> {
    const entry = this.#entries.get(name)
    if (entry === undefined) throw malformed(`missing part ${safeName(name)}`)
    this.#checkDeclared(entry)
    const data = this.#data(entry)
    let produced = 0
    let crc = 0
    const take = (chunk: Uint8Array): Uint8Array => {
      produced += chunk.byteLength
      this.#inflated += chunk.byteLength
      if (produced > entry.uncompressedSize)
        throw unsafe(`"${safeName(name)}" inflates beyond its declared size`)
      if (this.#inflated > this.#limits.maxUncompressedBytes)
        throw unsafe(
          `the workbook inflates to more than ${this.#limits.maxUncompressedBytes} bytes`,
        )
      crc = crc32(chunk, crc)
      return chunk
    }
    if (entry.method === 0) {
      if (data.byteLength > 0) yield take(data)
    } else {
      const inflater = createInflateRaw({ chunkSize: 64 * 1024 })
      const input = Readable.from([data])
      input.pipe(inflater)
      try {
        for await (const chunk of inflater as AsyncIterable<Buffer>) yield take(chunk)
      } catch (error) {
        if (error instanceof ImportExportError) throw error
        throw malformed(`"${safeName(name)}" is not valid deflate data`)
      } finally {
        input.unpipe(inflater)
        inflater.destroy()
        input.destroy()
      }
    }
    if (produced !== entry.uncompressedSize)
      throw malformed(`"${safeName(name)}" is shorter than declared`)
    if (crc >>> 0 !== entry.crc >>> 0) throw malformed(`"${safeName(name)}" fails its CRC check`)
  }

  /** Inflate a (small) entry to UTF-8 text, refusing entries larger than `maxBytes`. */
  async text(name: string, maxBytes: number): Promise<string> {
    const entry = this.#entries.get(name)
    if (entry === undefined) throw malformed(`missing part ${safeName(name)}`)
    if (entry.uncompressedSize > maxBytes)
      throw unsafe(`"${safeName(name)}" is larger than ${maxBytes} bytes`)
    const chunks: Uint8Array[] = []
    for await (const chunk of this.stream(name)) chunks.push(chunk)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch (error) {
      throw new ImportExportError('invalid_encoding', { cause: error })
    }
  }

  #checkDeclared(entry: ZipEntry): void {
    if (entry.uncompressedSize > this.#limits.maxUncompressedBytes - this.#inflated)
      throw unsafe(`the workbook inflates to more than ${this.#limits.maxUncompressedBytes} bytes`)
    // Small parts compress unevenly (a 2 KiB styles.xml of repeated tags); the budget covers
    // them. The ratio guard is for parts large enough to matter.
    if (entry.method === 8 && entry.uncompressedSize > RATIO_FLOOR_BYTES) {
      const ratio = entry.uncompressedSize / Math.max(1, entry.compressedSize)
      if (ratio > this.#limits.maxCompressionRatio)
        throw unsafe(
          `"${safeName(entry.name)}" has a compression ratio above ${this.#limits.maxCompressionRatio}:1`,
        )
    }
    if (entry.method === 0 && entry.compressedSize !== entry.uncompressedSize)
      throw malformed(`"${safeName(entry.name)}" is stored with mismatching sizes`)
  }

  /** The compressed bytes of an entry, after its local header. */
  #data(entry: ZipEntry): Buffer {
    const pos = entry.localHeaderOffset
    const bytes = this.#bytes
    if (pos + 30 > bytes.length || bytes.readUInt32LE(pos) !== LOCAL_SIGNATURE)
      throw malformed('bad local header')
    const start = pos + 30 + bytes.readUInt16LE(pos + 26) + bytes.readUInt16LE(pos + 28)
    const end = start + entry.compressedSize
    if (end > bytes.length) throw malformed('entry data out of bounds')
    return bytes.subarray(start, end)
  }
}

/** Find the end-of-central-directory record, scanning back over a possible archive comment. */
function findEndOfCentralDirectory(buffer: Buffer): number {
  if (buffer.length < EOCD_MIN) throw malformed('too short to be a ZIP archive')
  const stop = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT)
  for (let pos = buffer.length - EOCD_MIN; pos >= stop; pos--) {
    if (buffer.readUInt32LE(pos) === EOCD_SIGNATURE) return pos
  }
  throw malformed('no end of central directory')
}

/** An entry name fit for an error message: printable, short. */
function safeName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, '?')
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean
}
