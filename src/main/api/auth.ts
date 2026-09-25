/**
 * Who may talk to the local API (server.ts), checked on every request before
 * anything else is read:
 *
 * - Origin: any request that carries one is refused (403). A browser adds
 *   Origin to every cross-origin request and to every POST, so a web page the
 *   user visits can never drive the API, even with a "simple" request that
 *   skips the CORS preflight. No CORS header is ever sent. Scripts and the
 *   CLI send no Origin.
 * - Host: must be 127.0.0.1:<port> or localhost:<port> (403). A DNS-rebinding
 *   page reaches 127.0.0.1 under its own host name, and this is where it
 *   stops.
 * - Authorization: `Bearer <token>`, the token in <userData>/api.json (401).
 *   Compared in constant time. The token is 32 random bytes, new on every
 *   start, and is never logged.
 */

import { createHash, randomBytes, timingSafeEqual } from 'crypto'

/** A new API token: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * Does the Authorization header carry `token`? Both sides are hashed first,
 * so timingSafeEqual compares equal lengths and the time taken says nothing
 * about the token, its length included.
 */
export function bearerMatches(header: string | string[] | undefined, token: string): boolean {
  if (typeof header !== 'string' || token === '') return false
  const m = /^Bearer ([A-Za-z0-9_-]{1,512})$/.exec(header.trim())
  if (!m) return false
  const sent = createHash('sha256').update(m[1]).digest()
  const want = createHash('sha256').update(token).digest()
  return timingSafeEqual(sent, want)
}

/** Is `host` (the Host header) this server's own loopback address? */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (typeof host !== 'string') return false
  const h = host.toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

export type Refusal = { status: 401 | 403; code: 'unauthorized' | 'forbidden'; message: string }

/**
 * The refusal for a request's headers, or null to let it through. Origin
 * first, then Host, then the token: a page in a browser is told no before
 * anything about the token is checked.
 */
export function checkRequest(
  headers: { origin?: string; host?: string; authorization?: string | string[] },
  port: number,
  token: string
): Refusal | null {
  if (headers.origin !== undefined) {
    return {
      status: 403,
      code: 'forbidden',
      message: 'requests from web pages are refused (an Origin header was sent)'
    }
  }
  if (!hostAllowed(headers.host, port)) {
    return { status: 403, code: 'forbidden', message: `Host must be 127.0.0.1:${port}` }
  }
  if (!bearerMatches(headers.authorization, token)) {
    return {
      status: 401,
      code: 'unauthorized',
      message: 'missing or wrong token: send Authorization: Bearer <token from api.json>'
    }
  }
  return null
}
