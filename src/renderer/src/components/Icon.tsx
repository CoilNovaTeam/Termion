// Набор иконок Termion (16×16, обводка). Перенесён из макета.

const P_FOLDER =
  '<path d="M1.75 4.5c0-.83.67-1.5 1.5-1.5h2.8l1.4 1.5h5.3c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5z" fill="currentColor" fill-opacity=".2"/>'
const P_FILE =
  '<path d="M4.2 1.75h4.9l3.15 3.15v8.35c0 .55-.45 1-1 1H4.2c-.55 0-1-.45-1-1V2.75c0-.55.45-1 1-1z"/><path d="M9 1.9v3.1h3.1"/>'

const PATHS = {
  chev: '<path d="M6 4l4 4-4 4"/>',
  folder: P_FOLDER,
  folderPlus: P_FOLDER + '<path d="M8.6 7.2v4M6.6 9.2h4"/>',
  file: P_FILE,
  filePlus: P_FILE + '<path d="M7.7 8.2v4M5.7 10.2h4"/>',
  up: '<path d="M8 13V3.5M4.2 7.2L8 3.4l3.8 3.8"/>',
  upload: '<path d="M8 10.5V2.8M4.8 6L8 2.8 11.2 6"/><path d="M2.8 10.5v2.7h10.4v-2.7"/>',
  download: '<path d="M8 2.8v7.7M4.8 7.3L8 10.5l3.2-3.2"/><path d="M2.8 10.5v2.7h10.4v-2.7"/>',
  link: '<path d="M6.6 9.4l2.8-2.8"/><path d="M5.3 7.4L4 8.7a2.3 2.3 0 0 0 3.3 3.3l1.3-1.3"/><path d="M10.7 8.6L12 7.3A2.3 2.3 0 0 0 8.7 4L7.4 5.3"/>',
  save: '<path d="M3 2.6h7.7l2.4 2.4v8.4H3z"/><path d="M5.2 2.6v3.2h5V2.6M5.2 13.4V9.6h5.6v3.8"/>',
  home: '<path d="M2.6 7.6L8 3l5.4 4.6"/><path d="M4.2 6.4v6.8h2.9V10h1.8v3.2h2.9V6.4"/>',
  target: '<circle cx="8" cy="8" r="5.3"/><circle cx="8" cy="8" r="1.7"/>',
  wrap: '<path d="M2.6 4.2h10.8M2.6 8h8.6a2.1 2.1 0 0 1 0 4.2H8.4"/><path d="M9.9 10.7l-1.5 1.5 1.5 1.5M2.6 12.2h3.4"/>',
  bolt: '<path d="M9.2 1.6L3.6 9.1h4.1l-1 5.3 5.7-7.6H8.3z"/>',
  play: '<path d="M4.8 2.9v10.2L13 8z" fill="currentColor" stroke="none"/>',
  git: '<path d="M8 1.9l6.1 6.1L8 14.1 1.9 8z"/><circle cx="8" cy="5.4" r="1.05"/><circle cx="8" cy="10.6" r="1.05"/><path d="M8 6.5v3"/>',
  linux:
    '<path d="M8 2.2c-1.6 0-2.6 1.3-2.6 3.1 0 1-.2 1.6-.8 2.5-.8 1.2-1.4 2.6-1.4 3.8 0 .7.4 1.2 1 1.4.9.3 2 .8 3.8.8s2.9-.5 3.8-.8c.6-.2 1-.7 1-1.4 0-1.2-.6-2.6-1.4-3.8-.6-.9-.8-1.5-.8-2.5 0-1.8-1-3.1-2.6-3.1z"/><path d="M7 5.4h.01M9 5.4h.01M7.2 7.2L8 7.8l.8-.6"/>',
  arrowLink: '<path d="M4.5 11.5l7-7M6 4.5h5.5V10"/>',
  more: '<circle cx="3.6" cy="8" r=".95" fill="currentColor"/><circle cx="8" cy="8" r=".95" fill="currentColor"/><circle cx="12.4" cy="8" r=".95" fill="currentColor"/>',
  server:
    '<rect x="2" y="2.5" width="12" height="4.6" rx="1.3"/><rect x="2" y="8.9" width="12" height="4.6" rx="1.3"/><path d="M4.6 4.8h.01M4.6 11.2h.01"/>',
  term: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.6"/><path d="M4.6 6.4l2 1.6-2 1.6M8.2 10h3.2"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.55"/><path d="M13 2.6v3h-3"/>',
  x: '<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="M10.3 10.3l3.4 3.4"/>',
  gear: '<circle cx="8" cy="8" r="2.1"/><path d="M8 1.9v1.7M8 12.4v1.7M1.9 8h1.7M12.4 8h1.7M3.7 3.7l1.2 1.2M11.1 11.1l1.2 1.2M3.7 12.3l1.2-1.2M11.1 4.9l1.2-1.2"/>',
  lock: '<rect x="3.2" y="7" width="9.6" height="6.6" rx="1.4"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
  key: '<circle cx="5.3" cy="10.7" r="2.6"/><path d="M7.2 8.8l5.6-5.6M10.6 5.4l1.6 1.6M11.8 4.2l1.3 1.3"/>',
  agent: '<circle cx="8" cy="5.2" r="2.4"/><path d="M3.4 13.6c.6-2.5 2.4-3.9 4.6-3.9s4 1.4 4.6 3.9"/>',
  collapse: '<path d="M4.5 6.2L8 3.2l3.5 3M4.5 9.8l3.5 3 3.5-3"/>',
  expand: '<path d="M4.5 3.4L8 6.4l3.5-3M4.5 12.6l3.5-3 3.5 3"/>',
  edit: '<path d="M10.8 2.7l2.5 2.5-7.8 7.8-3 .5.5-3z"/>',
  trash: '<path d="M3 4.5h10M6.2 4.5V3h3.6v1.5M4.4 4.5l.6 8.6c0 .5.4.9.9.9h4.2c.5 0 .9-.4.9-.9l.6-8.6"/>',
  copy: '<rect x="5.2" y="5.2" width="8" height="8" rx="1.3"/><path d="M10.8 5.2V3.8c0-.6-.5-1.1-1.1-1.1H3.8c-.6 0-1.1.5-1.1 1.1v5.9c0 .6.5 1.1 1.1 1.1h1.4"/>',
  paste: '<rect x="3" y="3.2" width="10" height="11" rx="1.4"/><path d="M6 3.2V2.4h4v.8M5.6 7.2h4.8M5.6 9.8h3.4"/>',
  plug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0z"/><path d="M8 11.2v2.3"/>',
  unplug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0z"/><path d="M8 11.2v2.3M2.5 2.5l11 11"/>',
  eye: '<path d="M1.6 8s2.4-4.6 6.4-4.6S14.4 8 14.4 8s-2.4 4.6-6.4 4.6S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="2"/>',
  eyeOff:
    '<path d="M2.2 2.2l11.6 11.6M6.6 3.6A7 7 0 0 1 8 3.4c4 0 6.4 4.6 6.4 4.6a12 12 0 0 1-1.9 2.4M4.2 4.9C2.6 6.2 1.6 8 1.6 8s2.4 4.6 6.4 4.6c1 0 1.9-.3 2.7-.7"/><path d="M6.6 6.7a2 2 0 0 0 2.7 2.7"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v3.6M8 5h.01"/>',
  check: '<path d="M3.4 8.4l3 3 6.2-6.8"/>',
  warn: '<path d="M8 2.2l6.2 11H1.8z"/><path d="M8 6.6v3M8 11.6h.01"/>',
  shield: '<path d="M8 1.8l5.2 2v4.1c0 3-2.2 5.4-5.2 6.3-3-.9-5.2-3.3-5.2-6.3V3.8z"/><path d="M5.8 8.1l1.6 1.6 2.9-3.2"/>',
  shieldAlert: '<path d="M8 1.8l5.2 2v4.1c0 3-2.2 5.4-5.2 6.3-3-.9-5.2-3.3-5.2-6.3V3.8z"/><path d="M8 5.4v3.2M8 10.8h.01"/>',
  duplicate: '<rect x="2.5" y="4.5" width="8" height="9" rx="1.3"/><path d="M5.5 4.5V3.3c0-.5.4-.8.8-.8h6.4c.5 0 .8.4.8.8v6.4c0 .5-.4.8-.8.8h-2.2"/>',
  selectAll: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5" stroke-dasharray="2 1.6"/><path d="M5.5 8h5"/>',
  eraser: '<path d="M9.2 2.8l4 4-6.6 6.6H3.8l-1.6-1.6a1 1 0 0 1 0-1.4z"/><path d="M6.4 5.6l4 4M7 13.4h6.5"/>',
  external: '<path d="M9 2.8h4.2V7M13.2 2.8L7.4 8.6"/><path d="M11.4 9.6v2.6c0 .6-.5 1-1 1H3.8c-.6 0-1-.4-1-1V5.6c0-.5.4-1 1-1h2.6"/>',
  layout: '<rect x="2" y="2.6" width="12" height="10.8" rx="1.6"/><path d="M6.2 2.6v10.8"/>',
  palette: '<path d="M8 1.9a6.1 6.1 0 1 0 0 12.2c.9 0 1.3-.6 1.1-1.3-.3-.9.2-1.7 1.2-1.7h1.3c1.6 0 2.5-1.1 2.5-2.7 0-3.6-2.7-6.5-6.1-6.5z"/><circle cx="5.2" cy="7.2" r=".7" fill="currentColor"/><circle cx="7.6" cy="4.8" r=".7" fill="currentColor"/><circle cx="10.6" cy="5.9" r=".7" fill="currentColor"/>',
  minus: '<path d="M3.2 8h9.6"/>'
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, className, size = 16 }: { name: IconName; className?: string; size?: number }) {
  return (
    <svg
      className={className ? `ic ${className}` : 'ic'}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  )
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="1" y="1" width="22" height="22" rx="6.5" fill="var(--accent)" />
      <path
        d="M7 8.3l3.6 3.7L7 15.7"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="2.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.8 16.2h4.6" stroke="var(--on-accent)" strokeWidth="2.3" strokeLinecap="round" />
    </svg>
  )
}
