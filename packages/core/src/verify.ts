import { createHash, timingSafeEqual } from 'node:crypto'

/** Compare provider secret tokens without revealing the first differing byte. */
export function verifySecretToken(received: string | undefined, expected: string | undefined): boolean {
  if (typeof received !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  if (received.length === 0 || received.length > 256 || expected.length > 256) return false

  // Hashing gives timingSafeEqual fixed-length inputs even when token lengths differ.
  const receivedDigest = createHash('sha256').update(received, 'utf8').digest()
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(receivedDigest, expectedDigest)
}
