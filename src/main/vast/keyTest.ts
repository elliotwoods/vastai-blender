/**
 * Settings → Vast.ai API's key test: which of the permission groups the app
 * needs (VastPermission) the saved key has. Each is tried with a read-only
 * call that needs it; instance_write has none (renting or destroying is the
 * only test), so it is reported untested rather than guessed.
 *
 * A key that Vast rejects outright (401) fails every group the same way, so
 * the one-line message says that rather than listing four failures.
 */

import { classify } from '../errors'
import type { VastKeyTest, VastPermission, VastPermissionCheck } from '../../shared/models'
import type { VastUser } from './types'
import { currentUser, listInstances, listSshKeys, searchOffers } from './vastClient'

export async function testVastKey(): Promise<VastKeyTest> {
  let user: VastUser | null = null
  const tried: Array<[VastPermission, () => Promise<unknown>]> = [
    ['user_read', async () => (user = await currentUser())],
    ['instance_read', () => Promise.all([listInstances(), listSshKeys()])],
    ['misc', () => searchOffers({ limit: 1, rentable: { eq: true } })]
  ]
  const results = await Promise.allSettled(tried.map(([, call]) => call()))
  const checks: VastPermissionCheck[] = results.map((r, i) => ({
    perm: tried[i][0],
    ok: r.status === 'fulfilled',
    detail: r.status === 'fulfilled' ? 'ok' : classify(r.reason, { via: 'vast' }).reason
  }))
  checks.push({
    perm: 'instance_write',
    ok: null,
    detail: 'not tested — needed to rent and destroy nodes'
  })

  const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []))
  const ok = failed.length === 0
  let message: string
  if (user) {
    const u: VastUser = user
    const credit = u.credit ?? u.balance
    message = `account ${u.email ?? u.user ?? u.id}${credit != null ? `, credit $${Number(credit).toFixed(2)}` : ''}`
    if (!ok) message += ' — but the key is missing permissions below'
  } else {
    message = failed.length > 0 ? classify(failed[0], { via: 'vast' }).reason : 'no reply'
  }
  return { ok, message, checks }
}
