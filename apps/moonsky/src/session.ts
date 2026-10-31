import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEY_LENGTH = 64
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derived) => {
      if (error) reject(error)
      else resolve(derived)
    })
  })
}

/** scrypt with a per-password salt — zero external dependencies. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  const hash = await derive(password, salt)
  return `${salt}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, expectedHex] = stored.split('$')
  if (!salt || !expectedHex) return false
  const expected = Buffer.from(expectedHex, 'hex')
  if (expected.length !== SCRYPT_KEY_LENGTH) return false
  const candidate = await derive(password, salt)
  return timingSafeEqual(candidate, expected)
}

export function newSessionToken(): string {
  return randomBytes(32).toString('hex')
}

/** Sessions are stored as SHA-256 digests; the token itself never reaches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
