// Minimal, safe Markdown renderer for assistant messages (escapes HTML first).
import { esc } from './ui.js';

const PALETTE = ['var(--brand)', 'var(--good)', 'var(--warn)', '#8b5cf6', '#06b6d4', '#ec4899', '#f97316', '#64748b'];
const SHORT = (s, n = 14) => (String(s || '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s || ''));

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

const kind = (t) => String(t || 'bar').toLowerCase().replace(/[\s_-]+/g, '');
const rowsOf = (c) => (Array.isArray(c.rows) ? c.rows : Array.isArray(c.data) ? c.data : []);
const safe = (s) => esc(String(s ?? ''));

function fields(c, rows) {
  const keys = Object.keys(rows[0] || {});
  const x = c.x || c.category || c.label || keys.find((k) => rows.some((r) => num(r[k]) === null)) || keys[0];
  const ys = (Array.isArray(c.y) ? c.y : Array.isArray(c.series) ? c.series : [c.y || c.value || keys.find((k) => k !== x && rows.some((r) => num(r[k]) !== null))]).filter(Boolean);
  const maxRows = Math.min(Number(c.maxRows) || 12, 36);
  const data = rows.slice(0, maxRows).map((r) => ({ raw: r, label: String(r[x] ?? ''), values: ys.map((y) => num(r[y])) }));
  return { keys, x, ys, data };
}

function shell(c, body, { legend = '', values = '', cls = '' } = {}) {
  const title = c.title ? `<div class="ctitle">${safe(c.title)}</div>` : '';
  const sub = c.subtitle ? `<div class="csub">${safe(c.subtitle)}</div>` : '';
  return `<div class="chart ${cls}">${title}${sub}${body}${legend}${values}</div>`;
}

function rowTable(rows, cls = 'tablechart') {
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const lines = [`| ${keys.join(' | ')} |`, `| ${keys.map(() => '---').join(' | ')} |`, ...rows.slice(0, 48).map((r) => `| ${keys.map((k) => r[k] ?? '').join(' | ')} |`)];
  return `<div class="chart ${cls}">${table(lines)}</div>`;
}

function cartesian(c, rows) {
  const { ys, data } = fields(c, rows);
  if (!ys.length || !data.some((r) => r.values.some((v) => v !== null))) return rowTable(rows);
  const type = kind(c.type);
  const vals = data.flatMap((r) => r.values).filter((v) => v !== null);
  const stacked = type === 'stackedbar' || type === 'stackedcolumn';
  const horizontal = type === 'horizontalbar' || type === 'barh' || type === 'hbar';
  const totals = stacked ? data.map((r) => r.values.reduce((a, v) => a + Math.max(0, v || 0), 0)) : vals;
  const max = Math.max(...totals, 0), min = stacked || horizontal ? 0 : Math.min(...vals, 0);
  const W = 760, H = 320, top = 22, left = horizontal ? 138 : 58, bottom = 58, plotW = W - left - 18, plotH = H - top - bottom;
  const range = max === min ? Math.max(1, Math.abs(max)) : max - min;
  const xOf = (v) => left + (v - min) / range * plotW;
  const yOf = (v) => top + (max - v) / range * plotH;
  const zeroX = xOf(Math.max(0, Math.min(max, 0)));
  const zeroY = yOf(Math.max(0, Math.min(max, 0)));
  let marks = '';
  if (horizontal) {
    marks += [0, .25, .5, .75, 1].map((p) => {
      const v = min + p * range, x = xOf(v);
      return `<line x1="${x}" y1="${top}" x2="${x}" y2="${H - bottom}" class="grid"/><text x="${x}" y="${H - 24}" text-anchor="middle">${fmt(v, c.format?.[ys[0]] || c.format)}</text>`;
    }).join('');
    const group = plotH / data.length, gap = Math.min(12, group * .25), bh = Math.max(5, (group - gap) / (stacked ? 1 : ys.length));
    data.forEach((r, i) => {
      marks += `<text x="${left - 8}" y="${top + i * group + group / 2 + 4}" text-anchor="end" class="xlabel">${safe(SHORT(r.label, 18))}</text>`;
      let acc = 0;
      r.values.forEach((v, si) => {
        if (v === null) return;
        const w = Math.abs(xOf(stacked ? acc + Math.max(0, v) : v) - (stacked ? xOf(acc) : zeroX));
        const x = stacked ? xOf(acc) : Math.min(xOf(v), zeroX);
        const y = top + i * group + gap / 2 + (stacked ? 0 : si * bh);
        marks += `<rect x="${x}" y="${y}" width="${Math.max(1, w)}" height="${bh * .85}" rx="3" fill="${PALETTE[si % PALETTE.length]}"><title>${safe(r.label)} · ${safe(ys[si])}: ${fmt(v, c.format?.[ys[si]] || c.format)}</title></rect>`;
        if (stacked) acc += Math.max(0, v);
      });
    });
  } else {
    marks += `<line x1="${left}" y1="${zeroY}" x2="${W - 12}" y2="${zeroY}" class="axis"/>`;
    marks += [0, .25, .5, .75, 1].map((p) => {
      const v = max - p * range, y = top + p * plotH;
      return `<line x1="${left}" y1="${y}" x2="${W - 12}" y2="${y}" class="grid"/><text x="${left - 8}" y="${y + 4}" text-anchor="end">${fmt(v, c.format?.[ys[0]] || c.format)}</text>`;
    }).join('');
    if (['line', 'area', 'combo'].includes(type)) {
      ys.forEach((name, si) => {
        const pts = data.map((r, i) => {
          const v = r.values[si];
          return v === null ? null : `${left + (data.length === 1 ? .5 : i / (data.length - 1)) * plotW},${yOf(v)}`;
        }).filter(Boolean);
        if (type === 'area' && pts.length) marks += `<polygon points="${pts.join(' ')} ${left + plotW},${zeroY} ${left},${zeroY}" fill="${PALETTE[si % PALETTE.length]}" opacity=".18"/>`;
        marks += `<polyline fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="3" points="${pts.join(' ')}"/>`;
        for (const p of pts) { const [x, y] = p.split(','); marks += `<circle cx="${x}" cy="${y}" r="3.5" fill="${PALETTE[si % PALETTE.length]}"/>`; }
      });
    } else {
      const group = plotW / data.length, gap = Math.min(16, group * .22), bw = Math.max(4, (group - gap) / (stacked ? 1 : ys.length));
      data.forEach((r, i) => {
        let acc = 0;
        r.values.forEach((v, si) => {
          if (v === null) return;
          const base = stacked ? yOf(acc) : zeroY;
          const y = stacked ? yOf(acc + Math.max(0, v)) : Math.min(yOf(v), zeroY);
          const h = stacked ? Math.max(1, base - y) : Math.max(1, Math.abs(zeroY - yOf(v)));
          const x = left + i * group + gap / 2 + (stacked ? 0 : si * bw);
          marks += `<rect x="${x}" y="${y}" width="${bw * .86}" height="${h}" rx="3" fill="${PALETTE[si % PALETTE.length]}"><title>${safe(r.label)} · ${safe(ys[si])}: ${fmt(v, c.format?.[ys[si]] || c.format)}</title></rect>`;
          if (stacked) acc += Math.max(0, v);
        });
      });
    }
    marks += data.map((r, i) => `<text x="${left + (i + .5) * plotW / data.length}" y="${H - 30}" text-anchor="middle" class="xlabel">${safe(SHORT(r.label))}</text>`).join('');
  }
  const legend = ys.length > 1 ? `<div class="clegend">${ys.map((y, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${safe(y)}</span>`).join('')}</div>` : '';
  const values = `<div class="cvals">${data.slice(0, 6).map((r) => `<div><b>${safe(r.label)}</b>${r.values.map((v, i) => v === null ? '' : ` · ${safe(ys[i])}: ${fmt(v, c.format?.[ys[i]] || c.format)}`).join('')}</div>`).join('')}</div>`;
  return shell(c, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(c.title || 'Chart')}">${marks}</svg>`, { legend, values });
}

