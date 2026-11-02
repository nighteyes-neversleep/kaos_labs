import type { CSSProperties } from 'react';
const paths: Record<string, string> = {
  grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  shield: 'M12 3 3.5 6.5V12c0 4.5 4 7.7 8.5 9 4.5-1.3 8.5-4.5 8.5-9V6.5L12 3Z M8 12l3 3 5-6',
  apps: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  capsule: 'M8 4h8a5 5 0 0 1 5 5v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z M12 4v16 M9 9h6 M9 15h6',
  share: 'M8.5 8.5l7-4 M8.5 15.5l7 4 M6 8a3 3 0 1 0 0 0.01 M18 2a3 3 0 1 0 0 .01 M18 16a3 3 0 1 0 0 .01',
  chain: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  lock: 'M7 10V7a5 5 0 0 1 10 0v3 M5 10h14v11H5z M12 14v3',
  unlock: 'M7 10V7a5 5 0 0 1 9-3 M5 10h14v11H5z M12 14v3',
  close: 'M6 6l12 12 M6 18 18 6',
  search: 'M10.5 3a7.5 7.5 0 1 0 0 .01 M16 16l5 5',
  menu: 'M4 6h16 M4 12h16 M4 18h16',
  check: 'M5 12l4 4L19 6',
  download: 'M12 3v12 M7 10l5 5 5-5 M4 16v5h16v-5',
  bird: 'm3 5 6 5 3-6 3 6 6-5-4 10-5 5-5-5L3 5Z M8 12h8',
  flask: 'M9 3h6 M10 3v7L4 20h16l-6-10V3 M8 15h8',
  globe: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M2 12h20 M12 2c-5 5-5 15 0 20 5-5 5-15 0-20Z',
  spark: 'm12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5L12 2Z',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M12 6v6l4 2',
  info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z M12 11v6 M12 7v.1',
  leaf: 'M20 3C7 1 2 8 5 15c5 8 17 1 15-12Z M6 18 17 7',
  layers: 'm12 2 10 6-10 6L2 8l10-6Z M2 12l10 6 10-6 M2 16l10 6 10-6',
  eye: 'M2 12c5-9 15-9 20 0-5 9-15 9-20 0Z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  power: 'M12 2v10 M6 5a9 9 0 1 0 12 0',
};
export function Icon({ name, size = 20, className = '', style }: { name: string; size?: number; className?: string; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} style={style} aria-hidden="true"><path d={paths[name] || paths.spark} /></svg>;
}
export function OmiMark({ className = '' }: {className?: string}) {
  return <svg className={className} viewBox="0 0 64 64" fill="none" aria-hidden="true"><circle cx="32" cy="32" r="21" stroke="currentColor" strokeWidth="1.5"/><ellipse cx="32" cy="32" rx="29" ry="12" transform="rotate(-35 32 32)" stroke="currentColor" strokeWidth="1.5"/><ellipse cx="32" cy="32" rx="12" ry="29" transform="rotate(-35 32 32)" stroke="currentColor" strokeWidth="1.5"/><circle cx="32" cy="32" r="5" fill="currentColor"/><circle cx="53" cy="17" r="3" fill="currentColor"/></svg>;
}
