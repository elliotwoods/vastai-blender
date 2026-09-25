/**
 * "Open VNC login" for a node whose OctaneServer waits for a sign-in (plan
 * 1.18). Signing in by hand, on the node's own desktop, is the default: a
 * credential typed on a rented machine is disclosed to its host either way,
 * and this way the app never carries it there. The button opens a tunnel
 * from this computer to the node's VNC server and shows where to point a
 * VNC viewer and the password it wants, each with a copy button.
 *
 * Only a click opens it. Main takes an open tunnel as someone at the
 * desktop and lifts its hold on Octane rentals, so opening one on mount or
 * on a refresh would lift that hold with nobody there.
 */

import { useState, type CSSProperties } from 'react'
import { Icon } from '../../components/Icon'
import { btn, mono, sectionLabel } from '../../lib/controls'
import { ipc } from '../../lib/ipc'
import { ipcErrorText } from '../../lib/recovery'
import { SCALE, TOKENS } from '../../lib/theme'
import type { NodeSnapshot, VncTunnelInfo } from '../../../../shared/models'
import { vncLoginKey } from './octane'

const field: CSSProperties = {
  ...mono,
  fontSize: SCALE.textSm,
  color: TOKENS.text,
  background: TOKENS.surface,
  border: `1px solid ${TOKENS.border}`,
  borderRadius: SCALE.radiusSm,
  padding: '2px 8px',
  userSelect: 'text'
}

function CopyField({
  label,
  value,
  shown,
  onCopy
}: {
  label: string
  value: string
  /** what is displayed, when not the value itself (a masked password) */
  shown?: string
  onCopy: () => void
}): React.JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ ...sectionLabel(), fontSize: SCALE.text2xs }}>{label}</span>
      <span style={field}>{shown ?? value}</span>
      <button
        type="button"
        title={`Copy the ${label}`}
        aria-label={`Copy the ${label}`}
        style={{ ...btn({ variant: 'ghost', size: 'sm' }), padding: '2px 5px' }}
        onClick={(e) => {
          e.stopPropagation()
          onCopy()
        }}
      >
        <Icon name="copy" size={12} />
      </button>
    </span>
  )
}

export function VncLogin({ node }: { node: NodeSnapshot }): React.JSX.Element | null {
  // Keyed, so a tunnel's address and password live only as long as the
  // sign-in and the connection they were opened for (vncLoginKey).
  const key = vncLoginKey(node)
  return key == null ? null : <VncLoginPanel key={key} node={node} />
}

function VncLoginPanel({ node }: { node: NodeSnapshot }): React.JSX.Element {
  const [info, setInfo] = useState<VncTunnelInfo | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  const open = async (): Promise<void> => {
    setOpening(true)
    setError(null)
    try {
      setInfo(await ipc.invoke('node:openVncTunnel', node.id))
    } catch (e) {
      setError(ipcErrorText(e))
    } finally {
      setOpening(false)
    }
  }

  const copy = async (what: string, text: string): Promise<void> => {
    await ipc.invoke('clipboard:write', text)
    setFlash(`${what} copied`)
    setTimeout(() => setFlash(null), 2200)
  }

  const address = info ? `vnc://127.0.0.1:${info.localPort}` : ''
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: SCALE.space2,
        padding: `${SCALE.space2} ${SCALE.space3}`,
        borderRadius: SCALE.radiusSm,
        border: `1px solid ${TOKENS.warnSoftBorder}`,
        background: TOKENS.warnSoftBg,
        color: TOKENS.warnSoftText,
        fontSize: SCALE.textSm
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SCALE.space3, flexWrap: 'wrap' }}>
        <Icon name="alert" size={13} style={{ color: TOKENS.warn }} />
        <span style={{ flex: 1, minWidth: 200 }}>
          OctaneServer on this node is waiting for an OTOY sign-in. Octane chunks wait for it; sign
          in on the node&apos;s desktop over VNC.
        </span>
        <button
          type="button"
          style={btn({ size: 'sm', variant: 'primary', disabled: opening })}
          disabled={opening}
          title="Open a tunnel from this computer to the node's VNC desktop"
          onClick={(e) => {
            e.stopPropagation()
            void open()
          }}
        >
          {opening ? 'opening…' : info ? 'Open again' : 'Open VNC login'}
        </button>
      </div>
      {error ? (
        <div style={{ color: TOKENS.danger, fontSize: SCALE.textXs }}>
          {/not VNC/i.test(error)
            ? `This node has no VNC desktop to sign in on: ${error}`
            : `Could not open the VNC login: ${error}`}
        </div>
      ) : null}
      {info ? (
        <>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: SCALE.space4, flexWrap: 'wrap' }}
          >
            <CopyField
              label="address"
              value={address}
              onCopy={() => void copy('address', address)}
            />
            {info.password ? (
              <>
                <CopyField
                  label="password"
                  value={info.password}
                  shown={reveal ? info.password : '•'.repeat(Math.min(12, info.password.length))}
                  onCopy={() => void copy('password', info.password)}
                />
                <button
                  type="button"
                  style={{ ...btn({ variant: 'ghost', size: 'sm' }), padding: '2px 6px' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    setReveal(!reveal)
                  }}
                >
                  {reveal ? 'hide' : 'show'}
                </button>
              </>
            ) : (
              <span style={{ fontSize: SCALE.textXs }}>
                No password known: this session did not start the node&apos;s VNC server.
              </span>
            )}
            {flash ? (
              <span style={{ color: TOKENS.accent, fontSize: SCALE.textXs }}>{flash}</span>
            ) : null}
          </div>
          <div style={{ fontSize: SCALE.textXs, color: TOKENS.textSecondary }}>
            Point a VNC viewer at the address (on a Mac: Finder › Go › Connect to Server), enter the
            password, and sign in to OTOY in the window on the node&apos;s desktop. The node picks
            up Octane work by itself once it is licensed. The tunnel only listens on this computer.
          </div>
        </>
      ) : null}
    </div>
  )
}
