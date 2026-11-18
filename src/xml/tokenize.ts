/**
 * A small, streaming, **DTD-free** XML tokenizer for the parts of an XLSX workbook.
 *
 * Why not a general XML parser: the classic XML attacks need a document type definition. XXE
 * (external entities that read files or call URLs) and "billion laughs" (entities that expand
 * exponentially) both live in `<!DOCTYPE …>` / `<!ENTITY …>`. Office Open XML never uses a DTD, so
 * this tokenizer refuses any document that contains one (`unsafe_file`), and it only knows the
 * five predefined entities and numeric character references. There is nothing to expand and
 * nothing to fetch, whatever the file says.
 *
 * It is a pull tokenizer over text chunks: memory is bounded by one tag (`maxTagChars`) plus the
 * current text run, never by the document. Element and attribute names are reduced to their local
 * part (`x:row` → `row`, `r:id` → `id`), because generators differ in the prefixes they use.
 *
 * @module
 */
import { ImportExportError } from '../errors.ts'

/** A start tag (with `selfClosing` for `<x/>`), an end tag, or a run of text. */
export type XmlEvent =
  | {
      readonly kind: 'open'
      readonly name: string
      readonly attrs: ReadonlyMap<string, string>
      readonly selfClosing: boolean
    }
  | { readonly kind: 'close'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string }

/** The longest tag (or comment, processing instruction, CDATA section) accepted. */
export const MAX_TAG_CHARS: number = 64 * 1024

const unsafe = (reason: string): ImportExportError =>
  new ImportExportError('unsafe_file', { params: { reason } })
const malformed = (reason: string): ImportExportError =>
  new ImportExportError('malformed_file', { params: { reason } })

/** The local part of a qualified name. */
function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon === -1 ? name : name.slice(colon + 1)
}

const PREDEFINED: ReadonlyMap<string, string> = new Map([
  ['lt', '<'],
  ['gt', '>'],
  ['amp', '&'],
  ['quot', '"'],
  ['apos', "'"],
])

/**
 * Decode the predefined entities and numeric character references. Anything else is an error:
 * without a DTD no other entity can be defined, so an unknown one is either broken or hostile.
 *
 * @example
 * decodeEntities('a &amp; b &#65;') // 'a & b A'
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&([^;&\s]{0,32});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x')
        ? Number.parseInt(body.slice(2), 16)
        : Number(body.slice(1))
      if (
        !Number.isInteger(code) ||
        code < 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        throw malformed(`invalid character reference ${whole}`)
      return String.fromCodePoint(code)
    }
    const value = PREDEFINED.get(body)
    if (value === undefined) throw unsafe(`undeclared entity ${whole}`)
    return value
  })
}

function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>()
  const pattern = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let consumed = 0
  for (const match of source.matchAll(pattern)) {
    const between = source.slice(consumed, match.index)
    if (between.trim() !== '') throw malformed('invalid attribute syntax')
    consumed = match.index + match[0].length
    const name = match[1] ?? ''
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue
    if (name.includes('<')) throw malformed('invalid attribute name')
    const raw = match[2] ?? match[3] ?? ''
    if (raw.includes('<')) throw malformed('"<" inside an attribute value')
    attrs.set(localName(name), decodeEntities(raw))
  }
  if (source.slice(consumed).trim() !== '') throw malformed('invalid attribute syntax')
  return attrs
}

/**
 * The streaming tokenizer. Feed text with {@link XmlTokenizer.push}, then call
 * {@link XmlTokenizer.end}; both return the events completed so far.
 *
 * @example
 * const t = new XmlTokenizer()
 * t.push('<row r="1"><c><v>4')  // [open row, open c, open v]
 * t.push('2</v></c></row>')       // [text '42', close v, close c, close row]
 * t.end()
 */
export class XmlTokenizer {
  #buffer = ''
  #depth = 0
  #ended = false

