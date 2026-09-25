import { describe, expect, it } from 'vitest'
import {
  MAX_FRAME,
  MAX_JOB_FRAMES,
  validateRenderOptions,
  validateSubmission,
  type RenderOptions
} from './jobValidation'
import type { JobSubmission } from './models'

const ok: JobSubmission = {
  blendPath: '/scenes/shot010.blend',
  engine: 'cycles',
  frameStart: 1,
  frameEnd: 250,
  frameStep: 1,
  addonIds: [],
  chunkSize: null
}

/** A submission with some fields replaced — by anything, as IPC and JSON can. */
function sub(patch: Record<string, unknown>): JobSubmission {
  return { ...ok, ...patch } as JobSubmission
}

describe('validateSubmission', () => {
  it('accepts a plain submission, auto chunking included', () => {
    expect(validateSubmission(ok)).toEqual([])
    expect(validateSubmission(sub({ chunkSize: 10, name: 'shot', shareNode: true }))).toEqual([])
  })

  it('treats a missing chunk size as auto, as createJob does', () => {
    expect(validateSubmission(sub({ chunkSize: undefined }))).toEqual([])
  })

  it('refuses a chunk size of 0, negative or fractional', () => {
    // 0 and -1 spun splitFrames forever; 2.5 invented frame numbers.
    for (const chunkSize of [0, -1, 2.5, NaN, '10']) {
      expect(validateSubmission(sub({ chunkSize }))).toEqual([
        expect.stringMatching(/^chunk size must be a whole number of at least 1, or auto/)
      ])
    }
  })

  it('refuses a frame step of 0, negative or fractional', () => {
    for (const frameStep of [0, -1, 2.5, NaN, undefined]) {
      expect(validateSubmission(sub({ frameStep }))).toEqual([
        expect.stringMatching(/^frame step must be a whole number of at least 1/)
      ])
    }
  })

  it('refuses an end frame before the start frame', () => {
    expect(validateSubmission(sub({ frameStart: 100, frameEnd: 99 }))).toEqual([
      'end frame 99 is before start frame 100'
    ])
    expect(validateSubmission(sub({ frameStart: 7, frameEnd: 7 }))).toEqual([])
  })

  it('refuses frames that are fractional, negative or past Blender’s last frame', () => {
    expect(validateSubmission(sub({ frameStart: 1.5 }))).toEqual([
      'start frame must be a whole number (got 1.5)'
    ])
    expect(validateSubmission(sub({ frameStart: -5 }))).toEqual([
      `start frame must be between 0 and ${MAX_FRAME} (got -5)`
    ])
    expect(validateSubmission(sub({ frameEnd: MAX_FRAME + 1 }))).toEqual([
      `end frame must be between 0 and ${MAX_FRAME} (got ${MAX_FRAME + 1})`
    ])
    expect(validateSubmission(sub({ frameEnd: '250' }))).toEqual([
      'end frame must be a whole number (got 250)'
    ])
    // Both ends of the range Blender accepts.
    expect(validateSubmission(sub({ frameStart: 0, frameEnd: 9 }))).toEqual([])
    expect(validateSubmission(sub({ frameStart: MAX_FRAME - 9, frameEnd: MAX_FRAME }))).toEqual([])
    expect(validateSubmission(sub({ frameStart: 0, frameEnd: MAX_FRAME, frameStep: 11 }))).toEqual(
      []
    )
  })

  it('refuses more frames than one job may render', () => {
    // Each is a row inserted on the main thread; 0-1000000 is one stray zero.
    expect(validateSubmission(sub({ frameStart: 0, frameEnd: 1_000_000 }))).toEqual([
      `1000001 frames is more than one job may render (${MAX_JOB_FRAMES}): split the range into several jobs`
    ])
    expect(validateSubmission(sub({ frameStart: 1, frameEnd: MAX_JOB_FRAMES }))).toEqual([])
    expect(validateSubmission(sub({ frameStart: 1, frameEnd: MAX_JOB_FRAMES + 1 }))).toHaveLength(1)
    // Counted on the step: every other frame of twice the range is as many.
    expect(
      validateSubmission(sub({ frameStart: 1, frameEnd: 2 * MAX_JOB_FRAMES - 1, frameStep: 2 }))
    ).toEqual([])
  })

  it('does not also report an inverted range when a frame is already wrong', () => {
    expect(validateSubmission(sub({ frameStart: 10, frameEnd: -1 }))).toEqual([
      `end frame must be between 0 and ${MAX_FRAME} (got -1)`
    ])
  })

  it('refuses an unknown engine', () => {
    expect(validateSubmission(sub({ engine: 'workbench' }))).toEqual([
      'engine must be one of eevee, cycles, octane (got workbench)'
    ])
  })

  it('refuses a missing or blank scene path', () => {
    for (const blendPath of ['', '   ', undefined, 42]) {
      expect(validateSubmission(sub({ blendPath }))).toEqual(['no scene file chosen'])
    }
  })

  it('refuses extension ids that are not a list of ids', () => {
    for (const addonIds of ['auroravision', undefined, [42], ['']]) {
      expect(validateSubmission(sub({ addonIds }))).toEqual([
        'extensions must be a list of extension ids'
      ])
    }
    expect(validateSubmission(sub({ addonIds: ['auroravision'] }))).toEqual([])
  })

  it('refuses a name or share flag of the wrong type', () => {
    expect(validateSubmission(sub({ name: 7 }))).toEqual(['job name must be text (got 7)'])
    expect(validateSubmission(sub({ shareNode: 'yes' }))).toEqual([
      'share node must be true or false (got yes)'
    ])
  })

  it('reports every problem at once', () => {
    const problems = validateSubmission(
      sub({ blendPath: '', engine: 'x', frameStep: 0, chunkSize: 0 })
    )
    expect(problems).toHaveLength(4)
  })

  it('refuses something that is not a submission at all', () => {
    expect(validateSubmission(undefined as unknown as JobSubmission)).toEqual([
      'job submission is missing'
    ])
    expect(validateSubmission(null as unknown as JobSubmission)).toEqual([
      'job submission is missing'
    ])
  })
})

describe('validateRenderOptions', () => {
  it('checks the options without asking which scene', () => {
    const options: RenderOptions = {
      engine: 'eevee',
      frameStart: 1,
      frameEnd: 10,
      frameStep: 1,
      addonIds: [],
      chunkSize: null
    }
    expect(validateRenderOptions(options)).toEqual([])
    expect(validateRenderOptions({ ...options, chunkSize: 0 })).toHaveLength(1)
  })
})
