// Minimal ANSI SGR → HTML for R output (cli/tibble colour their printing).
// Handles bold/faint/italic/underline and 16/256/truecolor foregrounds and
// backgrounds; everything else is dropped.

const BASIC = ['#000000', '#c23621', '#25bc24', '#adad27', '#492ee1', '#d338d3', '#33bbc8', '#cbcccd'];
const BRIGHT = ['#818383', '#fc391f', '#31e722', '#eaec23', '#5833ff', '#f935f8', '#14f0f0', '#e9ebeb'];

function color256(n: number): string {
  if (n < 8) return BASIC[n];
  if (n < 16) return BRIGHT[n - 8];
  if (n < 232) {
    const i = n - 16;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `rgb(${v(Math.floor(i / 36))},${v(Math.floor(i / 6) % 6)},${v(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function ansiToHtml(text: string): string {
  // Drop non-SGR escape sequences (cursor movement, hyperlinks, …).
  const clean = text.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '');
  if (!clean.includes('\x1b[')) return escapeHtml(clean);
  let fg = '';
  let bg = '';
  let bold = false;
  let faint = false;
  let italic = false;
  let underline = false;
  let html = '';
  const parts = clean.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (!parts[i]) continue;
      const style = [
        fg && `color:${fg}`,
        bg && `background:${bg}`,
        bold && 'font-weight:600',
        faint && 'opacity:.65',
        italic && 'font-style:italic',
        underline && 'text-decoration:underline',
      ].filter(Boolean);
      html += style.length ? `<span style="${style.join(';')}">${escapeHtml(parts[i])}</span>` : escapeHtml(parts[i]);
      continue;
    }
    const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number);
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (c === 0) [fg, bg, bold, faint, italic, underline] = ['', '', false, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) faint = true;
      else if (c === 3) italic = true;
      else if (c === 4) underline = true;
      else if (c === 22) bold = faint = false;
      else if (c === 23) italic = false;
      else if (c === 24) underline = false;
      else if (c >= 30 && c <= 37) fg = BASIC[c - 30];
      else if (c >= 90 && c <= 97) fg = BRIGHT[c - 90];
      else if (c >= 40 && c <= 47) bg = BASIC[c - 40];
      else if (c >= 100 && c <= 107) bg = BRIGHT[c - 100];
      else if (c === 39) fg = '';
      else if (c === 49) bg = '';
      else if ((c === 38 || c === 48) && codes[j + 1] === 5) {
        const col = color256(codes[j + 2] ?? 0);
        if (c === 38) fg = col;
        else bg = col;
        j += 2;
      } else if ((c === 38 || c === 48) && codes[j + 1] === 2) {
        const col = `rgb(${codes[j + 2] ?? 0},${codes[j + 3] ?? 0},${codes[j + 4] ?? 0})`;
        if (c === 38) fg = col;
        else bg = col;
        j += 4;
      }
    }
  }
  return html;
}
