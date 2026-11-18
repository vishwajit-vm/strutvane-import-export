import { deflateRawSync } from 'node:zlib'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { neutralizeFormula, type OutputCell, toOutputCell } from '../src/cells.ts'
import { isImportExportError } from '../src/errors.ts'
import { DEFAULT_LIMITS } from '../src/limits.ts'
import { columnIndex, isDateFormatCode, readXlsx, serialToIso } from '../src/xlsx/read.ts'
import { columnLetters, excelSerial, sheetName, xlsxStream, xmlEscape } from '../src/xlsx/write.ts'
import { decodeEntities, XmlTokenizer } from '../src/xml/tokenize.ts'
import { ZipReader } from '../src/zip/read.ts'
import { zipStream } from '../src/zip/write.ts'
import { all, collect } from './helpers/bytes.ts'
import { buildZip, workbook } from './helpers/xlsx.ts'

const limits = DEFAULT_LIMITS
const rows = async (bytes: Uint8Array, l = limits) =>
  (await all(readXlsx(bytes, l))).map((r) => [r.row, ...r.cells])

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}

describe('XmlTokenizer', () => {
  it('emits start, end and text events with local names and decoded entities', () => {
    const t = new XmlTokenizer()
    const events = [
      ...t.push(
        '<?xml version="1.0"?><x:root xmlns:x="u"><a r="1" x:t=\'s&amp;\'>A &lt; B</a><b/><!-- c --><![CDATA[<raw>]]></x:root>',
      ),
      ...t.end(),
    ]
    expect(events).toEqual([
      { kind: 'open', name: 'root', attrs: new Map(), selfClosing: false },
      {
        kind: 'open',
        name: 'a',
        attrs: new Map([
          ['r', '1'],
          ['t', 's&'],
        ]),
        selfClosing: false,
      },
      { kind: 'text', text: 'A < B' },
      { kind: 'close', name: 'a' },
      { kind: 'open', name: 'b', attrs: new Map(), selfClosing: true },
      { kind: 'text', text: '<raw>' },
      { kind: 'close', name: 'root' },
    ])
  })

  it('waits for tags, entities, comments and CDATA cut by chunk boundaries', () => {
    const xml = '<r a="x>y"><t>caf&#233; &amp; more</t><!-- note --><![CDATA[a]]></r>'
    for (let size = 1; size < 12; size++) {
      const t = new XmlTokenizer()
      const events = []
      for (let i = 0; i < xml.length; i += size) events.push(...t.push(xml.slice(i, i + size)))
      events.push(...t.end())
      const text = events.flatMap((e) => (e.kind === 'text' ? [e.text] : [])).join('')
      expect(text).toBe('café & morea')
      expect(events[0]).toMatchObject({ kind: 'open', name: 'r', attrs: new Map([['a', 'x>y']]) })
    }
  })

  it('refuses any DTD: XXE and billion laughs never get a chance', () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>'
    expect(() => new XmlTokenizer().push(xxe)).toThrow(
      expect.objectContaining({ code: 'unsafe_file' }),
    )
    const laughs =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><lolz>&lol2;</lolz>'
    expect(() => new XmlTokenizer().push(laughs)).toThrow(
      expect.objectContaining({ code: 'unsafe_file' }),
    )
    // Undeclared entities (without a DTD there are no others) are refused too.
    expect(() => decodeEntities('&xxe;')).toThrow(expect.objectContaining({ code: 'unsafe_file' }))
    expect(() => decodeEntities('&#xD800;')).toThrow(
      expect.objectContaining({ code: 'malformed_file' }),
    )
  })

  it('refuses broken documents', () => {
    const bad = ['<a><b></a>', 'text<a/>', '<a x="1" y></a>', '<a></a></a>', '<a', '<a x="<"/>']
    for (const xml of bad) {
      expect(() => {
        const t = new XmlTokenizer()
        t.push(xml)
        t.end()
      }, xml).toThrow()
    }
    expect(() => new XmlTokenizer().push(`<a ${'x'.repeat(70 * 1024)}`)).toThrow(
      expect.objectContaining({ code: 'unsafe_file' }),
    )
  })

  it('never throws anything but an ImportExportError on random text (fuzz)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        try {
          const t = new XmlTokenizer()
          t.push(`<r>${text}`)
          t.end()
        } catch (error) {
          expect(isImportExportError(error)).toBe(true)
        }
      }),
      { numRuns: 500 },
    )
  })
})

