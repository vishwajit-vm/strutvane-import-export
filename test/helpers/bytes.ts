/**
 * Test helpers for byte sources: text or bytes as an async iterable, split into chunks of a given
 * size (so every parser is exercised across chunk boundaries), and collection back to bytes.
 */
import type { ByteSource } from '../../src/source.ts'

const encoder = new TextEncoder()

/** Bytes as an async iterable of `size`-byte chunks. */
export async function* chunks(input: string | Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  for (let i = 0; i < bytes.length; i += size)
    yield bytes.subarray(i, Math.min(bytes.length, i + size))
}

/** A re-openable source over fixed content. */
export function sourceOf(input: string | Uint8Array, size = 4096): ByteSource {
  return () => chunks(input, size)
}

/** Collect an async iterable of chunks into one buffer. */
export async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const chunk of stream)
    parts.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
  return Buffer.concat(parts)
}

/** Collect every item of an async iterable. */
export async function all<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}
