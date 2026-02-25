import { useEffect, useState, useRef } from 'react'

type CursorState = 'default' | 'pointer'

function isClickable(el: Element | null): boolean {
  if (!el || el === document.body) return false
  const tag = el.tagName?.toLowerCase()
  const role = el.getAttribute?.('role')
  const style = el.getAttribute?.('style') ?? ''
  if (tag === 'a' || tag === 'button' || role === 'button') return true
  if (style.includes('cursor') && style.includes('pointer')) return true
  return false
}

export function CustomCursor() {
  const [pos, setPos] = useState({ x: -100, y: -100 })
  const [state, setState] = useState<CursorState>('default')
  const [visible, setVisible] = useState(false)
  const rafRef = useRef<number>(0)
  const posRef = useRef({ x: -100, y: -100 })

  useEffect(() => {
    document.body.classList.add('custom-cursor-active')
    return () => document.body.classList.remove('custom-cursor-active')
  }, [])

  useEffect(() => {
    if (state === 'pointer') {
      document.body.classList.add('custom-cursor-use-system-pointer')
    } else {
      document.body.classList.remove('custom-cursor-use-system-pointer')
    }
  }, [state])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      posRef.current = { x: e.clientX, y: e.clientY }
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(() => {
        setPos(posRef.current)
        const el = document.elementFromPoint(posRef.current.x, posRef.current.y)
        const clickable = isClickable(el)
        setState(clickable ? 'pointer' : 'default')
        setVisible(true)
        rafRef.current = 0
      })
    }
    const onUp = () => {
      const el = document.elementFromPoint(posRef.current.x, posRef.current.y)
      setState(isClickable(el) ? 'pointer' : 'default')
    }
    const onLeave = () => {
      setVisible(false)
      setState('default')
    }

    document.addEventListener('mousemove', onMove, { passive: true })
    document.addEventListener('mouseup', onUp)
    document.addEventListener('mouseleave', onLeave)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mouseleave', onLeave)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])


  if (!visible) return null
  /* Over a clickable: use the system pointer (traditional finger-up hand), don't draw our own */
  if (state === 'pointer') return null

  const size = 36
  const half = size / 2

  return (
    <div
      className="custom-cursor"
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: size,
        height: size,
        marginLeft: -half,
        marginTop: -half,
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        pointerEvents: 'none',
        zIndex: 999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* Default: arrow (only state we draw; pointer uses system cursor) */}
      {state === 'default' && (
        <svg width={24} height={24} viewBox="0 0 24 24" fill="none" style={{ filter: 'drop-shadow(0 0 1px #000)' }}>
          <path fill="#e8e8e8" stroke="#334155" strokeWidth="1.2" d="M3 3v18l6-5 4 6 1-1-5-6h9z" />
        </svg>
      )}
    </div>
  )
}