const polar = (cx, cy, r, a) => `${cx + r * Math.cos((a - 90) * Math.PI / 180)},${cy + r * Math.sin((a - 90) * Math.PI / 180)}`;
function pie(c, rows) {
  const { ys, data } = fields(c, rows);
  const val = ys[0];
  const slices = data.map((r) => ({ label: r.label, v: Math.max(0, r.values[0] || 0) })).filter((r) => r.v > 0);
  const total = slices.reduce((a, r) => a + r.v, 0);
  if (!total) return rowTable(rows);
  let a = 0, paths = '';
  const donut = kind(c.type) === 'donut' || kind(c.type) === 'doughnut';
  for (const [i, s] of slices.entries()) {
    const b = a + s.v / total * 360, large = b - a > 180 ? 1 : 0;
    const p1 = polar(180, 150, 118, a), p2 = polar(180, 150, 118, b);
    const inner = donut ? `L${polar(180, 150, 60, b)} A60,60 0 ${large},0 ${polar(180, 150, 60, a)} Z` : 'L180,150 Z';
    paths += `<path d="M${p1} A118,118 0 ${large},1 ${p2} ${inner}" fill="${PALETTE[i % PALETTE.length]}"><title>${safe(s.label)}: ${fmt(s.v, c.format?.[val] || c.format)} (${fmt(s.v / total, 'percent')})</title></path>`;
    a = b;
  }
  const legend = `<div class="clegend">${slices.map((s, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i>${safe(SHORT(s.label, 24))}: ${fmt(s.v, c.format?.[val] || c.format)} (${fmt(s.v / total, 'percent')})</span>`).join('')}</div>`;
  return shell(c, `<svg viewBox="0 0 420 310" role="img" aria-label="${safe(c.title || 'Pie chart')}">${paths}</svg>`, { legend });
}

function scatter(c, rows) {
  const keys = Object.keys(rows[0] || {});
  const x = c.x || keys.find((k) => rows.some((r) => num(r[k]) !== null));
  const y = c.y || keys.find((k) => k !== x && rows.some((r) => num(r[k]) !== null));
  const size = c.size || c.radius;
  const label = c.label || c.category || keys.find((k) => ![x, y, size].includes(k));
  const pts = rows.slice(0, 80).map((r) => ({ label: String(r[label] ?? ''), x: num(r[x]), y: num(r[y]), s: Math.max(1, num(r[size]) || 1) })).filter((p) => p.x !== null && p.y !== null);
  if (!pts.length) return rowTable(rows);
  const W = 760, H = 320, left = 58, top = 18, bottom = 48, plotW = W - left - 18, plotH = H - top - bottom;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), ss = pts.map((p) => p.s);
  const [xmin, xmax, ymin, ymax, smax] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), Math.max(...ss)];
  const xOf = (v) => left + ((v - xmin) / (xmax === xmin ? 1 : xmax - xmin)) * plotW;
  const yOf = (v) => top + ((ymax - v) / (ymax === ymin ? 1 : ymax - ymin)) * plotH;
  let marks = [0, .25, .5, .75, 1].map((p) => `<line x1="${left}" y1="${top + p * plotH}" x2="${W - 12}" y2="${top + p * plotH}" class="grid"/><line x1="${left + p * plotW}" y1="${top}" x2="${left + p * plotW}" y2="${H - bottom}" class="grid"/>`).join('');
  marks += pts.map((p, i) => `<circle cx="${xOf(p.x)}" cy="${yOf(p.y)}" r="${size ? 4 + 14 * Math.sqrt(p.s / smax) : 5}" fill="${PALETTE[i % PALETTE.length]}" opacity=".82"><title>${safe(p.label)} · ${safe(x)}: ${fmt(p.x, c.format?.[x])} · ${safe(y)}: ${fmt(p.y, c.format?.[y])}${size ? ` · ${safe(size)}: ${fmt(p.s, c.format?.[size])}` : ''}</title></circle>`).join('');
  marks += `<text x="${left + plotW / 2}" y="${H - 12}" text-anchor="middle">${safe(x)}</text><text x="14" y="${top + plotH / 2}" transform="rotate(-90 14 ${top + plotH / 2})" text-anchor="middle">${safe(y)}</text>`;
  return shell(c, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(c.title || 'Scatter plot')}">${marks}</svg>`);
}

