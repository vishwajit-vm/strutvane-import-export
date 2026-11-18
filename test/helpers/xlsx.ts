/**
 * Build ZIP archives and workbooks by hand, including broken and hostile ones (lying sizes,
 * encryption flags, bad CRCs, odd methods), which no real writer would produce.
 */
import { crc32, deflateRawSync } from 'node:zlib'

/** One entry of a hand-built archive. */
export interface RawEntry {
  readonly name: string
  readonly data: Buffer
  /** Uncompressed size written to the headers (default: the real size). */
  readonly declaredSize?: number
  /** General-purpose flags (bit 0 = encrypted). */
  readonly flags?: number
  /** Compression method written to the headers (default 8, deflate). */
  readonly method?: number
  /** CRC written to the headers (default: the real CRC). */
  readonly crc?: number
}

/** A ZIP archive with the given entries (deflated unless `method` is 0). */
export function buildZip(entries: readonly RawEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const body = method === 0 ? entry.data : deflateRawSync(entry.data)
    const name = Buffer.from(entry.name, 'utf8')
    const crc = entry.crc ?? crc32(entry.data)
    const size = entry.declaredSize ?? entry.data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(entry.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(entry.flags ?? 0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(size, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(central, name)
    offset += local.length + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/**
 * A minimal workbook: `sheet` is the content of `<sheetData>` (or `sheetXml` the whole part),
 * `sharedStrings` the inner XML of each `<si>` (plain text is wrapped in `<t>`), `styles` the inner
 * XML of `<styleSheet>`.
 */
export function workbook(parts: {
  readonly sheet?: string
  readonly sheetXml?: string
  readonly sharedStrings?: readonly string[]
  readonly styles?: string
}): Buffer {
  const rels = [
    `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>`,
    parts.sharedStrings
      ? `<Relationship Id="rId2" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/>`
      : '',
    parts.styles ? `<Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/>` : '',
  ].join('')
  const entries: RawEntry[] = [
    {
      name: 'xl/workbook.xml',
      data: Buffer.from(
        `<?xml version="1.0"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        parts.sheetXml ??
          `<worksheet xmlns="${NS}"><sheetData>${parts.sheet ?? ''}</sheetData></worksheet>`,
      ),
    },
  ]
  if (parts.sharedStrings)
    entries.push({
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        `<sst xmlns="${NS}">${parts.sharedStrings
          .map(
            (s) =>
              `<si>${s.startsWith('<') || s.includes('<rPh>') ? s.replace(/^([^<]+)/, '<t>$1</t>') : `<t>${s}</t>`}</si>`,
          )
          .join('')}</sst>`,
      ),
    })
  if (parts.styles)
    entries.push({
      name: 'xl/styles.xml',
      data: Buffer.from(`<styleSheet xmlns="${NS}">${parts.styles}</styleSheet>`),
    })
  return buildZip(entries)
}
