import { store, get, post, del, on } from '../api.js';
import { h, toast, busy, field, input, fmtDate, confirmDialog } from '../ui.js';
import { app, copilotSlot } from '../app.js';

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
let catalog = null;
let profile = null;
let profileKey = null;
const design = { theme: 'studio', pages: new Set(['executive', 'drivers', 'scorecard']), name: '' };

export function renderReports(el) {
  const p = store.project || {};
  if (!p.semanticModel) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Create the semantic model first. '), 'Reports, dashboards and apps are built on your semantic model, so every number matches its measures.'), h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Go to Semantic model')));
    return;
  }
  const reports = p.reports || [];
  if (reports.length) el.append(reportsCard(p, reports));
  const findings = h('div', { class: 'card' });
  const designer = h('div', { class: 'card' });
  el.append(h('div', { class: 'grid g2', style: { marginTop: reports.length ? '14px' : 0, alignItems: 'start' } }, findings, designer), copilotSlot());
  drawFindings(findings, p);
  drawDesigner(designer, p);
}

// ---------------- reports already built ----------------
function reportsCard(p, reports) {
  const list = h('div', { class: 'col', style: { gap: '12px' } });
  for (const r of reports) {
    const preview = h('div');
    const showPreview = () => {
      preview.innerHTML = '';
      if (!r.preview) { preview.append(h('div', { class: 'tiny muted' }, 'No preview yet – open it in Power BI.')); return; }
      const src = `/api/reports/${r.id}/preview?t=${encodeURIComponent(TOKEN)}&v=${encodeURIComponent(r.preview.at)}`;
      preview.append(r.preview.format === 'PNG' ? h('img', { src, alt: `${r.name} preview`, class: 'rpreview' }) : h('iframe', { src: `${src}#toolbar=0&navpanes=0&view=FitH`, title: `${r.name} preview`, class: 'rpreview' }));
    };
    const toggle = h('button', { class: 'btn' }, '▸ Preview');
    let open = false;
    toggle.addEventListener('click', () => { open = !open; toggle.textContent = open ? '▾ Hide preview' : '▸ Preview'; if (open) showPreview(); else preview.innerHTML = ''; });
    const rebuild = h('button', { class: 'btn', 'data-busy': 'Starting…', title: 'Rebuild with the current model and the same pages and theme' }, '↻ Rebuild');
    rebuild.addEventListener('click', busy(rebuild, async () => {
      const ids = pageIds(r.pages);
      await startBuild({ name: r.name, theme: r.theme, pages: ids.length ? ids : undefined }, list);
    }));
    const remove = h('button', { class: 'btn danger', title: 'Delete this report from the workspace' }, 'Delete');
    remove.addEventListener('click', async () => {
      if (!(await confirmDialog('Delete report', `Delete "${r.name}" from ${p.workspace.name}? This can't be undone.`, 'Delete', true))) return;
      try { await del(`/reports/${r.id}?delete=1`); toast(`Deleted ${r.name}`, 'ok'); await app.refresh(); } catch (e) { toast(e.message, 'err'); }
    });
    const theme = catalog?.themes.find((t) => t.id === r.theme);
    list.append(h('div', { class: 'rrow' },
      h('div', { class: 'row sp' },
        h('div', {},
          h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'pill ok' }, 'Deployed'), theme ? h('span', { class: 'pill' }, theme.name) : null),
          h('div', { class: 'tiny muted' }, `${r.pages.join(' · ')} · built ${fmtDate(r.builtAt)}`)),
        h('div', { class: 'row' },
          h('a', { class: 'btn pri', href: r.url, target: '_blank', rel: 'noopener' }, 'Open in Power BI ↗'),
          toggle, rebuild, remove)),
      preview));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', {}, h('h2', {}, 'Your reports'), h('p', { class: 'lead' }, 'Power BI reports built on your semantic model, with your security and measures.')),
      h('button', { class: 'btn ai', onclick: () => app.ask('Review my Power BI reports against my model and glossary. What is missing for executives, and which page would you add or change? Use studio_describe_report_options.') }, '✦ Review with Copilot')),
    list);
}

const pageIds = (names) => (catalog?.pages || []).filter((x) => names.includes(x.name)).map((x) => x.id);