function heatmap(c, rows) {
  const keys = Object.keys(rows[0] || {});
  const x = c.x || keys[0], y = c.y || keys[1], vKey = c.value || c.color || keys.find((k) => k !== x && k !== y && rows.some((r) => num(r[k]) !== null));
  const xs = [...new Set(rows.map((r) => String(r[x] ?? '')))].slice(0, 14);
  const ys = [...new Set(rows.map((r) => String(r[y] ?? '')))].slice(0, 12);
  const vals = rows.map((r) => num(r[vKey])).filter((v) => v !== null);
  if (!xs.length || !ys.length || !vals.length) return rowTable(rows);
  const max = Math.max(...vals), min = Math.min(...vals), W = 760, H = 320, left = 100, top = 24, cw = (W - left - 16) / xs.length, ch = (H - top - 48) / ys.length;
  const cell = (r) => {
    const xi = xs.indexOf(String(r[x] ?? '')), yi = ys.indexOf(String(r[y] ?? '')), v = num(r[vKey]);
    if (xi < 0 || yi < 0 || v === null) return '';
    const op = .18 + .78 * ((v - min) / (max === min ? 1 : max - min));
    return `<rect x="${left + xi * cw}" y="${top + yi * ch}" width="${cw - 2}" height="${ch - 2}" rx="3" fill="var(--brand)" opacity="${op}"><title>${safe(r[x])} · ${safe(r[y])}: ${fmt(v, c.format?.[vKey] || c.format)}</title></rect>`;
  };
  const labels = xs.map((s, i) => `<text x="${left + i * cw + cw / 2}" y="${H - 22}" text-anchor="middle" class="xlabel">${safe(SHORT(s, 10))}</text>`).join('')
    + ys.map((s, i) => `<text x="${left - 8}" y="${top + i * ch + ch / 2 + 4}" text-anchor="end" class="xlabel">${safe(SHORT(s, 15))}</text>`).join('');
  return shell(c, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(c.title || 'Heat map')}">${rows.map(cell).join('')}${labels}</svg>`);
}