  /**
   * Add text; returns every complete event. A tag cut by the chunk boundary waits for the next
   * chunk. Text is emitted as soon as it is safe (not ending inside an entity).
   */
  push(chunk: string): XmlEvent[] {
    if (this.#ended) throw new Error('XmlTokenizer: push() after end()')
    this.#buffer += chunk
    return this.#drain(false)
  }

  /** Finish: everything must be complete and every element closed. */
  end(): XmlEvent[] {
    const events = this.#drain(true)
    this.#ended = true
    if (this.#buffer.trim() !== '') throw malformed('unexpected end of document')
    if (this.#depth !== 0) throw malformed('unclosed element')
    return events
  }

  #drain(final: boolean): XmlEvent[] {
    const events: XmlEvent[] = []
    let buffer = this.#buffer
    let pos = 0
    while (pos < buffer.length) {
      const lt = buffer.indexOf('<', pos)
      if (lt === -1) {
        // Text up to the end, minus a possibly cut entity.
        let end = buffer.length
        if (!final) {
          const amp = buffer.lastIndexOf('&')
          if (amp >= pos && !buffer.includes(';', amp)) end = amp
        }
        if (end > pos) this.#text(buffer.slice(pos, end), events)
        pos = end
        break
      }
      if (lt > pos) this.#text(buffer.slice(pos, lt), events)
      pos = lt
      const consumed = this.#markup(buffer, pos, events)
      if (consumed === 0) {
        if (buffer.length - pos > MAX_TAG_CHARS) throw unsafe('a tag longer than 64 KiB')
        break // incomplete markup: wait for more input
      }
      pos += consumed
    }
    buffer = buffer.slice(pos)
    this.#buffer = buffer
    return events
  }

  #text(raw: string, events: XmlEvent[]): void {
    if (this.#depth === 0) {
      if (raw.trim() !== '') throw malformed('text outside the root element')
      return
    }
    const text = decodeEntities(raw)
    if (text !== '') events.push({ kind: 'text', text })
  }

  /** Handle the markup at `pos`; returns the characters consumed, or 0 when incomplete. */
  #markup(buffer: string, pos: number, events: XmlEvent[]): number {
    const rest = (prefix: string): boolean => buffer.startsWith(prefix, pos)
    if (rest('<!--')) {
      const end = buffer.indexOf('-->', pos + 4)
      return end === -1 ? 0 : end + 3 - pos
    }
    if (rest('<![CDATA[')) {
      const end = buffer.indexOf(']]>', pos + 9)
      if (end === -1) return 0
      if (this.#depth === 0) throw malformed('CDATA outside the root element')
      const text = buffer.slice(pos + 9, end)
      if (text !== '') events.push({ kind: 'text', text })
      return end + 3 - pos
    }
    if (rest('<!')) {
      // A chunk may end inside "<!--" or "<![CDATA[": wait for the rest before deciding.
      const head = buffer.slice(pos)
      if ('<!--'.startsWith(head) || '<![CDATA['.startsWith(head)) return 0
      // <!DOCTYPE, <!ENTITY, <!ELEMENT, <!ATTLIST: a DTD. Never accepted (XXE, billion laughs).
      throw unsafe('a document type definition (DOCTYPE/ENTITY) is not allowed')
    }
    if (rest('<?')) {
      const end = buffer.indexOf('?>', pos + 2)
      return end === -1 ? 0 : end + 2 - pos
    }
    const end = tagEnd(buffer, pos + 1)
    if (end === -1) return 0
    const inner = buffer.slice(pos + 1, end)
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim()
      if (name === '' || /\s/.test(name)) throw malformed('invalid end tag')
      this.#depth--
      if (this.#depth < 0) throw malformed('end tag without a start tag')
      events.push({ kind: 'close', name: localName(name) })
      return end + 1 - pos
    }
    const selfClosing = inner.endsWith('/')
    const body = selfClosing ? inner.slice(0, -1) : inner
    const match = /^([^\s/>]+)/.exec(body)
    if (match === null) throw malformed('invalid start tag')
    const qualified = match[1] ?? ''
    const attrs = parseAttributes(body.slice(qualified.length))
    if (!selfClosing) this.#depth++
    events.push({ kind: 'open', name: localName(qualified), attrs, selfClosing })
    return end + 1 - pos
  }
}

/** The index of the `>` that ends the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(buffer: string, from: number): number {
  let quote = ''
  for (let i = from; i < buffer.length; i++) {
    const ch = buffer.charAt(i)
    if (quote !== '') {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '>') return i
    else if (ch === '<') throw malformed('"<" inside a tag')
  }
  return -1
}
