// Minimal, safe Markdown renderer for assistant messages (escapes HTML first).
import { esc } from './ui.js';

const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v ?? '').replace(/[$,%\s,]/g, ''));
  return Number.isFinite(n) ? n : null;
};

function fmt(v, kind) {
  const n = num(v);
  if (n === null) return esc(v ?? '');
  if (kind === 'percent') return `${(Math.abs(n) <= 1 ? n * 100 : n).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  if (kind === 'currency') return n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 && n % 1 ? 2 : 0 });
}

function chartBlock(raw) {
  let c;
  try { c = JSON.parse(raw); } catch { return `<pre><code>${esc(raw)}</code></pre>`; }
  const rows = Array.isArray(c.rows) ? c.rows : Array.isArray(c.data) ? c.data : [];
  if (!rows.length || typeof rows[0] !== 'object') return `<pre><code>${esc(raw)}</code></pre>`;
  const keys = Object.keys(rows[0]);
  const x = c.x || c.category || keys.find((k) => rows.some((r) => num(r[k]) === null)) || keys[0];
  const ys = (Array.isArray(c.y) ? c.y : Array.isArray(c.series) ? c.series : [c.y || c.value || keys.find((k) => k !== x && rows.some((r) => num(r[k]) !== null))]).filter(Boolean);
  const data = rows.slice(0, Math.min(Number(c.maxRows) || 12, 24)).map((r) => ({ label: String(r[x] ?? ''), values: ys.map((y) => num(r[y])) }));
  if (!ys.length || !data.some((r) => r.values.some((v) => v !== null))) return table([`| ${keys.join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`, ...rows.slice(0, 24).map((r) => `| ${keys.map((k) => r[k] ?? '').join(' | ')} |`)]);
  const colors = ['var(--brand)', 'var(--good)', 'var(--warn)', '#8b5cf6', '#06b6d4'];
  const vals = data.flatMap((r) => r.values).filter((v) => v !== null);
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const top = 20, left = 58, bottom = 56, W = 760, H = 310, plotW = W - left - 18, plotH = H - top - bottom;
  const range = max === min ? Math.max(1, Math.abs(max)) : max - min;
  const yOf = (v) => top + (max - v) / range * plotH;
  const zero = yOf(Math.max(0, Math.min(max, 0)));
  const safe = (s) => esc(String(s ?? ''));
  const title = c.title ? `<div class="ctitle">${safe(c.title)}</div>` : '';
  const sub = c.subtitle ? `<div class="csub">${safe(c.subtitle)}</div>` : '';
  const legend = ys.length > 1 ? `<div class="clegend">${ys.map((y, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${safe(y)}</span>`).join('')}</div>` : '';
  let marks = `<line x1="${left}" y1="${zero}" x2="${W - 12}" y2="${zero}" class="axis"/>`;
  marks += [0, .25, .5, .75, 1].map((p) => {
    const v = max - p * range, y = top + p * plotH;
    return `<line x1="${left}" y1="${y}" x2="${W - 12}" y2="${y}" class="grid"/><text x="${left - 8}" y="${y + 4}" text-anchor="end">${fmt(v, c.format?.[ys[0]] || c.format)}</text>`;
  }).join('');
  if ((c.type || 'bar') === 'line') {
    ys.forEach((name, si) => {
      const pts = data.map((r, i) => {
        const v = r.values[si];
        if (v === null) return null;
        return `${left + (data.length === 1 ? .5 : i / (data.length - 1)) * plotW},${yOf(v)}`;
      }).filter(Boolean);
      marks += `<polyline fill="none" stroke="${colors[si % colors.length]}" stroke-width="3" points="${pts.join(' ')}"/>`;
      for (const p of pts) { const [x1, y1] = p.split(','); marks += `<circle cx="${x1}" cy="${y1}" r="3.5" fill="${colors[si % colors.length]}"/>`; }
    });
  } else {
    const group = plotW / data.length;
    const gap = Math.min(16, group * .22);
    const bw = Math.max(4, (group - gap) / ys.length);
    data.forEach((r, i) => r.values.forEach((v, si) => {
      if (v === null) return;
      const x1 = left + i * group + gap / 2 + si * bw;
      const y1 = Math.min(yOf(v), zero);
      const h = Math.max(1, Math.abs(zero - yOf(v)));
      marks += `<rect x="${x1}" y="${y1}" width="${bw * .86}" height="${h}" rx="3" fill="${colors[si % colors.length]}"><title>${safe(r.label)} · ${safe(ys[si])}: ${fmt(v, c.format?.[ys[si]] || c.format)}</title></rect>`;
    }));
  }
  marks += data.map((r, i) => {
    const x1 = left + (i + .5) * plotW / data.length;
    const label = r.label.length > 13 ? `${r.label.slice(0, 12)}…` : r.label;
    return `<text x="${x1}" y="${H - 28}" text-anchor="middle" class="xlabel">${safe(label)}</text>`;
  }).join('');
  const values = data.slice(0, 6).map((r) => `<div><b>${safe(r.label)}</b>${r.values.map((v, i) => v === null ? '' : ` · ${safe(ys[i])}: ${fmt(v, c.format?.[ys[i]] || c.format)}`).join('')}</div>`).join('');
  return `<div class="chart">${title}${sub}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(c.title || 'Chart')}">${marks}</svg>${legend}<div class="cvals">${values}</div></div>`;
}

function inline(s) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
}

function table(lines) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

export function md(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w-]+)?/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(/^studio-chart$/i.test(fence[1] || '') ? chartBlock(buf.join('\n')) : `<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const buf = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) buf.push(lines[i++]);
      out.push(table(buf));
      continue;
    }
    const hd = line.match(/^(#{1,4})\s+(.*)$/);
    if (hd) { out.push(`<h${hd[1].length + 1}>${inline(hd[2])}</h${hd[1].length + 1}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const l = lines[i++];
        if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) items.push(l.replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
        else items[items.length - 1] += ` ${l.trim()}`;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (buf.length) out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    else { out.push(`<p>${inline(lines[i])}</p>`); i++; }
  }
  return out.join('');
}
