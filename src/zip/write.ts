/**
 * A streaming ZIP writer on `node:zlib`: each entry is deflated as it is produced and written
 * with a data descriptor (general-purpose flag bit 3), so the sizes and CRC never need to be
 * known up front and nothing is held in memory but zlib's window and one chunk.
 *
 * Deliberately limited: no ZIP64, so at most 65,534 entries and 4 GiB per entry and per archive
 * (an export that large fails with a clear error instead of writing a corrupt file).
 *
 * @module
 */
import { Readable } from 'node:stream'
import { crc32, createDeflateRaw } from 'node:zlib'
import { ImportExportError } from '../errors.ts'

/** One entry to write: a name and its content as text or a stream of chunks. */
export interface ZipSourceEntry {
  readonly name: string
  readonly content: string | AsyncIterable<Uint8Array | string>
}

const LIMIT_32 = 0xffffffff
const encoder = new TextEncoder()

/** The DOS date and time fields of a ZIP header. */
function dosDateTime(date: Date): { readonly time: number; readonly date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107)
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

async function* asBytes(
  content: string | AsyncIterable<Uint8Array | string>,
): AsyncGenerator<Uint8Array> {
  if (typeof content === 'string') {
    yield encoder.encode(content)
    return
  }
  for await (const chunk of content) yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk
}

function tooLarge(): ImportExportError {
  return new ImportExportError('invalid_option', {
    params: { option: 'export', reason: 'the file would exceed 4 GiB (ZIP64 is not supported)' },
  })
}

/**
 * Write a ZIP archive as a stream of chunks.
 *
 * @example
 * for await (const chunk of zipStream([{ name: 'a.txt', content: 'hi' }])) out.write(chunk)
 */
export async function* zipStream(
  entries: Iterable<ZipSourceEntry> | AsyncIterable<ZipSourceEntry>,
  options: { readonly modified?: Date } = {},
): AsyncGenerator<Uint8Array, void, undefined> {
  const stamp = dosDateTime(options.modified ?? new Date())
  const central: Buffer[] = []
  let offset = 0
  let count = 0
  for await (const entry of entries) {
    if (count >= 0xfffe) throw tooLarge()
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed: 2.0 (deflate)
    local.writeUInt16LE(0x0808, 6) // bit 3: data descriptor; bit 11: UTF-8 names
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    // CRC and sizes (14..25) stay 0: they follow in the data descriptor.
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    const headerOffset = offset
    yield local
    yield name
    offset += local.length + name.length

    let crc = 0
    let size = 0
    let compressed = 0
    const counted = async function* (): AsyncGenerator<Uint8Array> {
      for await (const chunk of asBytes(entry.content)) {
        crc = crc32(chunk, crc)
        size += chunk.byteLength
        if (size > LIMIT_32) throw tooLarge()
        yield chunk
      }
    }
    const deflater = createDeflateRaw({ level: 6 })
    const input = Readable.from(counted())
    input.pipe(deflater)
    try {
      for await (const chunk of deflater as AsyncIterable<Buffer>) {
        compressed += chunk.byteLength
        if (compressed > LIMIT_32) throw tooLarge()
        yield chunk
      }
    } finally {
      input.unpipe(deflater)
      deflater.destroy()
      input.destroy()
    }
    offset += compressed

    const descriptor = Buffer.alloc(16)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc >>> 0, 4)
    descriptor.writeUInt32LE(compressed, 8)
    descriptor.writeUInt32LE(size, 12)
    yield descriptor
    offset += descriptor.length
    if (offset > LIMIT_32) throw tooLarge()

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4) // version made by
    header.writeUInt16LE(20, 6) // version needed
    header.writeUInt16LE(0x0808, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt16LE(stamp.time, 12)
    header.writeUInt16LE(stamp.date, 14)
    header.writeUInt32LE(crc >>> 0, 16)
    header.writeUInt32LE(compressed, 20)
    header.writeUInt32LE(size, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt32LE(headerOffset, 42)
    central.push(header, name)
    count++
  }
  const cdOffset = offset
  let cdSize = 0
  for (const part of central) {
    cdSize += part.length
    yield part
  }
  if (cdOffset + cdSize > LIMIT_32) throw tooLarge()
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(cdOffset, 16)
  yield end
}
