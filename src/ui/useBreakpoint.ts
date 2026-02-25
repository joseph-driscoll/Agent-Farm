import { useState, useEffect } from 'react'

export type Breakpoint = 'desktop' | 'laptop' | 'tablet' | 'tabletSm' | 'phone' | 'phoneSm'

function getBreakpoint(width: number): Breakpoint {
  if (width < 360) return 'phoneSm'
  if (width < 480) return 'phone'
  if (width < 576) return 'tabletSm'
  if (width < 768) return 'tablet'
  if (width < 992) return 'laptop'
  if (width < 1200) return 'desktop'
  return 'desktop'
}

export function useBreakpoint(): { breakpoint: Breakpoint; width: number; isNarrow: boolean; isPhone: boolean; isPhoneOrTablet: boolean } {
  const [width, setWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  )

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const breakpoint = getBreakpoint(width)
  const isPhone = width < 576
  const isPhoneOrTablet = width < 992
  const isNarrow = width < 768

  return { breakpoint, width, isNarrow, isPhone, isPhoneOrTablet }
}
