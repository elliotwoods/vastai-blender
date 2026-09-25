import { posix, win32 } from 'path'
import { describe, expect, it } from 'vitest'
import { jobMediaUrl, resolveMediaUrl, type MediaPlaces } from './mediaProtocol'

// media://job/<jobId>/<rel> (plan 1.13): a job's files are served from its
// own jobs.output_dir, whatever the project root is now, and nothing a URL
// says can reach outside that folder.

const JOB = '4f1c2a9e-0000-4000-8000-000000000001'
const OTHER = '4f1c2a9e-0000-4000-8000-000000000002'

const places: MediaPlaces = {
  roots: { project: '/new-root', fixtures: '/app/fixtures' },
  jobDir: (id) =>
    ({ [JOB]: '/old-root/renders/' + JOB, [OTHER]: '/old-root/renders/' + OTHER })[id] ?? null
}

const resolve = (url: string): ReturnType<typeof resolveMediaUrl> =>
  resolveMediaUrl(url, places, posix)

describe('resolveMediaUrl', () => {
  it("serves a job's file from its own output folder, not the current project root", () => {
    // B7: the root was changed in Settings after the job was submitted.
    expect(resolve(`media://job/${JOB}/previews/chunk-1.mp4`)).toEqual({
      abs: `/old-root/renders/${JOB}/previews/chunk-1.mp4`
    })
    expect(resolve(`media://job/${JOB}/frames/0001.png?t=1#x`)).toEqual({
      abs: `/old-root/renders/${JOB}/frames/0001.png`
    })
  })

  it('an unknown job, or none named, is not found', () => {
    expect(resolve('media://job/no-such-job/frames/0001.png')).toMatchObject({ status: 404 })
    expect(resolve('media://job/')).toMatchObject({ status: 404 })
    expect(resolve('media://job//frames/0001.png')).toMatchObject({ status: 404 })
  })

  it('the job folder itself is not a file to serve', () => {
    expect(resolve(`media://job/${JOB}`)).toMatchObject({ status: 403 })
    expect(resolve(`media://job/${JOB}/`)).toMatchObject({ status: 403 })
  })

  it('a `..`, literal or encoded, only ever moves between jobs, each looked up', () => {
    // The URL parser applies these before the handler sees the path.
    expect(resolve(`media://job/${JOB}/../${OTHER}/frames/0001.png`)).toEqual({
      abs: `/old-root/renders/${OTHER}/frames/0001.png`
    })
    expect(resolve(`media://job/${JOB}/%2e%2e/%2e%2e/etc/passwd`)).toMatchObject({ status: 404 })
    expect(resolve(`media://job/${JOB}/..%2F..%2Fetc%2Fpasswd`)).toMatchObject({ status: 403 })
  })

  it('nothing decoded out of a segment leaves the job folder', () => {
    for (const rel of [
      'frames%2F..%2F..%2F..%2Fsecret', // an encoded slash, then ..
      '%2Fetc%2Fpasswd', // an absolute path
      '..%5C..%5Csecret', // backslashes
      'frames%2F0001.png%00.txt', // NUL
      'frames%0A0001.png', // newline
      'C%3A%5CWindows%5Cwin.ini' // a drive
    ]) {
      expect(resolve(`media://job/${JOB}/${rel}`), rel).toMatchObject({ status: 403 })
    }
  })

  it('a malformed escape is a bad request, not a crash', () => {
    expect(resolve(`media://job/${JOB}/frames/%E0%A4%A`)).toMatchObject({ status: 400 })
  })

  it('an unknown host is not found; the fixed roots still serve', () => {
    expect(resolve('media://elsewhere/x.png')).toMatchObject({ status: 404 })
    expect(resolve('media://__proto__/x.png')).toMatchObject({ status: 404 })
    expect(resolve('media://project/renders/x/previews/a.mp4')).toEqual({
      abs: '/new-root/renders/x/previews/a.mp4'
    })
    expect(resolve('media://fixtures/thumbs/0001.jpg')).toEqual({
      abs: '/app/fixtures/thumbs/0001.jpg'
    })
    // The parser keeps a literal `..` at the root; an encoded one is refused.
    expect(resolve('media://project/../x')).toEqual({ abs: '/new-root/x' })
    expect(resolve('media://project/..%2Fx')).toMatchObject({ status: 403 })
  })

  it('on Windows: inside the job folder only, with its device names refused', () => {
    const win: MediaPlaces = { roots: {}, jobDir: () => 'D:\\Renders\\renders\\' + JOB }
    expect(resolveMediaUrl(`media://job/${JOB}/frames/0001.exr`, win, win32)).toEqual({
      abs: `D:\\Renders\\renders\\${JOB}\\frames\\0001.exr`
    })
    expect(resolveMediaUrl(`media://job/${JOB}/frames/CON.png`, win, win32)).toMatchObject({
      status: 403
    })
    expect(resolveMediaUrl(`media://job/${JOB}/frames/a.png:ads`, win, win32)).toMatchObject({
      status: 403
    })
  })
})

describe('jobMediaUrl', () => {
  it('round-trips through resolveMediaUrl, whatever the file is called', () => {
    for (const name of ['0001.png', 'my clip #2 (50%).mp4', 'ünïcødé ?.jpg']) {
      const abs = `/old-root/renders/${JOB}/previews/${name}`
      const url = jobMediaUrl(JOB, `/old-root/renders/${JOB}`, abs, posix)
      expect(url).toMatch(new RegExp(`^media://job/${JOB}/previews/`))
      expect(resolve(url!), name).toEqual({ abs })
    }
  })

  it('is null for a path outside the job folder', () => {
    const dir = `/old-root/renders/${JOB}`
    expect(jobMediaUrl(JOB, dir, '/old-root/renders/other/x.png', posix)).toBeNull()
    expect(jobMediaUrl(JOB, dir, `${dir}-old/x.png`, posix)).toBeNull()
    expect(jobMediaUrl(JOB, dir, dir, posix)).toBeNull()
    expect(jobMediaUrl(JOB, 'C:\\R\\a', 'D:\\R\\a\\x.png', win32)).toBeNull()
  })

  it('on Windows, joins with forward slashes', () => {
    expect(jobMediaUrl(JOB, 'C:\\R\\a', 'C:\\R\\a\\frames\\0001.png', win32)).toBe(
      `media://job/${JOB}/frames/0001.png`
    )
  })
})
