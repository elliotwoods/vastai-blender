import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// An add-on's id names its zip's copy here, the zip and the module on the
// node, and the expression that enables it there (provisioner's
// installExtension). A manifest id with a quote in it ran as shell on the
// node, and one with a '/' wrote the copy outside the add-ons folder.

const paths = vi.hoisted(() => ({ userData: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => paths.userData }
}))

const { registerAddon, listAddons } = await import('./addons')

/** A zip holding one blender_manifest.toml with this id line, made by Python's zipfile. */
function extensionZip(id: string): string {
  const zip = join(paths.userData, 'ext.zip')
  const manifest = `schema_version = "1.0.0"\nid = "${id}"\nname = "Test"\nversion = "1.2.3"\n`
  const r = spawnSync(
    'python3',
    [
      '-c',
      'import sys, zipfile; zipfile.ZipFile(sys.argv[1], "w").writestr("blender_manifest.toml", sys.argv[2])',
      zip,
      manifest
    ],
    { encoding: 'utf-8' }
  )
  if (r.status !== 0) throw new Error(`could not make the test zip: ${r.stderr}`)
  return zip
}

beforeEach(() => {
  paths.userData = mkdtempSync(join(tmpdir(), 'vr-addons-'))
})
afterEach(() => {
  rmSync(paths.userData, { recursive: true, force: true })
})

describe('registerAddon', () => {
  it('registers a manifest id Blender takes', () => {
    const info = registerAddon(extensionZip('my_tool_2'))
    expect(info).toMatchObject({ id: 'my_tool_2', version: '1.2.3', mechanism: 'install' })
    expect(listAddons().map((a) => a.id)).toEqual(['my_tool_2'])
  })

  it.each([`x'); import os; os.system('id'); ('`, '../../escaped', '9lives', 'a-b'])(
    '1.14: refuses a manifest id that is not a Python identifier (%s)',
    (id) => {
      expect(() => registerAddon(extensionZip(id))).toThrow(/not a valid extension id/)
      expect(listAddons()).toEqual([])
      // Nothing was copied, in the add-ons folder or beside it.
      const addons = join(paths.userData, 'addons')
      expect(existsSync(addons) ? readdirSync(addons) : []).toEqual([])
      expect(readdirSync(paths.userData).sort()).toEqual(['ext.zip'])
    }
  )
})
