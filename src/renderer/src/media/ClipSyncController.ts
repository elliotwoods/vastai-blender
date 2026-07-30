/**
 * Leader/follower sync engine for a set of <video> elements playing the same
 * frame range (proxy clips of one take, or A/B compares).
 *
 * - Playing: a rAF loop READS the leader's currentTime → derives the frame →
 *   notifies subscribers. Followers are corrected by seek only when drift
 *   exceeds one frame; inside that they converge via playbackRate nudging
 *   (0.98–1.02) so playback never stutters.
 * - Paused stepping / scrubbing: WRITES currentTime to clips. All-Intra
 *   encodes make this frame-exact. Mid-drag only the leader seeks (cheap
 *   preview); pointer-up fans the final frame out to everyone.
 *
 * Plain class, no React — components subscribe via subscribe().
 */

import { frameToTime, timeToFrame } from './frame-math'

export interface TransportMeta {
  fps: number
  totalFrames: number
}

type Listener = (frame: number, playing: boolean) => void

const RATE_MIN = 0.98
const RATE_MAX = 1.02

export class ClipSyncController {
  private videos: HTMLVideoElement[] = []
  private leaderIndex = 0
  private listeners = new Set<Listener>()
  private raf: number | null = null
  private _playing = false
  private lastFrame = -1

  constructor(public meta: TransportMeta) {}

  /**
   * Frame the transport is on, independent of any element. Survives a swap of
   * the underlying <video>, which `currentFrame` does not: that getter reads
   * the leader's currentTime, and a freshly-mounted element is at 0.
   */
  get lastKnownFrame(): number {
    return Math.max(0, this.lastFrame)
  }

  /**
   * Place the transport at a frame WITHOUT touching any element.
   *
   * For opening at a requested frame: VideoTile captures `lastKnownFrame`
   * synchronously before it registers, then applies it once the element has
   * metadata. Seeking from the overlay instead would be overwritten by that
   * restore (child passive effects run before the parent's), so the overlay
   * seeds the value here from a layout effect and lets the existing restore
   * path do the actual seek and clamping.
   */
  setKnownFrame(frame: number): void {
    this.lastFrame = Math.min(this.meta.totalFrames - 1, Math.max(0, frame))
  }

  // -- registration ---------------------------------------------------------

  register(el: HTMLVideoElement): () => void {
    this.videos.push(el)
    /**
     * Re-apply the transport's position once the element can actually seek.
     *
     * `readyState 1` (HAVE_METADATA) is enough to know the duration but NOT to
     * seek — Chromium silently drops the assignment and `currentTime` stays 0.
     * Since a restore is issued as soon as metadata arrives, opening the preview
     * at a frame left the transport reading frame N while the picture sat on
     * frame 0. This also re-syncs a paused element whose `src` was swapped for a
     * new live-clip version.
     */
    const onCanPlay = (): void => {
      if (this._playing) return
      const t = frameToTime(this.lastKnownFrame, this.meta.fps)
      if (Math.abs(el.currentTime - t) > 1 / (this.meta.fps * 2)) el.currentTime = t
    }
    el.addEventListener('canplay', onCanPlay)
    return () => {
      el.removeEventListener('canplay', onCanPlay)
      const i = this.videos.indexOf(el)
      if (i >= 0) this.videos.splice(i, 1)
      if (this.leaderIndex >= this.videos.length) this.leaderIndex = 0
    }
  }

  setLeader(el: HTMLVideoElement): void {
    const i = this.videos.indexOf(el)
    if (i >= 0) this.leaderIndex = i
  }