// ---------------- what the studio found in the model ----------------
function drawFindings(card, p, refresh = false) {
  card.innerHTML = '';
  const body = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Reading measures, dimensions and dates from your semantic model…'));
  const again = h('button', { class: 'btn', title: 'Read the model again (after changing measures)' }, '↻ Refresh');
  again.addEventListener('click', () => drawFindings(card, p, true));
  card.append(h('div', { class: 'row sp' }, h('div', {}, h('h2', {}, 'What we found in your model'), h('p', { class: 'lead' }, `${p.semanticModel.name} – the studio picks KPIs, time, breakdowns and top lists from it.`)), again), body);
  const key = `${p.semanticModel.id}`;
  const load = !refresh && profile && profileKey === key ? Promise.resolve(profile) : get(`/reports/profile${refresh ? '?refresh=1' : ''}`);
  load.then((pr) => {
    profile = pr; profileKey = key;
    body.innerHTML = '';
    const ref = (r) => (r ? h('span', {}, h('b', {}, r.label), h('span', { class: 'tiny muted' }, `  ${r.table}[${r.name}]`)) : h('span', { class: 'muted' }, 'none found'));
    const time = pr.time ? `${{ month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' }[pr.time.grain]} · ${pr.time.years[0]}–${pr.time.years[pr.time.years.length - 1]}${pr.time.fullYears.length < pr.time.years.length ? ` · full years ${pr.time.fullYears.join(', ')}` : ''}` : 'No date table';
    body.append(...[
      h('dl', { class: 'kv' },
        h('dt', {}, 'Headline KPIs'), h('dd', {}, h('div', { class: 'chips' }, pr.kpis.map((k) => h('span', { class: 'pill brand' }, k.label)))),
        h('dt', {}, 'Channels'), h('dd', {}, pr.channels.length > 1 ? pr.channels.map((c) => c.label).join(' · ') : h('span', { class: 'muted' }, 'single measure')),
        h('dt', {}, 'Time'), h('dd', {}, time),
        h('dt', {}, 'Share by'), h('dd', {}, ref(pr.share)),
        h('dt', {}, 'Break down by'), h('dd', {}, ref(pr.breakdown)),
        h('dt', {}, 'Top 10 list'), h('dd', {}, ref(pr.entity)),
        h('dt', {}, 'Drill path'), h('dd', {}, pr.hierarchy.length ? pr.hierarchy.map((x) => x.label).join(' › ') : h('span', { class: 'muted' }, '–'))),
      pr.insights.length ? h('div', { class: 'banner ok mt' }, h('div', {}, h('b', {}, 'Insights. '), pr.insights.map((i) => i.text).join(' '))) : null,
      pr.warnings.length ? h('div', { class: 'banner warn mt' }, pr.warnings.join(' ')) : null,
      h('p', { class: 'tiny muted' }, 'Read-only DAX against your model; your permissions and row-level security apply.')].filter(Boolean));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

// ---------------- designer ----------------
async function loadCatalog() {
  if (!catalog) catalog = await get('/reports/catalog');
  return catalog;
}

function themeSwatch(t, selected, onPick) {
  const sw = h('div', { class: `tswatch ${selected ? 'on' : ''}`, tabindex: 0, role: 'button', 'aria-pressed': selected ? 'true' : 'false', title: t.description },
    h('div', { class: 'tsprev', style: { background: t.page } },
      h('div', { class: 'tsband', style: { background: t.header } }, h('span', { style: { background: t.headerText } })),
      h('div', { class: 'tscards' }, [0, 1, 2].map((i) => h('i', { style: { background: t.card, borderLeftColor: t.dataColors[i] } }))),
      h('div', { class: 'tsbars', style: { background: t.card } }, t.dataColors.slice(0, 5).map((c, i) => h('b', { style: { background: c, height: `${30 + ((i * 37) % 60)}%` } })))),
    h('div', { class: 'tsname' }, t.name));
  const pick = () => onPick(t.id);
  sw.addEventListener('click', pick);
  sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  return sw;
}

const LAYOUTS = {
  executive: [[0, 0, 100, 14, 'band'], [2, 18, 23, 14], [27, 18, 23, 14], [52, 18, 23, 14], [77, 18, 21, 14], [2, 36, 58, 30, 'line'], [62, 36, 36, 30, 'donut'], [2, 70, 36, 28, 'bars'], [40, 70, 58, 28, 'table']],
  drivers: [[0, 0, 100, 14, 'band'], [2, 18, 46, 80, 'table'], [50, 18, 48, 39, 'cols'], [50, 59, 48, 39, 'bars']],
  scorecard: [[0, 0, 100, 14, 'band'], [2, 18, 23, 12], [27, 18, 23, 12], [52, 18, 23, 12], [77, 18, 21, 12], [2, 34, 46, 32, 'table'], [50, 34, 48, 32, 'line'], [2, 70, 96, 28, 'table']],
};

function layoutThumb(id, t) {
  const box = h('div', { class: 'lthumb', style: { background: t?.page || '#F3F6FA' } });
  for (const [x, y, w, hh, kind] of LAYOUTS[id] || []) {
    const el = h('span', { class: `lt ${kind || 'card'}`, style: { left: `${x}%`, top: `${y}%`, width: `${w}%`, height: `${hh}%`, backgroundColor: kind === 'band' ? (t?.header || '#0B3B73') : (t?.card || '#fff') } });
    el.style.setProperty('--acc', t?.dataColors?.[0] || '#2563EB');
    box.append(el);
  }
  return box;
}

function drawDesigner(card, p) {
  card.innerHTML = '';
  card.append(h('h2', {}, 'Design a Power BI report'), h('p', { class: 'lead' }, 'Pick page templates and a theme. The studio fills them with your measures and dimensions and deploys the report to your workspace.'));
  const body = h('div', {}, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Loading templates…'));
  card.append(body);
  loadCatalog().then((cat) => {
    body.innerHTML = '';
    if (!design.name) design.name = `${p.semanticModel.name} report`;
    const name = input({ value: design.name });
    name.addEventListener('input', () => { design.name = name.value; });
    const theme = () => cat.themes.find((t) => t.id === design.theme) || cat.themes[0];

    const pagesBox = h('div', { class: 'ptiles' });
    const drawPages = () => {
      pagesBox.innerHTML = '';
      for (const pg of cat.pages) {
        const on = design.pages.has(pg.id);
        const cb = h('input', { type: 'checkbox', checked: on || undefined, 'aria-label': pg.name });
        const tile = h('label', { class: `ptile ${on ? 'on' : ''}` }, layoutThumb(pg.id, theme()), h('div', { class: 'row', style: { gap: '6px' } }, cb, h('b', {}, pg.name)), h('div', { class: 'tiny muted' }, pg.description), h('div', { class: 'tiny' }, h('span', { class: 'pill' }, pg.archetype)));
        cb.addEventListener('change', () => { if (cb.checked) design.pages.add(pg.id); else design.pages.delete(pg.id); tile.classList.toggle('on', cb.checked); });
        pagesBox.append(tile);
      }
    };
    const themesBox = h('div', { class: 'tswatches' });
    const drawThemes = () => {
      themesBox.innerHTML = '';
      for (const t of cat.themes) themesBox.append(themeSwatch(t, t.id === design.theme, (id) => { design.theme = id; drawThemes(); drawPages(); }));
    };
    drawThemes();
    drawPages();

    const job = h('div', { class: 'mt' });
    const build = h('button', { class: 'btn pri big', 'data-busy': 'Starting…' }, (p.reports || []).some((r) => r.name === design.name) ? 'Rebuild report' : 'Build report');
    build.addEventListener('click', busy(build, async () => {
      const pages = cat.pages.map((x) => x.id).filter((id) => design.pages.has(id));
      if (!pages.length) throw new Error('Select at least one page.');
      await startBuild({ name: design.name.trim(), theme: design.theme, pages }, job);
    }));
    body.append(
      h('h3', {}, 'Pages'), pagesBox,
      h('h3', { class: 'mt' }, 'Theme'), themesBox,
      h('div', { class: 'formgrid mt' }, field('Report name', name)),
      h('div', { class: 'row mt' }, build,
        h('button', { class: 'btn ai', onclick: () => app.ask('Recommend the best Power BI report for my semantic model: read studio_describe_report_options, explain which pages and theme fit my data and audience and why, then build it with studio_create_report after I confirm.') }, '✦ Recommend with Copilot')),
      job,
      h('p', { class: 'tiny muted' }, 'Building creates or updates a Report item in your workspace (you approve it here). Previews use Power BI export; if your tenant turns export off, open the report in Power BI instead.'));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

async function startBuild(payload, container) {
  const j = await post('/jobs/report', payload);
  app.watchJob(j.id);
  const render = (x) => { container.querySelector(':scope > .jobcard-slot')?.remove(); const slot = h('div', { class: 'jobcard-slot mt' }, app.jobCard(x)); container.append(slot); };
  render(j);
  const off = on('job', (e) => {
    if (e.job.id !== j.id) return;
    render(e.job);
    if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast('Report deployed', 'ok'); app.refresh(); } }
  });
}