function treemap(c, rows) {
  const { ys, data } = fields(c, rows);
  const total = data.reduce((a, r) => a + Math.max(0, r.values[0] || 0), 0);
  if (!total) return rowTable(rows);
  const W = 760, H = 300;
  let x = 0, y = 0, rowH = 95, line = 0;
  const tiles = data.map((r, i) => {
    const area = Math.max(34, W * H * Math.max(0, r.values[0] || 0) / total);
    let w = Math.max(82, area / rowH);
    if (x + w > W && x > 0) { x = 0; y += rowH + 6; line++; rowH = Math.max(58, 95 - line * 10); }
    w = Math.min(w, W - x);
    const out = `<g><rect x="${x}" y="${y}" width="${w - 4}" height="${rowH}" rx="8" fill="${PALETTE[i % PALETTE.length]}" opacity=".85"><title>${safe(r.label)}: ${fmt(r.values[0], c.format?.[ys[0]] || c.format)}</title></rect><text x="${x + 8}" y="${y + 22}" fill="#fff" font-weight="700">${safe(SHORT(r.label, 18))}</text><text x="${x + 8}" y="${y + 42}" fill="#fff">${fmt(r.values[0], c.format?.[ys[0]] || c.format)}</text></g>`;
    x += w + 4;
    return out;
  }).join('');
  return shell(c, `<svg viewBox="0 0 ${W} ${Math.min(H, Math.max(100, y + rowH + 8))}" role="img" aria-label="${safe(c.title || 'Treemap')}">${tiles}</svg>`);
}

