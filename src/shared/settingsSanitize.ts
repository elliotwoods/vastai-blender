/**
 * Settings patch checks, shared by main and the renderer (plan 1.14; #8 #99
 * #112 #159).
 *
 * settings:set used to merge whatever arrived straight into settings.json,
 * and the Settings screen sent a patch on every keystroke. That had four
 * consequences:
 * - Backspacing the spend cap to retype it saved null, which every reader
 *   takes as "no cap".
 * - "1e3" in max active nodes saved 1000.
 * - An emptied idle timeout saved 0, which destroys a node the moment it
 *   goes idle.
 * - blenderVersionOverride reached the node's shell unquoted (provisioner.ts),
 *   where a space or a `;` starts a second command.
 *
 * sanitizeSettingsPatch is the one gate. Plan 1.14 has main put every patch
 * through it before anything is saved: the Settings screen's, the Fleet
 * stepper's, and a VR_JOB_SPEC campaign's. The renderer can run it to
 * explain a field before the field commits. A field that fails is not saved, and the rest of the
 * patch still is, so a bad Blender version does not also lose the cap typed
 * next to it. As in jobValidation, each value is checked as if its type were
 * unknown, because IPC arguments and JSON files are typed on paper only.
 */

import type {
  EngineId,
  OctaneSettings,
  OfferFilters,
  SettingsFieldError,
  SettingsPatchResult,
  SettingsPublic
} from './models'

/** How absolute paths are written on the machine that will use them. */
export type PathFlavour = 'posix' | 'win32'

export interface SanitizeOptions {
  /**
   * Main passes its own: `process.platform === 'win32' ? 'win32' : 'posix'`.
   * Without it, both forms are accepted. That is only good enough for a hint
   * in the renderer: `C:\Renders` is a relative file name on macOS.
   */
  pathFlavour?: PathFlavour
}

interface Limits {
  min: number
  max: number
  integer?: boolean
}

/**
 * The range of every numeric setting. The limits catch typos, not policy: a
 * value within them is taken as meant. A value outside them is saved at the
 * nearest limit, and the patch result says so.
 */
export const SETTINGS_LIMITS = {
  /** The Fleet stepper's ceiling. A headless campaign can ask for 30 or more nodes. */
  maxActiveNodes: { min: 0, max: 64, integer: true },
  /** 0 rents nothing. 1000 is 64 of the dearest 8-GPU offers. */
  spendCapPerHour: { min: 0, max: 1000 },
  /** At 0, a node was destroyed the moment it went idle, prefetched work and all. */
  idleTimeoutMinutes: { min: 1, max: 1440 },
  concurrentTransfersPerNode: { min: 1, max: 16, integer: true },
  /** Even: the node's encoder scales to it, and 4:2:0 video needs an even width. */
  livePreviewWidth: { min: 256, max: 3840, integer: true },
  maxNodeSlots: { min: 0, max: 24, integer: true },
  /** 0 = off, 1, or 2 (MAX_SLOTS_PER_GPU in main's gpuLanes.ts). */
  slotsPerGpu: { min: 0, max: 2, integer: true },
  co2OverheadFactor: { min: 1, max: 3 },
  maxDphTotal: { min: 0, max: 1000 },
  minGpuRamGb: { min: 0, max: 1024 },
  minInetDownMbps: { min: 0, max: 100_000 },
  minReliability: { min: 0, max: 1 },
  /** Disk Vast allocates for every rental, and bills for. */
  minDiskGb: { min: 10, max: 4096 },
  minCpuCores: { min: 0, max: 1024 },
  minNumGpus: { min: 1, max: 16, integer: true },
  /** 0 = a port the OS picks; else an unprivileged port. */
  apiPort: { min: 0, max: 65535, integer: true }
} as const satisfies Record<string, Limits>

/**
 * A Blender release ("4.5.3") or a series ("4.5", which resolves to its
 * newest release). Digits and dots only, because the version goes unquoted
 * into `provision.sh install-blender <version>` on the node, and into a URL
 * and a RegExp (blendInfo.resolveBlenderRelease).
 */
export const BLENDER_VERSION_RE = /^\d{1,2}\.\d{1,2}(?:\.\d{1,3})?$/

// A Docker image reference, after distribution/reference: optional registry
// host (with port), lower-case path components, optional tag and digest.
const IMAGE_HOST =
  '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::\\d{1,5})?'
