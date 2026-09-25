import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OctaneState, SettingsPublic } from '../../shared/models'
import type { CreateInstanceOptions } from '../vast/vastClient'
import { fakeOctane } from '../test/fakeOctane'
import { setup, type AgentSpec, type App, type World } from '../test/harness'

// Plan 1.18 on the lifecycle harness: a node's Octane state as the fleet
// sees it (NodeSnapshot.octaneState, kept from setup_octane.sh's lines), the
// licence poll that notices a sign-in made by hand on the node's desktop,
// and the first Octane chunk on a new node, which waits for that sign-in
// rather than rendering unlicensed (#85) or failing at once. By default no
// OTOY credential is sent anywhere (#40 #156).

let w: World
beforeEach(async () => {
  w = await setup({
    settings: { maxActiveNodes: 1 },
    secrets: { vastApiKey: 'k', otoyUsername: 'artist@example.com', otoyPassword: 'hunter2' }
  })
})
afterEach(() => w.dispose())

const SEC = 1_000
const MIN = 60 * SEC

function octaneStates(nodeId: string): Array<OctaneState | undefined> {
  return w
    .eventsOf('node:changed')
    .filter((s) => s.id === nodeId)
    .map((s) => s.octaneState)
    .filter((s, i, all) => i === 0 || s !== all[i - 1])
}

