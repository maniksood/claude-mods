import type { RunState } from './logic'

const SKIN = '#ffd9b3'
const INK = '#3b3b3b'

const anim = (attr: string, values: string, dur: string, extra = ''): string =>
  `<animate attributeName="${attr}" values="${values}" dur="${dur}" repeatCount="indefinite" ${extra}/>`

const move = (values: string, dur: string, type = 'translate'): string =>
  `<animateTransform attributeName="transform" type="${type}" values="${values}" dur="${dur}" repeatCount="indefinite" additive="sum"/>`

/** The little worker, feet at (0,0), facing right. `face` picks the eyes. */
const worker = (color: string, face: 'open' | 'closed' | 'x', moveHands = false): string => {
  const eyes =
    face === 'closed'
      ? `<path d="M-5 -39h3M2 -39h3" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`
      : face === 'x'
        ? `<path d="M-6 -41l3 3m0-3l-3 3M3 -41l3 3m0-3l-3 3" stroke="${INK}" stroke-width="1.3"/>`
        : `<circle cx="-3" cy="-39" r="1.5" fill="${INK}"/><circle cx="4" cy="-39" r="1.5" fill="${INK}"/>`
  const hands = moveHands
    ? `<circle cx="9" cy="-17" r="3" fill="${SKIN}">${anim('cy', '-17;-14;-17', '0.35s')}</circle>`
    : `<circle cx="9" cy="-17" r="3" fill="${SKIN}"/>`
  return (
    `<rect x="-5" y="-12" width="3.5" height="12" rx="1.5" fill="${INK}"/><rect x="1.5" y="-12" width="3.5" height="12" rx="1.5" fill="${INK}"/>` +
    `<rect x="-9" y="-31" width="18" height="21" rx="7" fill="${color}"/>` +
    `<circle cx="0" cy="-40" r="10" fill="${SKIN}"/>${eyes}${hands}`
  )
}

const laptop = (): string =>
  `<rect x="10" y="-15" width="17" height="11" rx="1.5" fill="#d0d4da" stroke="${INK}" stroke-width="1"/>` +
  `<rect x="8" y="-4" width="21" height="3" rx="1.5" fill="#9aa1ab"/>` +
  `<rect x="13" y="-12" width="4" height="1.6" fill="#51cf66">${anim('width', '4;10;4', '0.5s')}</rect>`

const bubbles = (): string =>
  [0, 1, 2]
    .map(
      i =>
        `<circle cx="${24 + i * 4}" cy="-22" r="2" fill="#74c0fc" opacity="0">${anim('cy', '-22;-48', '1.4s', `begin="${i * 0.45}s"`)}${anim('opacity', '0.9;0', '1.4s', `begin="${i * 0.45}s"`)}</circle>`,
    )
    .join('')

const tube = (): string =>
  `<g><rect x="17" y="-30" width="6" height="16" rx="3" fill="#e7f5ff" stroke="${INK}" stroke-width="1"/><rect x="18" y="-22" width="4" height="7" rx="2" fill="#51cf66"/></g>${bubbles()}`

const mutant = (): string =>
  `<g><ellipse cx="30" cy="-10" rx="8" ry="7" fill="#9c36b5">${anim('ry', '7;5;7', '0.4s')}</ellipse><circle cx="27" cy="-12" r="1.4" fill="#fff"/><circle cx="33" cy="-12" r="1.4" fill="#fff"/>` +
  `<path d="M16 -34l-4 7h5l-4 8" fill="none" stroke="#fab005" stroke-width="2" stroke-linejoin="round">${anim('opacity', '1;0;1', '0.3s')}</path></g>`

const zzz = (): string =>
  [0, 1, 2]
    .map(
      i =>
        `<text x="${12 + i * 7}" y="-46" font-size="${8 + i * 2}" fill="#868e96" font-family="sans-serif" opacity="0">z${anim('opacity', '0;1;0', '2s', `begin="${i * 0.6}s"`)}${anim('y', '-46;-62', '2s', `begin="${i * 0.6}s"`)}</text>`,
    )
    .join('')

const confetti = (): string =>
  ['#ff6b6b', '#fcc419', '#51cf66', '#339af0', '#cc5de8', '#ff922b']
    .map(
      (c, i) =>
        `<rect x="${-22 + i * 9}" y="-70" width="4" height="4" fill="${c}">${anim('y', '-70;-8', `${1 + (i % 3) * 0.3}s`, `begin="${i * 0.15}s"`)}${anim('opacity', '1;1;0', `${1 + (i % 3) * 0.3}s`, `begin="${i * 0.15}s"`)}</rect>`,
    )
    .join('')

const headInHands = (): string =>
  `<circle cx="-12" cy="-44" r="3.2" fill="${SKIN}"/><circle cx="12" cy="-44" r="3.2" fill="${SKIN}"/>`

/** The scene around one worker, per state. */
const scene = (state: RunState, color: string): string => {
  switch (state) {
    case 'building':
      return `<g>${worker(color, 'open', true)}${laptop()}</g>`
    case 'testing':
      return `<g>${worker(color, 'open')}${tube()}</g>`
    case 'mutation':
      return `<g>${worker(color, 'open')}${mutant()}</g>`
    case 'quiet':
      return `<g transform="rotate(8 0 -30)">${worker(color, 'closed')}</g>${zzz()}`
    case 'done':
      return `<g>${move('0 0;0 -12;0 0', '0.5s')}${worker(color, 'open')}</g>${confetti()}`
    case 'failed':
      return `<g>${worker(color, 'x')}${headInHands()}</g>`
  }
}

/** The small character beside a card's title: one worker, no path, no flags, no helper. */
export const avatarSvg = (state: RunState, color: string, size = 32): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-26 -66 78 72" width="${size}" height="${Math.round((size * 72) / 78)}" role="img" aria-label="${state}">` +
  `<g transform="translate(0 0)">${scene(state, color)}</g></svg>`
