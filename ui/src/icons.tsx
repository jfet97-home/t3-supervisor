import type { CSSProperties } from "react";

const paths = {
  home: "m3 10 9-7 9 7v10H3Z M9 20v-7h6v7",
  projects: "M3 4h7v7H3Z M14 4h7v7h-7Z M3 15h7v6H3Z M14 15h7v6h-7Z",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  guide: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4Z M13 7a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2",
  arrow: "M5 12h14 m-6-6 6 6-6 6",
  search: "M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6",
  refresh: "M20 7v5h-5 M20 12a8 8 0 1 0-2 6",
  external: "M14 3h7v7 M21 3 10 14 M10 3H3v18h18v-7",
  check: "m4 12 5 5L20 6",
  alert: "M12 3 2 21h20Z M12 9v5 M12 17v1",
} as const;

export function Icon({name, size = 20, style}: {name: keyof typeof paths; size?: number; style?: CSSProperties}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]}/></svg>;
}
