import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { toOutputCell } from '../src/cells.ts'
import { type CsvDelimiter, parseCsv, sniffDelimiter } from '../src/csv/parse.ts'
import { csvLine, escapeCsvField } from '../src/csv/write.ts'
import { isImportExportError } from '../src/errors.ts'
import { DEFAULT_LIMITS } from '../src/limits.ts'
import { all, chunks } from './helpers/bytes.ts'

const limits = DEFAULT_LIMITS
const parse = async (text: string | Uint8Array, size = 3, delimiter?: CsvDelimiter) =>
  (await all(parseCsv(chunks(text, size), { limits, ...(delimiter ? { delimiter } : {}) }))).map(
    (r) => r.cells,
  )

describe('parseCsv', () => {
  it('reads plain records with CRLF, LF and lone CR line endings', async () => {
    expect(await parse('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ])
  })

  it('handles quotes, escaped quotes, delimiters and line breaks inside quotes', async () => {
    expect(await parse('"a ""q""","x,y","line\r\nbreak"\n')).toEqual([
      ['a "q"', 'x,y', 'line\r\nbreak'],
    ])
  })

  it('drops a UTF-8 byte-order mark and keeps multi-byte characters across chunk boundaries', async () => {
    const rows = await parse('﻿näme,émoji 😀\nZoë,日本\n', 1)
    expect(rows).toEqual([
      ['näme', 'émoji 😀'],
      ['Zoë', '日本'],
    ])
  })

  it('keeps empty cells and trailing delimiters, and the last record without a newline', async () => {
    expect(await parse('a,,c,\n,,\nlast')).toEqual([['a', '', 'c', ''], ['', '', ''], ['last']])
    expect(await parse('""')).toEqual([['']])
  })

  it('keeps text after a closing quote and a quote inside an unquoted cell, as Excel does', async () => {
    expect(await parse('"ab"c,d"e\n')).toEqual([['abc', 'd"e']])
  })

  it('numbers records, not lines (a quoted line break stays in one record)', async () => {
    const records = await all(parseCsv(chunks('h\n"a\nb"\nc\n'), { limits }))
    expect(records.map((r) => r.row)).toEqual([1, 2, 3])
  })

  it('sniffs ; tab and | delimiters from the first record, outside quotes', async () => {
    expect(await parse('a;b\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(sniffDelimiter('"a,b";c;d\n')).toBe(';')
    expect(sniffDelimiter('a\tb\tc')).toBe('\t')
    expect(sniffDelimiter('a|b')).toBe('|')
    expect(sniffDelimiter('single')).toBe(',')
    expect(await parse('x|y', 100)).toEqual([['x', 'y']])
  })

  it('uses a given delimiter instead of sniffing', async () => {
    expect(await parse('a;b,c\n', 3, ',')).toEqual([['a;b', 'c']])
  })

  it('refuses invalid UTF-8 instead of storing replacement characters', async () => {
    const bad = new Uint8Array([0x61, 0x2c, 0xff, 0xfe, 0x0a])
    await expect(parse(bad)).rejects.toSatisfy((e) => isImportExportError(e, 'invalid_encoding'))
  })

  it('refuses an unterminated quote', async () => {
    await expect(parse('a,"open\nstill open')).rejects.toSatisfy((e) =>
      isImportExportError(e, 'malformed_file'),
    )
  })

  it('enforces the file size, cell length and column count while reading', async () => {
    const small = { ...limits, maxFileBytes: 10 }
    await expect(all(parseCsv(chunks('0123456789,abc\n'), { limits: small }))).rejects.toSatisfy(
      (e) => isImportExportError(e, 'file_too_large'),
    )
    const shortCells = { ...limits, maxCellChars: 4 }
    for (const text of ['abcde\n', '"abcde"\n', '"ab""cd"\n', '"ab"cde\n']) {
      await expect(all(parseCsv(chunks(text), { limits: shortCells }))).rejects.toSatisfy((e) =>
        isImportExportError(e, 'cell_too_long'),
      )
    }
    const fewColumns = { ...limits, maxColumns: 3 }
    await expect(all(parseCsv(chunks(',,,,,,\n'), { limits: fewColumns }))).rejects.toSatisfy((e) =>
      isImportExportError(e, 'too_many_columns'),
    )
  })

  it('stops a one-row file of a million empty cells after the column limit', async () => {
    async function* endless(): AsyncGenerator<Uint8Array> {
      const chunk = new TextEncoder().encode(','.repeat(1024))
      for (let i = 0; i < 1_000; i++) yield chunk
    }
    await expect(all(parseCsv(endless(), { limits }))).rejects.toSatisfy((e) =>
      isImportExportError(e, 'too_many_columns'),
    )
  })
})

describe('CSV writing', () => {
  it('quotes only when needed and doubles quotes', () => {
    expect(escapeCsvField('plain', ',')).toBe('plain')
    expect(escapeCsvField('a,b', ',')).toBe('"a,b"')
    expect(escapeCsvField('a;b', ',')).toBe('a;b')
    expect(escapeCsvField('a;b', ';')).toBe('"a;b"')
    expect(escapeCsvField('say "hi"', ',')).toBe('"say ""hi"""')
    expect(escapeCsvField('two\nlines', ',')).toBe('"two\nlines"')
    expect(escapeCsvField(' padded ', ',')).toBe('" padded "')
  })

  it('writes CRLF lines from output cells', () => {
    expect(
      csvLine(
        [toOutputCell('Ada', 'text'), toOutputCell(36, 'number'), toOutputCell(null, 'text')],
        ',',
      ),
    ).toBe('Ada,36,\r\n')
  })

  it('round-trips any table through write then parse (property)', async () => {
    const cell = fc.string({ unit: 'binary', maxLength: 20 }).filter((s) => !s.includes('﻿'))
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(cell, { minLength: 2, maxLength: 4 }), { minLength: 1, maxLength: 5 }),
        fc.constantFrom<CsvDelimiter>(',', ';', '\t', '|'),
        fc.integer({ min: 1, max: 17 }),
        async (table, delimiter, size) => {
          const width = table[0]?.length ?? 2
          const rows = table.map((r) =>
            [...r.slice(0, width), ...Array(width).fill('x')].slice(0, width),
          )
          // Lone surrogates cannot be encoded as UTF-8; the parser would rightly refuse them.
          const clean = rows.map((r) => r.map((c) => c.toWellFormed()))
          const text = clean
            .map((r) => `${r.map((c) => `"${c.replaceAll('"', '""')}"`).join(delimiter)}\r\n`)
            .join('')
          const parsed = await all(parseCsv(chunks(text, size), { limits, delimiter }))
          expect(parsed.map((p) => p.cells)).toEqual(clean)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('never throws anything but an ImportExportError on random bytes (fuzz)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 300 }),
        fc.integer({ min: 1, max: 9 }),
        async (bytes, size) => {
          try {
            await all(
              parseCsv(chunks(bytes, size), {
                limits: { ...limits, maxCellChars: 50, maxColumns: 20 },
              }),
            )
          } catch (error) {
            expect(isImportExportError(error)).toBe(true)
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})