function waterfall(c, rows) {
  const { ys, data } = fields(c, rows);
  let acc = 0;
  const wf = data.map((r) => { const start = acc; acc += r.values[0] || 0; return { ...r, start, end: acc }; });
  const vals = wf.flatMap((r) => [r.start, r.end, 0]);
  const [max, min] = [Math.max(...vals), Math.min(...vals)];
  const W = 760, H = 310, left = 58, top = 20, bottom = 52, plotW = W - left - 18, plotH = H - top - bottom, range = max === min ? 1 : max - min;
  const yOf = (v) => top + (max - v) / range * plotH, zero = yOf(0), group = plotW / wf.length, bw = group * .62;
  const marks = `<line x1="${left}" y1="${zero}" x2="${W - 12}" y2="${zero}" class="axis"/>`
    + wf.map((r, i) => {
      const x = left + i * group + group * .18, y = Math.min(yOf(r.start), yOf(r.end)), h = Math.max(1, Math.abs(yOf(r.start) - yOf(r.end)));
      const col = (r.values[0] || 0) >= 0 ? 'var(--good)' : 'var(--bad)';
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" rx="3" fill="${col}"><title>${safe(r.label)}: ${fmt(r.values[0], c.format?.[ys[0]] || c.format)} · total ${fmt(r.end, c.format?.[ys[0]] || c.format)}</title></rect><text x="${x + bw / 2}" y="${H - 25}" text-anchor="middle" class="xlabel">${safe(SHORT(r.label))}</text>`;
    }).join('');
  return shell(c, `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${safe(c.title || 'Waterfall chart')}">${marks}</svg>`);
}

function cards(c, rows) {
  const keys = rows.length ? Object.keys(rows[0]) : [];
  const specs = Array.isArray(c.cards) ? c.cards : rows.length === 1 ? keys.map((k) => ({ label: k, value: rows[0][k] })) : rows.map((r) => ({ label: r[c.x || c.label || keys[0]], value: r[c.y || c.value || keys.find((k) => k !== (c.x || c.label || keys[0]))] }));
  return shell(c, `<div class="ccards">${specs.slice(0, 12).map((x) => `<div><span>${safe(x.label)}</span><b>${fmt(x.value, x.format || c.format)}</b>${x.note ? `<small>${safe(x.note)}</small>` : ''}</div>`).join('')}</div>`, { cls: 'cardschart' });
}

function visual(c, inheritedRows = null) {
  const rows = rowsOf(c).length ? rowsOf(c) : inheritedRows || [];
  if ((kind(c.type) === 'kpi' || kind(c.type) === 'card' || kind(c.type) === 'cards') && (rows.length || c.cards)) return cards(c, rows);
  if (!rows.length || typeof rows[0] !== 'object') return `<pre><code>${safe(JSON.stringify(c, null, 2))}</code></pre>`;
  const t = kind(c.type);
  if (t === 'table' || t === 'matrix') return shell(c, rowTable(rows, 'inner-table'), { cls: 'tablechart' });
  if (t === 'pie' || t === 'donut' || t === 'doughnut') return pie(c, rows);
  if (t === 'scatter' || t === 'bubble') return scatter(c, rows);
  if (t === 'heatmap') return heatmap(c, rows);
  if (t === 'treemap') return treemap(c, rows);
  if (t === 'waterfall') return waterfall(c, rows);
  return cartesian(c, rows);
}

function chartBlock(raw) {
  let c;
  try { c = JSON.parse(raw); } catch { return `<pre><code>${esc(raw)}</code></pre>`; }
  return visual(c);
}

function dashboardBlock(raw) {
  let d;
  try { d = JSON.parse(raw); } catch { return `<pre><code>${esc(raw)}</code></pre>`; }
  const visuals = Array.isArray(d.visuals) ? d.visuals : Array.isArray(d.charts) ? d.charts : [];
  const cols = Math.max(1, Math.min(4, Number(d.columns) || (visuals.length > 2 ? 2 : 1)));
  const title = d.title ? `<div class="ctitle">${safe(d.title)}</div>` : '';
  const sub = d.subtitle ? `<div class="csub">${safe(d.subtitle)}</div>` : '';
  return `<div class="dashboard">${title}${sub}<div class="dgrid" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${visuals.map((v) => visual({ ...v, rows: rowsOf(v).length ? rowsOf(v) : rowsOf(d) })).join('')}</div></div>`;
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
      out.push(/^studio-chart$/i.test(fence[1] || '') ? chartBlock(buf.join('\n'))
        : /^studio-dashboard$/i.test(fence[1] || '') ? dashboardBlock(buf.join('\n'))
          : `<pre><code>${esc(buf.join('\n'))}</code></pre>`);
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
