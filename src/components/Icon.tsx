import { JSX } from 'solid-js';

// Small stroke icon set (24×24 grid, currentColor).
const paths: Record<string, JSX.Element> = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  'run-all': (
    <>
      <path d="M4 4.5v15l9-7.5z" fill="currentColor" stroke="none" />
      <path d="M12 4.5v15l9-7.5z" fill="currentColor" stroke="none" />
    </>
  ),
  book: (
    <>
      <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
      <path d="M4 21V5M8 7h7M8 11h5" />
    </>
  ),
  source: (
    <>
      <path d="M4 5h9M4 10h7M4 15h5" />
      <path d="M14 11v9l7-4.5z" fill="currentColor" stroke="none" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 4v5h7V4M8 20v-6h8v6" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  broom: (
    <>
      <path d="M19 3l-8 8" />
      <path d="M11 11c-3 0-6 2-7 9 3 0 7-1 9-3l1-3z" />
      <path d="M8 15l-2 3M11 16l-1.5 3" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L4 8" />
      <path d="M4 3v5h5" />
      <path d="M4 13a8 8 0 0 0 14.5 4.5L20 16" />
      <path d="M20 21v-5h-5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  'file-plus': (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M12 11v6M9 14h6" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  'folder-open': (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H8.5a2 2 0 0 0-1.9 1.4L4 19H5a2 2 0 0 1-2-2zM4 19l2.6-7.6A2 2 0 0 1 8.5 10H21l-2.5 7.6A2 2 0 0 1 16.6 19z" />
  ),
  'folder-plus': (
    <>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      <path d="M12 10v6M9 13h6" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11M7 10l5 5 5-5" />
      <path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" />
    </>
  ),
  chevron: <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  left: <path d="M15 6l-6 6 6 6" />,
  right: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: (
    <>
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  expand: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  maximize: <rect x="4" y="4" width="16" height="16" rx="2" />,
  restore: (
    <>
      <rect x="4" y="8" width="12" height="12" rx="2" />
      <path d="M8 8V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />,
  grid: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M3 15h18M9 4v16" />
    </>
  ),
  box: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  'to-console': (
    <>
      <path d="M4 17l5-5-5-5M12 19h8" />
    </>
  ),
  'to-source': (
    <>
      <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  edit: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  outline: <path d="M4 6h16M8 12h12M8 18h12M4 12h.01M4 18h.01" />,
  'step-over': (
    <>
      <path d="M4 13a8 8 0 0 1 15-3.5M19 4v6h-6" />
      <circle cx="12" cy="18" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  'step-into': (
    <>
      <path d="M12 3v11M7 9l5 5 5-5" />
      <circle cx="12" cy="19.5" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  'step-out': (
    <>
      <path d="M12 15V4M7 9l5-5 5 5" />
      <circle cx="12" cy="19.5" r="2" fill="currentColor" stroke="none" />
    </>
  ),
  continue: <path d="M5 4.5v15M10 4.5v15l10-7.5z" />,
  bug: (
    <>
      <path d="M8 8a4 4 0 0 1 8 0v7a4 4 0 0 1-8 0zM12 11v8M3 13h5M16 13h5M4 7l4 3M20 7l-4 3M4 19l4-3M20 19l-4-3" />
    </>
  ),
  command: <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z" />,
  replace: (
    <>
      <path d="M4 7h11l-3-3M20 17H9l3 3" />
    </>
  ),
  check: <path d="M5 12l5 5 9-10" />,
  'arrow-up': <path d="M12 19V5M6 11l6-6 6 6" />,
  'arrow-down': <path d="M12 5v14M6 13l6 6 6-6" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  tab: <path d="M4 12h13M12 7l5 5-5 5M20 6v12" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3" />,
  backspace: <path d="M21 5H9l-6 7 6 7h12zM12 9l6 6M18 9l-6 6" />,
  shift: <path d="M12 4l8 8h-4v7H8v-7H4z" />,
  'shift-on': <path d="M12 4l8 8h-4v7H8v-7H4z" fill="currentColor" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  return: <path d="M20 5v7H6M10 8l-4 4 4 4" />,
  keyboard: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3" />,
  offline: (
    <>
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5a4 4 0 0 1-.5 7.97" />
      <path d="M9 15l2.5 2.5L16 13" />
    </>
  ),
  power: (
    <>
      <path d="M12 3v9" />
      <path d="M6.3 7a8 8 0 1 0 11.4 0" />
    </>
  ),
  r: <text x="12" y="17" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor" stroke="none" font-family="-apple-system, Helvetica, Arial">R</text>,
};

// Icon nodes are created once; each use gets a deep clone so nodes aren't moved around the DOM.
function cloneIcon(n: JSX.Element): JSX.Element {
  if (!n) return null;
  if (Array.isArray(n)) return n.map((x) => cloneIcon(x));
  return n instanceof Node ? n.cloneNode(true) : n;
}

export function Icon(props: { name: string; size?: number; class?: string; title?: string }) {
  return (
    <svg
      class={`icon ${props.class ?? ''}`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden={props.title ? undefined : 'true'}
    >
      {props.title && <title>{props.title}</title>}
      {cloneIcon(paths[props.name])}
    </svg>
  );
}
