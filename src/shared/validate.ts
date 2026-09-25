/**
 * Tiny validators for values whose type is known on paper only: IPC
 * arguments, HTTP request bodies (main/api) and JSON files. No dependencies,
 * so main, the renderer and tests can all use them.
 *
 * A validator takes the value and where it is (`path`, for the message) and
 * returns it typed, or throws ValidationError naming what is wrong. Compose
 * them: `object({ jobId: id(), before: nullable(id()) })`.
 *
 *   const args = tuple([id(), boolean()])(raw, 'job:setShareNode')
 */

export class ValidationError extends Error {
  override readonly name = 'ValidationError'

  constructor(
    readonly path: string,
    readonly problem: string
  ) {
    super(path ? `${path} ${problem}` : problem)
  }
}

export type Validator<T> = (value: unknown, path: string) => T

/** What a validator returns. */
export type Validated<V> = V extends Validator<infer T> ? T : never

const CONTROL = /[\u0000-\u001f\u007f]/ // eslint-disable-line no-control-regex

/** A short, safe rendering of a value for a message. */
export function showValue(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v)
  if (v === undefined) return 'nothing'
  if (typeof v === 'object' && v !== null) return Array.isArray(v) ? 'a list' : 'an object'
  return String(v)
}

function fail(path: string, problem: string): never {
  throw new ValidationError(path, problem)
}

export interface StringOptions {
  /** Longest allowed, in characters (default 4096). */
  max?: number
  /** Shortest allowed (default 1: the empty string is refused). */
  min?: number
  /** Allow control characters (default no). */
  control?: boolean
  pattern?: RegExp
  /** The phrase after "must be" when `pattern` does not match. */
  patternText?: string
}

export function string(opts: StringOptions = {}): Validator<string> {
  const { max = 4096, min = 1 } = opts
  return (v, path) => {
    if (typeof v !== 'string') fail(path, `must be a string (got ${showValue(v)})`)
    if (v.length < min)
      fail(path, min === 1 ? 'must not be empty' : `must be at least ${min} characters`)
    if (v.length > max) fail(path, `must be at most ${max} characters`)
    if (!opts.control && CONTROL.test(v)) fail(path, 'must not contain control characters')
    if (opts.pattern && !opts.pattern.test(v)) {
      fail(path, `must be ${opts.patternText ?? `like ${opts.pattern}`} (got ${showValue(v)})`)
    }
    return v
  }
}

/** A job, node or chunk id: letters, digits, '-', '_' and '.', at most 128. */
export function id(): Validator<string> {
  return string({ max: 128, pattern: /^[A-Za-z0-9_.-]+$/, patternText: 'an id' })
}

export function boolean(): Validator<boolean> {
  return (v, path) =>
    typeof v === 'boolean' ? v : fail(path, `must be true or false (got ${showValue(v)})`)
}

export interface NumberOptions {
  min?: number
  max?: number
  integer?: boolean
}

export function number(opts: NumberOptions = {}): Validator<number> {
  return (v, path) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      fail(path, `must be a number (got ${showValue(v)})`)
    }
    if (opts.integer && !Number.isInteger(v)) fail(path, `must be a whole number (got ${v})`)
    if (opts.min !== undefined && v < opts.min)
      fail(path, `must be at least ${opts.min} (got ${v})`)
    if (opts.max !== undefined && v > opts.max) fail(path, `must be at most ${opts.max} (got ${v})`)
    return v
  }
}

export function integer(opts: Omit<NumberOptions, 'integer'> = {}): Validator<number> {
  return number({ ...opts, integer: true })
}

export function oneOf<T extends string>(values: readonly T[]): Validator<T> {
  return (v, path) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? (v as T)
      : fail(path, `must be one of ${values.join(', ')} (got ${showValue(v)})`)
}

export function nullable<T>(inner: Validator<T>): Validator<T | null> {
  return (v, path) => (v === null ? null : inner(v, path))
}

export function optional<T>(inner: Validator<T>): Validator<T | undefined> {
  return (v, path) => (v === undefined ? undefined : inner(v, path))
}

export function array<T>(inner: Validator<T>, opts: { max?: number } = {}): Validator<T[]> {
  const max = opts.max ?? 10_000
  return (v, path) => {
    if (!Array.isArray(v)) fail(path, `must be a list (got ${showValue(v)})`)
    if (v.length > max) fail(path, `must have at most ${max} entries`)
    return v.map((item, i) => inner(item, `${path}[${i}]`))
  }
}

/** Either validator: the first that passes. The message is the last's. */
export function either<A, B>(a: Validator<A>, b: Validator<B>): Validator<A | B> {
  return (v, path) => {
    try {
      return a(v, path)
    } catch (e) {
      if (!(e instanceof ValidationError)) throw e
      return b(v, path)
    }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type Shape = Record<string, Validator<unknown>>
type ShapeValue<S extends Shape> = { [K in keyof S]: ReturnType<S[K]> }

export interface ObjectOptions {
  /** Keep keys the shape does not name, unchecked (default: refuse them). */
  passthrough?: boolean
}

/**
 * An object with these fields, each through its validator. A field whose
 * validator allows `undefined` may be absent. Unknown keys are refused
 * unless `passthrough`.
 */
export function object<S extends Shape>(
  shape: S,
  opts: ObjectOptions = {}
): Validator<ShapeValue<S>> {
  return (v, path) => {
    if (!isRecord(v)) fail(path, `must be an object (got ${showValue(v)})`)
    const out: Record<string, unknown> = opts.passthrough ? { ...v } : {}
    if (!opts.passthrough) {
      for (const key of Object.keys(v)) {
        if (!Object.prototype.hasOwnProperty.call(shape, key)) {
          fail(path ? `${path}.${key}` : key, 'is not a field this takes')
        }
      }
    }
    for (const key of Object.keys(shape)) {
      const value = shape[key](v[key], path ? `${path}.${key}` : key)
      if (value !== undefined) out[key] = value
      else delete out[key]
    }
    return out as ShapeValue<S>
  }
}

type TupleValue<T extends readonly Validator<unknown>[]> = {
  -readonly [K in keyof T]: T[K] extends Validator<infer U> ? U : never
}

/**
 * An argument list: each position through its validator, and no more
 * arguments than there are validators. A trailing `optional` may be left out.
 */
export function tuple<const T extends readonly Validator<unknown>[]>(
  items: T
): Validator<TupleValue<T>> {
  return (v, path) => {
    if (!Array.isArray(v)) fail(path, `arguments must be a list (got ${showValue(v)})`)
    if (v.length > items.length) {
      fail(path, `takes at most ${items.length} argument(s), got ${v.length}`)
    }
    return items.map((check, i) => check(v[i], `${path}[${i}]`)) as TupleValue<T>
  }
}