const IMAGE_PATH = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const DOCKER_IMAGE_RE = new RegExp(
  `^(?:${IMAGE_HOST}/)?${IMAGE_PATH}(?:/${IMAGE_PATH})*` +
    '(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$'
)

/** A well-formed Docker image reference, such as `vastai/base-image:cuda-12.1.1`. */
export function isDockerImage(s: string): boolean {
  return s.length <= 255 && DOCKER_IMAGE_RE.test(s)
}

const CONTROL = /[\u0000-\u001f\u007f]/ // eslint-disable-line no-control-regex

/**
 * Why `p` is not an absolute path on this computer, or null when it is. The
 * phrase follows the name of what it is for: "project root must be …".
 *
 * It must be local. A network share (`\\server\share`, `//server/share`) or
 * a Windows device path (`\\?\…`) is refused. Every job folder and scene path
 * is somewhere the app writes, and may show in the file manager, and a render
 * must not stall on a share that has gone away. It must also have no `.` or
 * `..` segments, so the path means what it says to resolveInside. A job's
 * scene path should meet the same rule (the Phase 0 review of plan 1.14).
 */
export function localPathProblem(p: unknown, flavour?: PathFlavour): string | null {
  if (typeof p !== 'string' || p === '') return 'must be a path'
  if (p.length > 1024) return 'must be at most 1024 characters long'
  if (CONTROL.test(p)) return 'must not contain control characters'
  if (p.trim() !== p) return 'must not start or end with a space'
  if (/^[\\/]{2}/.test(p)) return 'must be on this computer, not a network or device path'
  const drive = /^[A-Za-z]:[\\/]/.test(p)
  const root = p.startsWith('/')
  const absolute = flavour === 'win32' ? drive : flavour === 'posix' ? root : drive || root
  if (!absolute) {
    const example =
      flavour === 'win32'
        ? 'C:\\Renders'
        : flavour === 'posix'
          ? '/Users/you/Renders'
          : '/Users/you/Renders or C:\\Renders'
    return `must be a full path from the top of a disk, such as ${example}`
  }
  const segments = drive ? p.slice(2).split(/[\\/]/) : p.split('/')
  if (segments.some((s) => s === '.' || s === '..')) return "must not contain '.' or '..'"
  // Past the drive, ':' would name an NTFS alternate data stream.
  if (drive && segments.some((s) => /[<>:"|?*]/.test(s))) {
    return 'must not contain any of < > : " | ? *'
  }
  return null
}

// -- the patch ----------------------------------------------------------------

/** A rule's answer when the field keeps its current value. */
const KEEP: unique symbol = Symbol('keep')
type Kept = typeof KEEP

/** What a rule gets besides the value: where to report, and what is there now. */
interface Ctx {
  current: SettingsPublic
  flavour: PathFlavour | undefined
  /** Record that the field was refused; the rule then returns KEEP. */
  reject(message: string): Kept
  /** Record that a value within the limits was saved in place of the one sent. */
  clamp(message: string): void
  /** The same, for a field inside this one: 'offerFilters' → 'offerFilters.minDiskGb'. */
  nested(key: string): Ctx
}

type Rule<T> = (value: unknown, c: Ctx) => T | Kept

/** Up to 40 characters of a value, to quote in a message. */
function show(v: unknown): string {
  const s = typeof v === 'string' ? JSON.stringify(v) : String(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key)
}

function numberRule(label: string, lim: Limits): Rule<number> {
  return (v, c) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return c.reject(`${label} must be a number (got ${show(v)})`)
    }
    if (lim.integer && !Number.isInteger(v)) {
      return c.reject(`${label} must be a whole number (got ${v})`)
    }
    if (v < lim.min) {
      c.clamp(`${label} can't be below ${lim.min}, so ${lim.min} was saved (got ${v})`)
      return lim.min
    }
    if (v > lim.max) {
      c.clamp(`${label} can be at most ${lim.max}, so ${lim.max} was saved (got ${v})`)
      return lim.max
    }
    return v
  }
}

/** A number, or null for "none" (a blank field that really does mean none). */
function optionalNumberRule(label: string, lim: Limits): Rule<number | null> {
  const n = numberRule(label, lim)
  return (v, c) => (v === null || v === '' ? null : n(v, c))
}