describe('ZIP', () => {
  it('writes archives that the reader reads back, entry by entry', async () => {
    const bytes = await collect(
      zipStream([
        { name: 'a.txt', content: 'hello' },
        {
          name: 'dir/ünï.txt',
          content: fromArray(['part 1, ', new TextEncoder().encode('part 2')]),
        },
        { name: 'empty', content: '' },
      ]),
    )
    const zip = ZipReader.open(bytes, limits)
    expect(zip.names()).toEqual(['a.txt', 'dir/ünï.txt', 'empty'])
    expect(await zip.text('a.txt', 100)).toBe('hello')
    expect(await zip.text('dir/ünï.txt', 100)).toBe('part 1, part 2')
    expect(await zip.text('empty', 100)).toBe('')
  })

  it('stops a zip bomb by its declared ratio, its real output and the shared budget', async () => {
    const zeros = Buffer.alloc(8 * 1024 * 1024)
    const bomb = buildZip([{ name: 'bomb', data: zeros }])
    await expect(collect(ZipReader.open(bomb, limits).stream('bomb'))).rejects.toSatisfy((e) =>
      isImportExportError(e, 'unsafe_file'),
    )
    // Lying about the size: declared small, inflates to megabytes.
    const liar = buildZip([{ name: 'liar', data: zeros, declaredSize: 100 }])
    await expect(collect(ZipReader.open(liar, limits).stream('liar'))).rejects.toSatisfy((e) =>
      isImportExportError(e, 'unsafe_file'),
    )
    // Many reasonable entries that together exceed the budget.
    const parts = Array.from({ length: 4 }, (_, i) => ({
      name: `p${i}`,
      data: Buffer.alloc(300_000, 65 + i),
    }))
    const tight = { ...limits, maxUncompressedBytes: 1_000_000, maxCompressionRatio: 10_000 }
    const zip = ZipReader.open(buildZip(parts), tight)
    await expect(
      (async () => {
        for (const p of parts) await collect(zip.stream(p.name))
      })(),
    ).rejects.toSatisfy((e) => isImportExportError(e, 'unsafe_file'))
  })

  it('refuses duplicate names, encryption, odd methods, too many entries and bad CRCs', async () => {
    const dup = buildZip([
      { name: 'x', data: Buffer.from('1') },
      { name: 'x', data: Buffer.from('2') },
    ])
    expect(() => ZipReader.open(dup, limits)).toThrow(
      expect.objectContaining({ code: 'unsafe_file' }),
    )
    expect(() =>
      ZipReader.open(buildZip([{ name: 'e', data: Buffer.from('1'), flags: 1 }]), limits),
    ).toThrow(expect.objectContaining({ code: 'unsafe_file' }))
    expect(() =>
      ZipReader.open(buildZip([{ name: 'm', data: Buffer.from('1'), method: 12 }]), limits),
    ).toThrow(expect.objectContaining({ code: 'unsafe_file' }))
    const many = buildZip(
      Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.from('x') })),
    )
    expect(() => ZipReader.open(many, { ...limits, maxZipEntries: 4 })).toThrow(
      expect.objectContaining({ code: 'unsafe_file' }),
    )
    const badCrc = buildZip([{ name: 'c', data: Buffer.from('content'), crc: 1 }])
    await expect(collect(ZipReader.open(badCrc, limits).stream('c'))).rejects.toSatisfy((e) =>
      isImportExportError(e, 'malformed_file'),
    )
    expect(() => ZipReader.open(Buffer.from('PK\u0003\u0004 not really'), limits)).toThrow(
      expect.objectContaining({ code: 'malformed_file' }),
    )
  })

  it('never throws anything but an ImportExportError on random bytes after a ZIP signature (fuzz)', async () => {
    const valid = buildZip([{ name: 'xl/workbook.xml', data: Buffer.from('<workbook/>') }])
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: valid.length - 1 }),
        fc.integer({ min: 0, max: 255 }),
        async (at, byte) => {
          const copy = Buffer.from(valid)
          copy[at] = byte
          try {
            await all(readXlsx(copy, limits))
          } catch (error) {
            expect(isImportExportError(error)).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('XLSX', () => {
  it('round-trips typed cells through the streaming writer and the reader', async () => {
    const header: OutputCell[] = ['Name', 'Age', 'Active', 'Born', 'Seen', 'Note'].map((h) =>
      toOutputCell(h, 'text'),
    )
    const data: OutputCell[][] = [
      [
        toOutputCell('Ada <Lovelace> & "co"', 'text'),
        toOutputCell(36, 'number'),
        toOutputCell(true, 'boolean'),
        toOutputCell('1815-12-10', 'date'),
        toOutputCell(new Date('2026-11-18T10:30:00Z'), 'datetime'),
        toOutputCell('=HYPERLINK("http://evil")', 'text'),
      ],
      [
        toOutputCell('Grace\u0001', 'text'),
        toOutputCell(null, 'number'),
        toOutputCell(false, 'boolean'),
      ],
    ]
    const bytes = await collect(xlsxStream({ sheet: 'People', header, rows: fromArray(data) }))
    expect(await rows(bytes)).toEqual([
      [1, 'Name', 'Age', 'Active', 'Born', 'Seen', 'Note'],
      [
        2,
        'Ada <Lovelace> & "co"',
        '36',
        'true',
        '1815-12-10',
        '2026-11-18T10:30:00.000Z',
        `'=HYPERLINK("http://evil")`,
      ],
      [3, 'Grace', '', 'false'],
    ])
  })

  it('reads shared strings, rich text, sparse cells, cached formula values and date styles', async () => {
    const bytes = workbook({
      sharedStrings: [
        'plain',
        '<r><t>rich </t></r><r><t>text</t></r>',
        'x<rPh><t>phonetic</t></rPh>',
      ],
      styles:
        '<numFmts><numFmt numFmtId="170" formatCode="dd/mm/yyyy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="170"/><xf numFmtId="22"/></cellXfs>',
      sheet:
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="4"><c r="A4" t="s"><v>2</v></c><c r="B4" s="1"><v>46344</v></c><c r="C4" s="2"><v>46344.5</v></c>' +
        '<c r="D4"><f>SUM(1,2)</f><v>3</v></c><c r="E4" t="str"><f>A1</f><v>plain</v></c><c r="F4" t="e"><v>#N/A</v></c>' +
        '<c r="G4" t="inlineStr"><is><t>inline</t></is></c><c r="H4" t="b"><v>1</v></c></row>',
    })
    expect(await rows(bytes)).toEqual([
      [1, 'plain', '', 'rich text'],
      [4, 'x', '2026-11-18', '2026-11-18T12:00:00.000Z', '3', 'plain', '', 'inline', 'true'],
    ])
  })

  it('refuses a workbook whose sheet XML carries a DTD (XXE)', async () => {
    const bytes = workbook({
      sheetXml:
        '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><worksheet><sheetData><row r="1"><c t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>',
    })
    await expect(rows(bytes)).rejects.toSatisfy((e) => isImportExportError(e, 'unsafe_file'))
  })

  it('enforces the cell, column and shared-string limits', async () => {
    const long = workbook({
      sheet: `<row r="1"><c t="inlineStr"><is><t>${'a'.repeat(50)}</t></is></c></row>`,
    })
    await expect(rows(long, { ...limits, maxCellChars: 10 })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'cell_too_long'),
    )
    const wide = workbook({ sheet: '<row r="1"><c r="Z1"><v>1</v></c></row>' })
    await expect(rows(wide, { ...limits, maxColumns: 5 })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'too_many_columns'),
    )
    const strings = workbook({ sharedStrings: ['a', 'b', 'c'], sheet: '<row r="1"/>' })
    await expect(rows(strings, { ...limits, maxSharedStrings: 2 })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'unsafe_file'),
    )
    await expect(rows(strings, { ...limits, maxFileBytes: 10 })).rejects.toSatisfy((e) =>
      isImportExportError(e, 'file_too_large'),
    )
  })

  it('refuses rows out of order, bad references and dangling shared strings', async () => {
    for (const sheet of [
      '<row r="2"/><row r="1"/>',
      '<row r="1"><c r="1A"><v>1</v></c></row>',
      '<row r="1"><c t="s"><v>9</v></c></row>',
      '<c><v>1</v></c>',
    ]) {
      await expect(rows(workbook({ sheet })), sheet).rejects.toSatisfy((e) =>
        isImportExportError(e),
      )
    }
  })

  it('needs a workbook part (a random ZIP is not a spreadsheet)', async () => {
    const zip = buildZip([{ name: 'hello.txt', data: Buffer.from('hi') }])
    await expect(rows(zip)).rejects.toSatisfy((e) => isImportExportError(e, 'unsupported_format'))
  })

  it('has correct helpers for columns, serials, sheet names and escaping', () => {
    expect([0, 25, 26, 27, 701, 702].map(columnLetters)).toEqual([
      'A',
      'Z',
      'AA',
      'AB',
      'ZZ',
      'AAA',
    ])
    for (const i of [0, 25, 26, 700, 16_383]) expect(columnIndex(`${columnLetters(i)}7`)).toBe(i)
    expect(columnIndex('a1')).toBeUndefined()
    expect(excelSerial(new Date('2026-11-18T00:00:00Z'))).toBe(46344)
    expect(serialToIso(46344, 'date')).toBe('2026-11-18')
    expect(serialToIso(-1, 'date')).toBeUndefined()
    expect(sheetName('a/b:c*?[x]')).toBe('a b c   x')
    expect(sheetName('')).toBe('Sheet1')
    expect(xmlEscape('\u0000a\ud800b<')).toBe('ab&lt;')
    expect(isDateFormatCode('dd/mm/yyyy')).toBe(true)
    expect(isDateFormatCode('"Day" 0.00')).toBe(false)
    expect(isDateFormatCode('#,##0.00')).toBe(false)
    expect(neutralizeFormula('-1')).toBe("'-1")
  })

  it('deflates like zlib (sanity check of the test helper)', () => {
    expect(deflateRawSync(Buffer.from('abc')).length).toBeGreaterThan(0)
  })
})
