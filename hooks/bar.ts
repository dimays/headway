// Progress bars as markup: an SVG pill for surfaces that draw SVG, a line of
// box-drawing characters for the terminal. Pure functions, so tests can read them.

/**
 * What a bar shows, as fractions of its width: `done` is measured progress
 * (finished steps, reported percent), `estimate` a further pale stretch that
 * is only a guess from elapsed time.
 */
export type BarSpec = {
  done: number
  estimate: number
  isComplete: boolean
  tone?: 'normal' | 'warning' | 'error'
}

// Colours that read on light and dark backgrounds alike.
const TRACK = 'rgba(127,127,127,0.20)'
const FILL = { normal: '#D97757', warning: '#D4A03A', error: '#D9534F' } as const
const FILL_DONE = '#3E9E6B' // green once every step is done
const ESTIMATE_OPACITY = 0.35

const clamp = (n: number) => Math.min(1, Math.max(0, n))
const pct = (n: number) => (clamp(n) * 100).toFixed(2)

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * A rounded pill: the track, the estimate as a pale extension, the measured
 * part on top. Widths are percentages, so the pill fills whatever width the
 * surface gives it without stretching its rounded ends. A `title` becomes the
 * hover tooltip where the surface draws the SVG interactively.
 */
export function barSvg(spec: BarSpec, height: number, title?: string): string {
  const r = height / 2
  const fill = spec.isComplete ? FILL_DONE : FILL[spec.tone ?? 'normal']
  const done = clamp(spec.done)
  const reach = clamp(spec.done + spec.estimate)
  const pill = (width: number, extra: string) =>
    width <= 0 ? '' : `<rect x="0" y="0" width="${pct(width)}%" height="${height}" rx="${r}" ry="${r}" ${extra}/>`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${height}">`,
    title ? `<title>${escape(title)}</title>` : '',
    `<rect x="0" y="0" width="100%" height="${height}" rx="${r}" ry="${r}" fill="${TRACK}"/>`,
    reach > done ? pill(reach, `fill="${fill}" fill-opacity="${ESTIMATE_OPACITY}"`) : '',
    pill(done, `fill="${fill}"`),
    `</svg>`,
  ].join('')
}

/** The terminal's bar: heavy line for done, a dotted stretch for the estimate, light for the rest. */
export function barText(spec: BarSpec, width: number): { done: string; estimate: string; rest: string } {
  const cells = Math.max(4, width)
  const done = Math.round(clamp(spec.done) * cells)
  const estimate = Math.min(cells - done, Math.round(clamp(spec.estimate) * cells))
  return { done: '━'.repeat(done), estimate: '┅'.repeat(estimate), rest: '─'.repeat(cells - done - estimate) }
}

/** `86%`, padded with figure spaces so a column of them lines up. */
export function percent(fraction: number): string {
  return `${Math.round(clamp(fraction) * 100)}%`.padStart(4, ' ')
}