function booleanRule(label: string): Rule<boolean> {
  return (v, c) =>
    typeof v === 'boolean' ? v : c.reject(`${label} must be on or off (got ${show(v)})`)
}

function oneOfRule<T extends string>(label: string, values: readonly T[]): Rule<T> {
  return (v, c) =>
    typeof v === 'string' && (values as readonly string[]).includes(v)
      ? (v as T)
      : c.reject(`${label} must be one of ${values.join(', ')} (got ${show(v)})`)
}

function pathRule(label: string, blankMeans?: ''): Rule<string> {
  return (v, c) => {
    if (blankMeans === '' && v === '') return ''
    const problem = localPathProblem(v, c.flavour)
    return problem ? c.reject(`${label} ${problem} (got ${show(v)})`) : (v as string)
  }
}

const ENGINE_IDS: Record<EngineId, true> = { eevee: true, cycles: true, octane: true }

/** A Record over every filter, so a filter added without a rule fails to compile. */
const OFFER_FILTER_RULES: { [K in keyof OfferFilters]-?: Rule<OfferFilters[K]> } = {
  gpuNames: (v, c) => {
    if (!Array.isArray(v)) return c.reject(`GPU allowlist must be a list of GPU names`)
    const names: string[] = []
    for (const item of v) {
      const name = typeof item === 'string' ? item.trim() : null
      if (name === null || name.length > 64 || CONTROL.test(name)) {
        return c.reject(`GPU allowlist has something that is not a GPU name: ${show(item)}`)
      }
      if (name !== '' && !names.includes(name)) names.push(name)
    }
    if (names.length > 64) return c.reject('GPU allowlist can hold at most 64 names')
    return names
  },
  // Blank = any price. Only a filter: the spend cap still bounds the fleet.
  maxDphTotal: optionalNumberRule('max $/hr', SETTINGS_LIMITS.maxDphTotal),
  minGpuRamGb: numberRule('min GPU RAM', SETTINGS_LIMITS.minGpuRamGb),
  minInetDownMbps: numberRule('min download', SETTINGS_LIMITS.minInetDownMbps),
  minReliability: numberRule('min reliability', SETTINGS_LIMITS.minReliability),
  minDiskGb: numberRule('min disk', SETTINGS_LIMITS.minDiskGb),
  cpuBound: booleanRule('CPU-bound'),
  minCpuCores: optionalNumberRule('min CPU cores', SETTINGS_LIMITS.minCpuCores),
  minNumGpus: optionalNumberRule('min GPUs per node', SETTINGS_LIMITS.minNumGpus)
}

const OCTANE_RULES: { [K in keyof OctaneSettings]-?: Rule<OctaneSettings[K]> } = {
  scriptedSignIn: booleanRule('scripted Octane sign-in'),
  secureCloudOnly: booleanRule('secure cloud only for Octane')
}

/**
 * Apply `value`'s own fields to `base`, each through its rule. A field with
 * no rule is refused. `base` is a copy the caller owns.
 */
function mergeFields<T extends object>(
  base: T,
  value: Record<string, unknown>,
  rules: { [K in keyof T]-?: Rule<T[K]> },
  c: Ctx,
  what: string
): T {
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (v === undefined) continue
    const sub = c.nested(key)
    if (!hasOwn(rules, key)) {
      sub.reject(`unknown ${what} ${show(key)}`)
      continue
    }
    const k = key as keyof T & string
    const out = rules[k](v, sub)
    if (out !== KEEP) base[k] = out
  }
  return base
}

/**
 * spendCapPerHour and noSpendCap are settled together by settleSpendCap,
 * and main's own fields (derived) are dropped without a word, as the has*
 * flags always were.
 */
type TopRule<K extends keyof SettingsPublic> = 'derived' | 'spendCap' | Rule<SettingsPublic[K]>

