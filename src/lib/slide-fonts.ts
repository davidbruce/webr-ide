// Web fonts for the slide themes, bundled from Fontsource (Latin subset,
// woff2) so presentations need no network and work under cross-origin
// isolation. Only the families a theme uses are inlined into its page.

const FILES = import.meta.glob('/node_modules/@fontsource/{source-sans-3,league-gothic,lato,montserrat,news-cycle,open-sans,quicksand,ubuntu}/files/*-latin-{400,600,700}-{normal,italic}.woff2', {
  query: '?inline',
  import: 'default',
}) as Record<string, () => Promise<string>>;

/** CSS family name → Fontsource package. */
const FAMILIES: Record<string, string> = {
  'Source Sans Pro': 'source-sans-3',
  'League Gothic': 'league-gothic',
  Lato: 'lato',
  Montserrat: 'montserrat',
  'News Cycle': 'news-cycle',
  'Open Sans': 'open-sans',
  Quicksand: 'quicksand',
  Ubuntu: 'ubuntu',
};

/** Families each theme needs (others use system fonts). */
export const THEME_FONTS: Record<string, string[]> = {
  default: ['Source Sans Pro'],
  dark: ['Source Sans Pro'],
  beige: ['Lato', 'League Gothic'],
  league: ['Lato', 'League Gothic'],
  moon: ['Lato', 'League Gothic'],
  solarized: ['Lato', 'League Gothic'],
  blood: ['Ubuntu'],
  night: ['Open Sans', 'Montserrat'],
  simple: ['Lato', 'News Cycle'],
  sky: ['Open Sans', 'Quicksand'],
  serif: [],
  dracula: [],
};

/** @font-face rules (with the font files inlined) for a theme. */
export async function themeFontCss(theme: string): Promise<string> {
  const rules: string[] = [];
  for (const family of THEME_FONTS[theme] ?? []) {
    const pkg = FAMILIES[family];
    for (const [path, load] of Object.entries(FILES)) {
      const m = new RegExp(`/@fontsource/${pkg}/files/${pkg}-latin-(\\d+)-(normal|italic)\\.woff2$`).exec(path);
      if (!m) continue;
      rules.push(`@font-face{font-family:"${family}";font-style:${m[2]};font-weight:${m[1]};font-display:block;src:url(${await load()}) format("woff2")}`);
    }
  }
  return rules.join('\n');
}
