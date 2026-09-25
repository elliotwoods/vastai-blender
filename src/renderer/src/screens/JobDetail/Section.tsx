/**
 * One section of the job detail column: a small uppercase heading, with a
 * chevron that folds it when `onToggle` is given, whatever sits on the
 * heading's right, and its body.
 */

import { useId, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { sectionLabel } from '../../lib/controls'
import { SCALE, TOKENS } from '../../lib/theme'

export function Section({
  title,
  right,
  open = true,
  onToggle,
  children
}: {
  title: string
  right?: ReactNode
  open?: boolean
  onToggle?: () => void
  children: ReactNode
}): React.JSX.Element {
  const bodyId = useId()
  const heading = onToggle ? (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
      style={{
        ...sectionLabel(),
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: 'pointer'
      }}
    >
      <Icon
        name="chevron"
        size={11}
        style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms' }}
      />
      {title}
    </button>
  ) : (
    <span style={sectionLabel()}>{title}</span>
  )
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: SCALE.space2, minWidth: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: SCALE.space3,
          minHeight: 20,
          color: TOKENS.textFaint
        }}
      >
        {heading}
        {right ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: SCALE.space2,
              flex: 1,
              minWidth: 0,
              justifyContent: 'flex-end'
            }}
          >
            {right}
          </div>
        ) : null}
      </div>
      {open ? <div id={bodyId}>{children}</div> : null}
    </section>
  )
}