/** A Record over every setting, so a setting added without a rule fails to compile. */
const RULES: { [K in keyof SettingsPublic]-?: TopRule<K> } = {
  hasVastApiKey: 'derived',
  hasOtoyCredentials: 'derived',
  installId: 'derived',
  apiServer: 'derived',
  spendCapPerHour: 'spendCap',
  noSpendCap: 'spendCap',
  projectRoot: pathRule('project root'),
  maxActiveNodes: numberRule('max active nodes', SETTINGS_LIMITS.maxActiveNodes),
  idleTimeoutMinutes: numberRule('idle timeout', SETTINGS_LIMITS.idleTimeoutMinutes),
  proxyCodec: oneOfRule('proxy codec', ['hevc', 'av1']),
  blenderVersionOverride: (v, c) => {
    if (v === null) return null
    const version = typeof v === 'string' ? v.trim() : null
    if (version === '') return null // blank = match each .blend's own version
    if (version === null || !BLENDER_VERSION_RE.test(version)) {
      return c.reject(
        `Blender version override must be a version such as 4.5 or 4.5.3, or blank to match each .blend (got ${show(v)})`
      )
    }
    return version
  },
  offerFilters: (v, c) => {
    if (!isRecord(v)) return c.reject(`offer filters must be a set of filters (got ${show(v)})`)
    return mergeFields({ ...c.current.offerFilters }, v, OFFER_FILTER_RULES, c, 'offer filter')
  },
  // Blank = the app's own key, made on first use.
  sshKeyPath: pathRule('SSH key path', ''),
  concurrentTransfersPerNode: numberRule(
    'transfers per node',
    SETTINGS_LIMITS.concurrentTransfersPerNode
  ),
  thumbnails: booleanRule('frame thumbnails'),
  livePreview: oneOfRule('live preview', ['off', 'onDemand', 'always']),
  livePreviewWidth: (v, c) => {
    const width = numberRule('live preview width', SETTINGS_LIMITS.livePreviewWidth)(v, c)
    if (width === KEEP || width % 2 === 0) return width
    c.clamp(`live preview width must be even, so ${width - 1} was saved (got ${width})`)
    return width - 1
  },
  maxNodeSlots: numberRule('max render slots per node', SETTINGS_LIMITS.maxNodeSlots),
  slotsPerGpu: numberRule('render slots per GPU', SETTINGS_LIMITS.slotsPerGpu),
  eagerFleet: booleanRule('buy-ahead fleet'),
  apiEnabled: booleanRule('local API'),
  apiPort: (v, c) => {
    const port = numberRule('local API port', SETTINGS_LIMITS.apiPort)(v, c)
    if (port === KEEP || port === 0 || port >= 1024) return port
    return c.reject(`local API port must be 0 (any free port) or from 1024 to 65535 (got ${port})`)
  },
  co2OverheadFactor: numberRule('CO2 overhead factor', SETTINGS_LIMITS.co2OverheadFactor),
  dockerImageByEngine: (v, c) => {
    if (!isRecord(v)) return c.reject(`docker images must be given per engine (got ${show(v)})`)
    const images: Partial<Record<EngineId, string>> = { ...c.current.dockerImageByEngine }
    for (const key of Object.keys(v)) {
      const image = v[key]
      if (image === undefined) continue
      const sub = c.nested(key)
      if (!hasOwn(ENGINE_IDS, key)) {
        sub.reject(`unknown engine ${show(key)}`)
        continue
      }
      const engine = key as EngineId
      // null or blank = back to the built-in image.
      if (image === null || image === '') {
        delete images[engine]
        continue
      }
      const ref = typeof image === 'string' ? image.trim() : ''
      if (!isDockerImage(ref)) {
        sub.reject(
          `${engine} docker image must be an image name such as vastai/base-image:tag (got ${show(image)})`
        )
        continue
      }
      images[engine] = ref
    }
    return images
  },
  octane: (v, c) => {
    if (!isRecord(v)) return c.reject(`Octane settings must be a set of options (got ${show(v)})`)
    const base: OctaneSettings = {
      scriptedSignIn: c.current.octane?.scriptedSignIn === true,
      secureCloudOnly: c.current.octane?.secureCloudOnly === true
    }
    return mergeFields(base, v, OCTANE_RULES, c, 'Octane setting')
  }
}

/**
 * The spend cap and "no spend cap" are one decision. spendCapPerHour is null
 * only when noSpendCap says so, and every reader keeps reading
 * spendCapPerHour, where null has always meant "no cap". A blank cap field is
 * a number being retyped, not a request to rent without a limit (#99 #112).
 *
 * A patch that touches neither leaves both as they are. That includes a file
 * from before the flag with a null cap and no flag: whether that null was
 * meant, or was the keystroke bug, is for the settings loader to decide.
 */