describe('1.18: Octane on a node, as the fleet sees it', () => {
  it('1.18: the first Octane chunk on a new node waits for the sign-in by hand, and renders once it is made', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => {
      specs.push(spec)
      machine.agent.finish(spec.chunkId)
    }
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()

    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'needsLogin',
      'needs a sign-in',
      { timeoutMs: 3 * MIN }
    )
    const snap = app.nodeManager.get(nodeId)!.snapshot
    expect(snap).toMatchObject({ octaneReady: false, octaneNeedsManualLogin: true })
    expect(w.alerts('warn')).toEqual([
      expect.stringMatching(/^Octane on RTX 4090 \w{8} is waiting for a sign-in: .*Open VNC login/)
    ])
    await w.advance(2 * MIN)
    expect(specs).toEqual([])

    // The user signs in on the node's desktop.
    octane.state = 'licensed'
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete',
      { timeoutMs: 2 * MIN }
    )
    expect(specs.map((s) => s.engine)).toEqual(['octane'])
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'licensed',
      octaneReady: true,
      octaneNeedsManualLogin: false
    })
    expect(octaneStates(nodeId)).toEqual(['none', 'serverRunning', 'needsLogin', 'licensed'])
    expect(w.alerts('info')).toContain(
      `Octane on RTX 4090 ${nodeId.slice(0, 8)} is signed in: its Octane chunks can render`
    )
    expect(octane.launches).toBe(1)
    // The sign-in was by hand: no credential went anywhere.
    expect(machine.ran(/hunter2|artist@|OCTANE_USER|OCTANE_PASS|--credentials-stdin/)).toEqual([])
  })

  it('1.18: the licence poll notices a sign-in made outside any dispatch, and a server that died', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    octane.state = 'serverRunning'
    w.db.prepare(`UPDATE nodes SET octane_state = 'needsLogin' WHERE id = ?`).run(nodeId)

    octane.state = 'licensed'
    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'licensed',
      'licensed by the poll',
      { timeoutMs: 45 * SEC }
    )
    expect(w.eventsOf('node:changed').at(-1)).toMatchObject({ id: nodeId, octaneReady: true })

    octane.state = 'none'
    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'none',
      'none once the server died',
      { timeoutMs: 45 * SEC }
    )
    expect(app.nodeManager.get(nodeId)!.snapshot.octaneReady).toBe(false)
    // And from then on it is not polled: nothing of Octane runs there.
    const reads = machine.ran(/setup_octane\.sh status/).length
    await w.advance(2 * MIN)
    expect(machine.ran(/setup_octane\.sh status/)).toHaveLength(reads)
  })

  it('1.18 (A1): an Octane job whose sign-in nobody makes keeps no node billing past the wait and the idle timeout, and rents none in its place', async () => {
    // Signed in by hand, the default, and the user away (overnight). The
    // report's first handoff gave such a chunk back uncharged and unheld:
    // pending for ever, it kept every idle node billing, or, with the node
    // unfit, had it let go and another rented for another wait, with no end.
    w.settings.dockerImageByEngine = { octane: 'otoy/octane-blender:2025.2' }
    const app = await w.boot()
    const lic = await import('../octane/octaneLicense')
    const { holdsInstance } = await import('../../shared/nodeState')
    const nodeId = await w.readyNode(app)
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    const specs: AgentSpec[] = []
    machine.onSpec = (spec) => specs.push(spec)
    const jobId = await w.submitJob(app, {
      engine: 'octane',
      frameStart: 1,
      frameEnd: 3,
      chunkSize: 1
    })
    const t0 = Date.now()
    app.scheduler.kick()

    // The licence wait, the one wait for a sign-in, and the idle timeout,
    // plus five minutes: the scheduler as it stands charges each chunk's
    // render retries, one dispatch per tick, before its job fails. Holding
    // the job on the first OctaneLoginNeededError (the corrected handoff)
    // takes that out.
    const bound =
      lic.OCTANE_LICENSE_WAIT_MS +
      lic.OCTANE_LOGIN_WAIT_MS +
      w.settings.idleTimeoutMinutes * MIN +
      5 * MIN
    await w.until(
      () =>
        w.get<{ destroyed_at: number | null }>(
          'SELECT destroyed_at FROM nodes WHERE id = ?',
          nodeId
        )?.destroyed_at != null,
      'the node let go',
      { timeoutMs: bound }
    )
    expect(Date.now() - t0).toBeLessThanOrEqual(bound)
    expect(lic.octaneSignInHold()).toMatchObject({ nodeId })

    // Nothing in its place, then or later, and nothing billing.
    await w.advance(30 * MIN)
    expect(w.vast.count('createInstance')).toBe(1)
    expect(app.nodeManager.list().filter((n) => holdsInstance(n))).toEqual([])
    // Scale-up for Octane, once it names the engine, rents nothing either,
    // and does not even search.
    const searches = w.vast.count('searchOffers')
    w.vast.addOffer()
    expect(await app.nodeManager.requestNodes(1, { engine: 'octane' })).toEqual([])
    expect(w.vast.count('searchOffers')).toBe(searches)
    // The job keeps no chunk queued for a node: it waits on the user, or
    // its chunks failed.
    const { attention } = w.get<{ attention: string | null }>(
      'SELECT attention FROM jobs WHERE id = ?',
      jobId
    )!
    const queued = w.all(
      "SELECT id FROM chunks WHERE job_id = ? AND state NOT IN ('failed', 'complete')",
      jobId
    )
    expect(attention != null || queued.length === 0).toBe(true)
    // One wait, one server, nothing rendered unlicensed.
    expect(octane.launches).toBe(1)
    expect(specs).toEqual([])
  })

  it('1.18 (review 2, A1): a node signed in before a sign-in is missed does not end the hold, and nothing is rented for the next wait', async () => {
    // The likely A1 night: the user signs one node in, then leaves. The node
    // rented next waits for a sign-in nobody makes, and is let go idle. The
    // licence poll's reads of the first node, licensed all along, used to
    // end the hold within 30 s, and the node rented in the second's place
    // waited its 10 minutes too, and so on while work was pending.
    Object.assign(w.settings, {
      maxActiveNodes: 3,
      spendCapPerHour: null,
      noSpendCap: true,
      idleTimeoutMinutes: 24 * 60,
      dockerImageByEngine: { octane: 'otoy/octane-blender:2025.2' }
    })
    const app = await w.boot()
    const lic = await import('../octane/octaneLicense')
    const a = await w.readyNode(app)
    fakeOctane(w.machineFor(a), { signIn: 'byHand' }).state = 'licensed'
    await expect(lic.setupOctane(app.nodeManager.get(a)!.ssh!, a)).resolves.toBe('licensed')

    const b = await w.readyNode(app)
    fakeOctane(w.machineFor(b), { signIn: 'byHand' })
    const missed = lic.setupOctane(app.nodeManager.get(b)!.ssh!, b).catch((e: unknown) => e)
    await w.advance(lic.OCTANE_LICENSE_WAIT_MS + lic.OCTANE_LOGIN_WAIT_MS + 10 * SEC)
    expect(await missed).toBeInstanceOf(lic.OctaneLoginNeededError)
    const hold = lic.octaneSignInHold()
    expect(hold).toMatchObject({ nodeId: b })

    // B is let go; the licence poll reads A, licensed as it was, on and on.
    await app.nodeManager.destroyNode(b)
    const reads = w.machineFor(a).ran(/setup_octane\.sh status/).length
    await w.advance(2 * MIN)
    expect(w.machineFor(a).ran(/setup_octane\.sh status/).length).toBeGreaterThan(reads + 2)
    expect(app.nodeManager.get(a)!.snapshot.octaneState).toBe('licensed')
    expect(lic.octaneSignInHold()).toEqual(hold)

    // Scale-up for Octane rents nothing in B's place, and does not search.
    const searches = w.vast.count('searchOffers')
    w.vast.addOffer()
    expect(await app.nodeManager.requestNodes(1, { engine: 'octane' })).toEqual([])
    expect(w.vast.count('searchOffers')).toBe(searches)
    expect(w.vast.count('createInstance')).toBe(2)
  })

  it('1.18: a node that never ran Octane is never asked about it', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    await w.advance(3 * MIN)
    expect(w.machineFor(nodeId).ran(/setup_octane/)).toEqual([])
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'none',
      octaneReady: false,
      octaneNeedsManualLogin: false
    })
  })

  it('1.18 (#85): a row an older build marked octane_ready is not taken for a licence', async () => {
    const app = await w.boot()
    const nodeId = await w.readyNode(app)
    w.db.prepare(`UPDATE nodes SET octane_ready = 1 WHERE id = ?`).run(nodeId)
    expect(app.nodeManager.get(nodeId)!.snapshot).toMatchObject({
      octaneState: 'none',
      octaneReady: false
    })
  })
})

