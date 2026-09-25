import { beforeEach, describe, expect, it, vi } from 'vitest'

const vast = {
  currentUser: vi.fn(),
  listInstances: vi.fn(),
  listSshKeys: vi.fn(),
  searchOffers: vi.fn()
}
vi.mock('./vastClient', () => vast)

const { testVastKey } = await import('./keyTest')

/** What vastClient throws for an HTTP error, as far as classify reads it. */
const httpError = (path: string, status: number): Error =>
  Object.assign(new Error(`vast.ai GET ${path} → ${status}: {"msg":"nope"}`), {
    name: 'VastError',
    status
  })

beforeEach(() => {
  vast.currentUser.mockResolvedValue({ id: 7, email: 'a@b.c', credit: 12.5 })
  vast.listInstances.mockResolvedValue([])
  vast.listSshKeys.mockResolvedValue([])
  vast.searchOffers.mockResolvedValue([])
})

describe('testVastKey', () => {
  it('passes a key with every readable permission, instance_write untested', async () => {
    const r = await testVastKey()
    expect(r.ok).toBe(true)
    expect(r.message).toBe('account a@b.c, credit $12.50')
    expect(r.checks.map((c) => [c.perm, c.ok])).toEqual([
      ['user_read', true],
      ['instance_read', true],
      ['misc', true],
      ['instance_write', null]
    ])
  })

  it('names the group a restricted key lacks, and still shows the account', async () => {
    vast.searchOffers.mockRejectedValue(httpError('/bundles/', 403))
    const r = await testVastKey()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/^account a@b\.c.*missing permissions/)
    const misc = r.checks.find((c) => c.perm === 'misc')!
    expect(misc.ok).toBe(false)
    expect(misc.detail).toMatch(/lacks a permission/)
  })

  it('says a rejected key is invalid or revoked', async () => {
    for (const f of Object.values(vast)) f.mockRejectedValue(httpError('/x/', 401))
    const r = await testVastKey()
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/invalid or revoked/)
    expect(r.checks.filter((c) => c.ok === false)).toHaveLength(3)
  })
})