  get leader(): HTMLVideoElement | null {
    return this.videos[this.leaderIndex] ?? null
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * Retarget at a new clip length. A live clip grows while it is being
   * watched, so `meta` is not fixed for the controller's lifetime — subscribers
   * re-read it on every notify, and forcing one here is what re-scales the
   * ruler and the frame count.
   */
  setMeta(next: TransportMeta): void {
    if (next.fps === this.meta.fps && next.totalFrames === this.meta.totalFrames) return
    this.meta = next
    // A shorter clip must not leave the playhead past its end.
    if (this.lastFrame > next.totalFrames - 1) this.lastFrame = next.totalFrames - 1
    this.notifyForce()
  }

  private notify(frame: number): void {
    if (frame !== this.lastFrame) {
      this.lastFrame = frame
      for (const fn of this.listeners) fn(frame, this._playing)
    }
  }

  // -- state ----------------------------------------------------------------

  get playing(): boolean {
    return this._playing
  }

  get currentFrame(): number {
    const leader = this.leader
    if (!leader) return 0
    return timeToFrame(leader.currentTime, this.meta.fps, this.meta.totalFrames)
  }

  // -- transport ------------------------------------------------------------

  play(): void {
    if (this._playing) return
    this._playing = true
    for (const v of this.videos) void v.play().catch(() => {})
    this.startLoop()
    this.notifyForce()
  }

  pause(): void {
    if (!this._playing) return
    this._playing = false
    for (const v of this.videos) {
      v.pause()
      v.playbackRate = 1
    }
    this.stopLoop()
    // Align everyone on the leader's frame for a clean paused state.
    this.seekFrame(this.currentFrame)
    this.notifyForce()
  }

  toggle(): void {
    if (this._playing) this.pause()
    else this.play()
  }

  seekFrame(frame: number): void {
    const t = frameToTime(Math.min(this.meta.totalFrames - 1, Math.max(0, frame)), this.meta.fps)
    for (const v of this.videos) {
      v.currentTime = t
    }
    this.notify(timeToFrame(t, this.meta.fps, this.meta.totalFrames))
  }

  step(delta: number): void {
    this.pause()
    this.seekFrame(this.currentFrame + delta)
  }

  first(): void {
    this.pause()
    this.seekFrame(0)
  }

  last(): void {
    this.pause()
    this.seekFrame(this.meta.totalFrames - 1)
  }

  // -- drag protocol --------------------------------------------------------

  /** Mid-drag: seek the leader only (cheap live preview). */
  dragPreview(frame: number): void {
    if (this._playing) this.pause()
    const leader = this.leader
    if (leader) leader.currentTime = frameToTime(frame, this.meta.fps)
    this.notify(Math.min(this.meta.totalFrames - 1, Math.max(0, Math.round(frame))))
  }

  /** Pointer-up: fan the final frame out to all clips. */
  dragCommit(frame: number): void {
    this.seekFrame(frame)
  }

  // -- internals ------------------------------------------------------------

  /**
   * Re-announce the CURRENT position to every subscriber.
   *
   * Deliberately re-notifies `lastKnownFrame`, not `currentFrame`: the latter
   * reads the leader element's currentTime, which is 0 immediately after a
   * `src` swap (a live clip rolling to a new version, or a finished chunk's
   * definitive rendition replacing the live one). Deriving from the element
   * there would announce frame 0 and throw the viewer back to the start —
   * previously avoided only by the order the effects happened to run in.
   */
  private notifyForce(): void {
    const at = this.lastKnownFrame
    this.lastFrame = -1
    this.notify(at)
  }

  private startLoop(): void {
    const tick = (): void => {
      if (!this._playing) return
      const leader = this.leader
      if (leader) {
        const leaderT = leader.currentTime
        this.notify(timeToFrame(leaderT, this.meta.fps, this.meta.totalFrames))
        const frameDur = 1 / this.meta.fps
        for (const v of this.videos) {
          if (v === leader) continue
          // Loop-aware drift: shortest signed distance on the clip circle.
          const dur = v.duration || this.meta.totalFrames / this.meta.fps
          let drift = v.currentTime - leaderT
          if (drift > dur / 2) drift -= dur
          if (drift < -dur / 2) drift += dur
          if (Math.abs(drift) > frameDur) {
            v.currentTime = leaderT // hard correct beyond one frame
            v.playbackRate = 1
          } else {
            // Nudge toward the leader: behind → speed up, ahead → slow down.
            const nudge = 1 - drift / (frameDur * 4)
            v.playbackRate = Math.min(RATE_MAX, Math.max(RATE_MIN, nudge))
          }
        }
      }
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  private stopLoop(): void {
    if (this.raf != null) cancelAnimationFrame(this.raf)
    this.raf = null
  }

  destroy(): void {
    this.stopLoop()
    this.listeners.clear()
    this.videos = []
  }
}