describe('1.18 (review): the scripted sign-in, under secure cloud only', () => {
  const OCTANE_IMAGE = 'otoy/octane-blender:2025.2'

  async function renderOctaneOn(app: App, nodeId: string): Promise<void> {
    w.machineFor(nodeId).onSpec = (spec) => w.machineFor(nodeId).agent.finish(spec.chunkId)
    const jobId = await w.submitJob(app, { engine: 'octane' })
    app.scheduler.kick()
    await w.until(
      () =>
        w.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', jobId)?.state ===
        'complete',
      'job complete',
      { timeoutMs: 5 * MIN }
    )
  }

  it('1.18 (review): an Octane chunk that reaches a node not rented through the filter sends it no credential', async () => {
    Object.assign(w.settings, { octane: { scriptedSignIn: true, secureCloudOnly: true } })
    const app = await w.boot()
    const nm = await import('./nodeManager')
    // Rented with no engine, as scale-up rents today: any host could take it.
    const nodeId = await w.readyNode(app, { datacenter: false } as never)
    expect(app.nodeManager.rentalOf(nodeId)).toEqual({
      engine: null,
      image: nm.DOCKER_IMAGE,
      secureCloud: false
    })
    const machine = w.machineFor(nodeId)
    const octane = fakeOctane(machine, { signIn: 'byHand' })
    const done = renderOctaneOn(app, nodeId)
    await w.until(
      () => app.nodeManager.get(nodeId)?.snapshot.octaneState === 'needsLogin',
      'needs a sign-in',
      { timeoutMs: 3 * MIN }
    )
    expect(w.alerts('warn')).toEqual([
      expect.stringMatching(
        /waiting for a sign-in: .* The scripted sign-in was not used: this node was not rented as a datacenter/
      )
    ])
    octane.state = 'licensed'
    await done
    expect(machine.ran(/--credentials-stdin|hunter2|artist@|OCTANE_USER|OCTANE_PASS/)).toEqual([])
  })

  it('1.18 (review): a node rented for Octane through the filter gets the scripted sign-in', async () => {
    Object.assign(w.settings, {
      octane: { scriptedSignIn: true, secureCloudOnly: true },
      dockerImageByEngine: { octane: OCTANE_IMAGE }
    })
    const app = await w.boot()
    w.vast.addOffer({ datacenter: true } as never)
    const [nodeId] = await app.nodeManager.requestNodes(1, { engine: 'octane' })
    await w.until(() => app.nodeManager.get(nodeId)?.state === 'ready', 'ready')
    expect(app.nodeManager.rentalOf(nodeId)).toEqual({
      engine: 'octane',
      image: OCTANE_IMAGE,
      secureCloud: true
    })
    const machine = w.machineFor(nodeId)
    fakeOctane(machine)
    await renderOctaneOn(app, nodeId)
    expect(machine.ran(/setup_octane\.sh start-server --credentials-stdin$/)).toHaveLength(1)
    expect(w.alerts('warn')).toEqual([])
  })
})