function settleSpendCap(
  p: Record<string, unknown>,
  out: SettingsPublic,
  capCtx: Ctx,
  flagCtx: Ctx
): void {
  const current = capCtx.current
  const capSent = p.spendCapPerHour !== undefined
  let flag: boolean | undefined
  if (p.noSpendCap !== undefined) {
    if (typeof p.noSpendCap === 'boolean') flag = p.noSpendCap
    else flagCtx.reject(`no spend cap must be on or off (got ${show(p.noSpendCap)})`)
  }
  const blank = capSent && (p.spendCapPerHour === null || p.spendCapPerHour === '')

  if (flag === true) {
    if (capSent && !blank) {
      // A figure and "no cap" at once: say so, and keep what is there,
      // which leaves the fleet capped if it was.
      flagCtx.reject('"no spend cap" and a spend cap were both sent: send one or the other')
      capCtx.reject('"no spend cap" and a spend cap were both sent: send one or the other')
      return
    }
    out.noSpendCap = true
    out.spendCapPerHour = null
    return
  }

  const figure =
    capSent && !blank
      ? numberRule('spend cap', SETTINGS_LIMITS.spendCapPerHour)(p.spendCapPerHour, capCtx)
      : KEEP
  if (figure !== KEEP) {
    out.spendCapPerHour = figure
    out.noSpendCap = false
    return
  }

  if (flag === false) {
    // Turning the cap back on needs a figure to turn it on at.
    if (!capSent && typeof current.spendCapPerHour === 'number') {
      out.noSpendCap = false
    } else if (!capSent) {
      flagCtx.reject('enter a spend cap in $/hr to turn the cap back on')
    } else if (blank) {
      capCtx.reject('enter a spend cap in $/hr to turn the cap back on')
    }
    return
  }

  if (blank && current.noSpendCap !== true) {
    capCtx.reject(
      'the spend cap is blank: enter a figure in $/hr, or turn on "no spend cap" to rent without one'
    )
  }
}

/**
 * Check `patch` against every setting's rule and apply what passes to a copy
 * of `current`. The result's `settings` is what to save, and `errors` lists
 * each field that was not saved as sent, with a message to show next to it.
 *
 * - A field that fails keeps its current value ('rejected'). A number outside
 *   its limits is saved at the nearest limit ('clamped').
 * - An unknown field is refused, so a patch cannot plant keys in
 *   settings.json.
 * - Main's own fields (hasVastApiKey, hasOtoyCredentials, installId) are
 *   dropped without an error. The renderer may send back what it was given.
 * - A field whose value is `undefined` is treated as absent, as `Partial`
 *   means.
 * - `offerFilters`, `octane` and `dockerImageByEngine` merge: a patch names
 *   only the fields it changes.
 *
 * `current` is not modified.
 */
export function sanitizeSettingsPatch(
  patch: unknown,
  current: SettingsPublic,
  opts: SanitizeOptions = {}
): SettingsPatchResult {
  const errors: SettingsFieldError[] = []
  const ctx = (field: string): Ctx => ({
    current,
    flavour: opts.pathFlavour,
    reject(message) {
      errors.push({ field, message, outcome: 'rejected' })
      return KEEP
    },
    clamp(message) {
      errors.push({ field, message, outcome: 'clamped' })
    },
    nested: (key) => ctx(`${field}.${key}`)
  })

  const settings: SettingsPublic = { ...current, offerFilters: { ...current.offerFilters } }
  if (!isRecord(patch)) {
    ctx('').reject(`a settings change must be a set of fields (got ${show(patch)})`)
    return { settings, errors }
  }

  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value === undefined) continue
    if (!hasOwn(RULES, key)) {
      ctx(key).reject(`unknown setting ${show(key)}`)
      continue
    }
    const k = key as keyof SettingsPublic
    const rule = RULES[k] as TopRule<typeof k>
    if (rule === 'derived' || rule === 'spendCap') continue
    const out = rule(value, ctx(key))
    if (out !== KEEP) (settings as unknown as Record<string, unknown>)[key] = out
  }
  settleSpendCap(patch, settings, ctx('spendCapPerHour'), ctx('noSpendCap'))
  return { settings, errors }
}
