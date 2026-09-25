import { describe, expect, it } from 'vitest'
import { isMarkerLine, parseStatusLine } from './blenderStatus'

// Lines as Blender prints them while rendering (captured from 4.5 and 5.1
// runs of the agent; Cycles and EEVEE).

describe('parseStatusLine', () => {
  it('reads a Cycles line mid-sampling (4.5)', () => {
    expect(
      parseStatusLine(
        'Fra:12 Mem:1234.56M (Peak 1400.00M) | Time:00:05.12 | Remaining:00:31.44 | Mem:800.12M, Peak:812.00M | Scene, ViewLayer | Sample 32/256'
      )
    ).toEqual({
      frame: 12,
      memMb: 1234.56,
      peakMemMb: 1400,
      elapsedS: 5.12,
      remainingS: 31.44,
      deviceMemMb: 800.12,
      devicePeakMemMb: 812,
      sample: 32,
      samples: 256,
      phase: 'Sample 32/256'
    })
  })

  it('reads a Cycles line syncing its scene, with the object it is on (5.1)', () => {
    expect(
      parseStatusLine(
        'Fra:1 Mem:245.12M (Peak 245.12M) | Time:00:00.60 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Synchronizing object | Cube.001'
      )
    ).toMatchObject({
      frame: 1,
      elapsedS: 0.6,
      remainingS: null,
      sample: null,
      phase: 'Synchronizing object · Cube.001'
    })
  })

  it('reads the kernel load and a long frame’s hours (5.1)', () => {
    expect(
      parseStatusLine(
        'Fra:250 Mem:155.66M (Peak 155.66M) | Time:01:02:03.45 | Mem:0.00M, Peak:0.00M | Scene, ViewLayer | Loading render kernels (may take a few minutes the first time)'
      )
    ).toMatchObject({
      frame: 250,
      elapsedS: 3723.45,
      phase: 'Loading render kernels (may take a few minutes the first time)'
    })
  })

  it('reads a Cycles line from a GPU with gigabytes (4.5)', () => {
    expect(
      parseStatusLine(
        'Fra:3 Mem:2.10G (Peak 2.50G) | Time:00:10.00 | Remaining:00:02.00 | Mem:10.5G, Peak:11G | Shot, RenderLayer | Rendered 4/4 Tiles, Sample 128/128'
      )
    ).toMatchObject({
      memMb: 2.1 * 1024,
      peakMemMb: 2.5 * 1024,
      deviceMemMb: 10.5 * 1024,
      devicePeakMemMb: 11 * 1024,
      sample: 128,
      samples: 128,
      phase: 'Rendered 4/4 Tiles, Sample 128/128'
    })
  })

  it('reads EEVEE’s line (4.5, 5.1)', () => {
    expect(
      parseStatusLine('Fra:7 Mem:98.22M (Peak 110.56M) | Time:00:00.87 | Rendering 12 / 64 samples')
    ).toEqual({
      frame: 7,
      memMb: 98.22,
      peakMemMb: 110.56,
      elapsedS: 0.87,
      remainingS: null,
      deviceMemMb: null,
      devicePeakMemMb: null,
      sample: 12,
      samples: 64,
      phase: 'Rendering 12 / 64 samples'
    })
  })

  it('is null for anything that is not a status line', () => {
    for (const line of [
      'VR_FRAME {"frame": 12, "evalS": 0.1, "syncS": 2.0, "sampleS": 30.1, "saveS": 0.4, "t": 1}',
      'VR_DRIVER {"event": "ready", "t": 1790000000.1}',
      "Saved: '/root/vr/renders/abc-1-10/frame_0012.exr'",
      ' Time: 00:05.12 (Saving: 00:00.23)',
      'Blender 4.5.3 LTS (hash 67807e1800cc built 2025-09-09 01:30:31)',
      'Fra:',
      '',
      null,
      undefined
    ]) {
      expect(parseStatusLine(line)).toBeNull()
    }
  })

  it('knows the agent’s and the driver’s marker lines', () => {
    expect(isMarkerLine('VR_FRAME {"frame": 1}')).toBe(true)
    expect(isMarkerLine('  VR_GPU 0')).toBe(true)
    expect(isMarkerLine('Fra:1 Mem:1M | Time:00:00.01')).toBe(false)
  })
})
