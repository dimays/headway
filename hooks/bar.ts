// Progress bars as markup: an SVG pill for surfaces that draw SVG, a line of
// box-drawing characters for the terminal. Pure functions, so tests can read them.

import type { Progress } from './plan'

// Colours that read on light and dark backgrounds alike.
const TRACK = 'rgba(127,127,127,0.20)'
const FILL = '#D97757' // Claude's coral
const FILL_DONE = '#3E9E6B' // turns green once every step is done
const ACTIVE_OPACITY = 0.35

function pct(n: number, total: number): string {
  return total === 0 ? '0' : ((n / total) * 100).toFixed(2)
}

/**
 * A rounded pill: the track, then the step in progress as a pale extension,
 * then the completed part on top. Widths are percentages, so the pill fills
 * whatever width the surface gives it without stretching its rounded ends.
 */
export function barSvg(p: Progress, height: number): string {
  const r = height / 2
  const complete = p.total > 0 && p.done === p.total
  const fill = complete ? FILL_DONE : FILL
  const reach = pct(p.done + p.active, p.total)
  const done = pct(p.done, p.total)
  const pill = (width: string, extra: string) =>
    `<rect x="0" y="0" width="${width}%" height="${height}" rx="${r}" ry="${r}" ${extra}/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">`,
    `<rect x="0" y="0" width="100%" height="${height}" rx="${r}" ry="${r}" fill="${TRACK}"/>`,
    p.active > 0 ? pill(reach, `fill="${fill}" fill-opacity="${ACTIVE_OPACITY}"`) : '',
    p.done > 0 ? pill(done, `fill="${fill}"`) : '',
    `</svg>`,
  ].join('')
}

export function barAlt(p: Progress): string {
  if (p.total === 0) return 'No steps yet'
  return `${p.done} of ${p.total} steps done${p.active > 0 ? `, ${p.active} in progress` : ''}`
}

/** The terminal's bar: heavy line for done, light for the rest. */
export function barText(p: Progress, width: number): { done: string; active: string; rest: string } {
  const cells = Math.max(4, width)
  if (p.total === 0) return { done: '', active: '', rest: '─'.repeat(cells) }
  const done = Math.round((p.done / p.total) * cells)
  const active = Math.min(cells - done, p.active > 0 ? Math.max(1, Math.round((p.active / p.total) * cells)) : 0)
  return { done: '━'.repeat(done), active: '━'.repeat(active), rest: '─'.repeat(cells - done - active) }
}

/** `6/7` and ` 86%`, the percent padded so a column of them lines up. */
export function labels(p: Progress): { count: string; percent: string } {
  if (p.total === 0) return { count: '', percent: '' }
  return { count: `${p.done}/${p.total}`, percent: `${Math.round(p.ratio * 100)}%`.padStart(4, ' ') }
}
