import './mobileLayout.css'

export function installMobileLayout(root) {
  const media = window.matchMedia('(max-width: 900px)')
  const viewport = window.visualViewport
  let locked = false
  let savedScroll = 0
  let restoreFrame = 0
  let measureFrame = 0
  const properties = ['--mobile-height', '--mobile-top']
  function measure() {
    measureFrame = 0
    if (!locked) return
    const zoomed = viewport && Math.abs(viewport.scale - 1) > 0.05
    const height = zoomed ? window.innerHeight : (viewport?.height || window.innerHeight)
    const top = zoomed ? 0 : (viewport?.offsetTop || 0)
    document.documentElement.style.setProperty('--mobile-height', `${height}px`)
    document.documentElement.style.setProperty('--mobile-top', `${top}px`)
  }
  function scheduleMeasure() {
    if (!measureFrame) measureFrame = requestAnimationFrame(measure)
  }
  function unlock(restore = true) {
    if (!locked) return
    locked = false
    document.body.classList.remove('mobile-chat-screen')
    properties.forEach(p => document.documentElement.style.removeProperty(p))
    cancelAnimationFrame(restoreFrame)
    if (restore) restoreFrame = requestAnimationFrame(() => {
      if (!locked) window.scrollTo({ top: savedScroll, behavior: 'instant' })
    })
  }
  function sync() {
    const chat = root.querySelector('.app .chat')
    const active = media.matches && !!chat
    if (active && !locked) {
      cancelAnimationFrame(restoreFrame)
      savedScroll = window.scrollY
      locked = true
      document.body.classList.add('mobile-chat-screen')
      window.scrollTo({ top: 0, behavior: 'instant' })
      measure()
    } else if (!active) unlock()
  }
  function navigation(event) {
    if (!(event.target instanceof Element) || !event.target.closest('.tabs button')) return
    const focused = document.activeElement
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur()
  }
  const observer = new MutationObserver(sync)
  observer.observe(root, { childList: true, subtree: true })
  media.addEventListener('change', sync)
  window.addEventListener('resize', scheduleMeasure)
  viewport?.addEventListener('resize', scheduleMeasure)
  viewport?.addEventListener('scroll', scheduleMeasure)
  root.addEventListener('click', navigation, true)
  sync()
  return () => {
    observer.disconnect()
    media.removeEventListener('change', sync)
    window.removeEventListener('resize', scheduleMeasure)
    viewport?.removeEventListener('resize', scheduleMeasure)
    viewport?.removeEventListener('scroll', scheduleMeasure)
    root.removeEventListener('click', navigation, true)
    cancelAnimationFrame(restoreFrame)
    cancelAnimationFrame(measureFrame)
    unlock(false)
  }
}