describe('1.18: renting for Octane', () => {
  const OCTANE_IMAGE = 'otoy/octane-blender:2025.2'

  function images(): string[] {
    return w.vast.argsOf('createInstance').map((a) => (a[0] as CreateInstanceOptions).image)
  }

  function octaneSettings(o: Partial<SettingsPublic>): void {
    Object.assign(w.settings, {
      maxActiveNodes: 4,
      dockerImageByEngine: { octane: OCTANE_IMAGE },
      ...o
    })
  }

  it('1.18 (review, A1): signed in by hand, scale-up rents Octane nodes no faster than they are signed in', async () => {
    const app = await w.boot()
    octaneSettings({ maxActiveNodes: 8, spendCapPerHour: null, noSpendCap: true })
    for (let i = 0; i < 8; i++) w.vast.addOffer()
    const octaneIds = (): string[] =>
      w
        .all<{ id: string }>('SELECT id FROM nodes ORDER BY rowid')
        .map((r) => r.id)
        .filter((id) => app.nodeManager.rentalOf(id)?.engine === 'octane')

    // Nobody is known to be at a desktop: one node, for the user to sign in.
    expect(await app.nodeManager.requestNodes(3, { engine: 'octane' })).toHaveLength(1)
    const [first] = octaneIds()
    // While it waits, no other: nothing searched, nothing rented.
    const searches = w.vast.count('searchOffers')
    expect(await app.nodeManager.requestNodes(3, { engine: 'octane' })).toEqual([])
    expect(w.vast.count('searchOffers')).toBe(searches)
    // Other engines are not held by it.
    expect(await app.nodeManager.requestNodes(1, { engine: 'cycles' })).toHaveLength(1)

    // Signed in: one more may wait beside it, and no more.
    w.db.prepare(`UPDATE nodes SET octane_state = 'licensed' WHERE id = ?`).run(first)
    expect(await app.nodeManager.requestNodes(3, { engine: 'octane' })).toHaveLength(1)
    expect(await app.nodeManager.requestNodes(3, { engine: 'octane' })).toEqual([])
    // The Fleet's own request is the user, there to sign it in.
    await app.nodeManager.requestNode({ engine: 'octane' })
    expect(octaneIds()).toHaveLength(3)

    // A scripted sign-in waits on nobody: the caps alone.
    w.settings.octane = { scriptedSignIn: true, secureCloudOnly: false }
    expect(await app.nodeManager.requestNodes(2, { engine: 'octane' })).toHaveLength(2)
    expect(octaneIds()).toHaveLength(5)
  })

  it('1.18: each engine rents with its own docker image; one with none set, the built-in', async () => {
    const app = await w.boot()
    const nm = await import('./nodeManager')
    octaneSettings({ dockerImageByEngine: { octane: OCTANE_IMAGE } })
    w.vast.addOffer()
    w.vast.addOffer()
    w.vast.addOffer()
    await app.nodeManager.requestNodes(1, { engine: 'octane' })
    await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    await app.nodeManager.requestNode({ engine: 'octane' })
    expect(images()).toEqual([OCTANE_IMAGE, nm.DOCKER_IMAGE, OCTANE_IMAGE])
  })

  it('1.18: an image that is not an image name rents nothing, rather than a refusal per machine', async () => {
    const app = await w.boot()
    octaneSettings({ dockerImageByEngine: { octane: 'otoy/octane; rm -rf /' } })
    w.vast.addOffer()
    await expect(app.nodeManager.requestNodes(1, { engine: 'octane' })).rejects.toThrow(
      /docker image set for octane nodes is not an image name/
    )
    expect(w.vast.count('searchOffers')).toBe(0)
    expect(w.vast.count('createInstance')).toBe(0)
    expect(w.all('SELECT id FROM nodes')).toEqual([])
  })

  it('1.18 (review, 1.21): with no image set for Octane nodes, no Octane node is rented from the built-in one, which cannot render it', async () => {
    const app = await w.boot()
    const nm = await import('./nodeManager')
    octaneSettings({ dockerImageByEngine: {} })
    w.vast.addOffer()
    const why = nm.rentalImageProblem(w.settings, 'octane')
    expect(why).toMatch(
      /^no docker image is set for Octane nodes.*Settings → Docker image for Octane/
    )
    await expect(app.nodeManager.requestNodes(1, { engine: 'octane' })).rejects.toThrow(
      `${why}: nothing was rented`
    )
    await expect(app.nodeManager.requestNode({ engine: 'octane' })).rejects.toThrow(why!)
    expect(w.vast.count('searchOffers')).toBe(0)
    expect(w.vast.count('createInstance')).toBe(0)
    // The other engines keep the built-in, and a node with no engine named
    // (the Fleet's request, to install OctaneBlender by hand) too.
    expect(nm.rentalImageProblem(w.settings, 'cycles')).toBeNull()
    expect(nm.rentalImageProblem(w.settings, null)).toBeNull()
    await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    expect(images()).toEqual([nm.DOCKER_IMAGE])
  })

  it('1.18: with secure cloud only, an Octane rental takes a datacenter host and passes over the rest', async () => {
    const app = await w.boot()
    octaneSettings({ octane: { scriptedSignIn: false, secureCloudOnly: true } })
    // The cheapest and best-ranked is someone's own machine.
    const home = w.vast.addOffer({ dph_total: 0.2, datacenter: false } as never)
    const dc = w.vast.addOffer({ dph_total: 0.5, datacenter: true } as never)
    const [id] = await app.nodeManager.requestNodes(1, { engine: 'octane' })
    expect(
      w.vast.argsOf('createInstance').map((a) => (a[0] as CreateInstanceOptions).offerId)
    ).toEqual([dc.id])
    expect(w.get('SELECT dph_total FROM nodes WHERE id = ?', id)).toEqual({ dph_total: 0.5 })
    // Not for Cycles: the home machine is fine there.
    await app.nodeManager.requestNodes(1, { engine: 'cycles' })
    expect(
      w.vast.argsOf('createInstance').map((a) => (a[0] as CreateInstanceOptions).offerId)
    ).toEqual([dc.id, home.id])
  })

  it('1.18: with secure cloud only and no datacenter host on offer, nothing is rented, and the alert says why', async () => {
    const app = await w.boot()
    octaneSettings({
      octane: { scriptedSignIn: false, secureCloudOnly: true },
      spendCapPerHour: null,
      noSpendCap: true
    })
    w.vast.addOffer({ datacenter: false } as never)
    // A reply that does not say is not taken for a datacenter.
    w.vast.addOffer()
    await expect(app.nodeManager.requestNodes(1, { engine: 'octane' })).rejects.toThrow(
      'no matching offers on datacenter (secure cloud) hosts'
    )
    expect(w.vast.count('createInstance')).toBe(0)
    expect(w.alerts('warn')).toEqual([
      'No matching Vast.ai offers on datacenter (secure cloud) hosts, which the Octane settings rent from only'
    ])
    // Under a cap, the reason names both.
    Object.assign(w.settings, { spendCapPerHour: 2, noSpendCap: false })
    await expect(app.nodeManager.requestNodes(1, { engine: 'octane' })).rejects.toThrow(
      /^no matching offers on datacenter \(secure cloud\) hosts at or under \$2\.00\/hr, what the spend cap/
    )
    expect(w.vast.count('createInstance')).toBe(0)
  })
})
