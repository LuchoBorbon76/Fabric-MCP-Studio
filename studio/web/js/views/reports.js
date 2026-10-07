import { store, get, post, del, on, upload } from '../api.js';
import { h, toast, busy, field, input, fmtDate, confirmDialog, modal } from '../ui.js';
import { app, copilotSlot } from '../app.js';
import { askCard } from '../prompts.js';
import { standardName, purposeOf, parseName } from '../naming.js';
import { modelBar, modelErrorBanner } from '../models.js';

const TOKEN = document.querySelector('meta[name="studio-token"]').content;
let catalog = null;
let profile = null;
let profileKey = null;
on('studio.reset', () => { profile = null; profileKey = null; });
on('model.fixed', () => { profile = null; profileKey = null; });
const design = { theme: 'studio', pages: new Set(['executive', 'drivers', 'scorecard']), name: '' };

export function renderReports(el) {
  const p = store.project || {};
  if (!p.semanticModel) {
    el.append(h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, 'Create the semantic model first. '), 'Reports, dashboards and apps are built on your semantic model, so every number matches its measures.'), h('button', { class: 'btn pri', onclick: () => app.go('model') }, 'Go to Semantic model')));
    return;
  }
  const bar = modelBar({ note: 'Reports, recommendations and the org app below are for this model' });
  if (bar) el.append(bar);
  // Reports on the active model (reports from before models were tracked count as its own).
  const all = p.reports || [];
  const reports = all.filter((r) => !r.semanticModelId || r.semanticModelId === p.semanticModel.id);
  const elsewhere = all.length - reports.length;
  if (elsewhere) el.append(h('div', { class: 'tiny muted', style: { margin: '-6px 0 10px 2px' } }, `${elsewhere} more report${elsewhere === 1 ? ' is' : 's are'} built on the other semantic models – switch model above to see ${elsewhere === 1 ? 'it' : 'them'}.`));
  // What's already built comes first; recommendations and the designer follow.
  if (reports.length || p.orgApp || p.realtime?.dashboard || (p.semanticModel.linked?.reports || []).length) {
    const built = reportsCard(p, reports);
    built.style.marginBottom = '14px';
    el.append(built);
  }
  el.append(askCard({ title: 'Ask about your reports', lead: 'Get the story behind the pages and the numbers on them.', only: ['reports', 'numbers'] }));
  const recs = h('div', { class: 'card' });
  el.append(recs);
  const findings = h('div', { class: 'card' });
  const designer = h('div', { class: 'card', style: { marginTop: 0 } });
  el.append(h('div', { class: 'grid g2', style: { marginTop: '14px', alignItems: 'start' } }, findings, designer), copilotSlot());
  drawRecommendations(recs, p, designer);
  drawFindings(findings, p);
  drawDesigner(designer, p);
}

// ---------------- recommendations ----------------
function drawRecommendations(card, p, designer) {
  card.innerHTML = '';
  const grid = h('div', { class: 'recs' }, h('div', { class: 'row muted' }, h('span', { class: 'spin' }), 'Looking at your model to recommend reports…'));
  card.append(...[
    h('div', { class: 'row sp' },
      h('div', {}, h('h2', {}, 'Recommended for your data'), h('p', { class: 'lead' }, 'Based on your measures, dates, segments and what the data shows. Build one in a click, or customize it below.')),
      h('button', { class: 'btn ai', onclick: () => app.ask('Recommend the best Power BI report for my semantic model and audience. Read studio_describe_report_options, explain which pages and theme fit and why (use the insights), then suggest it with studio_propose_report so I can apply it.') }, '✦ Recommend with Copilot')),
    pendingReportProposal(p) ? proposalBanner(p.reportProposal) : null,
    grid].filter(Boolean));
  Promise.all([get('/reports/recommendations'), loadCatalog()]).then(([r]) => {
    grid.innerHTML = '';
    for (const rec of r.recommendations) grid.append(recCard(rec, p, designer));
    grid.append(realtimeRecCard(p));
  }).catch((e) => { grid.innerHTML = ''; grid.append(modelErrorBanner(e)); });
}

function recCard(rec, p, designer) {
  if (rec.kind === 'app') return appRecCard(rec);
  const theme = catalog.themes.find((t) => t.id === rec.theme);
  const pages = rec.pages.map((id) => catalog.pages.find((x) => x.id === id)?.name || id);
  const job = h('div');
  const build = h('button', { class: 'btn pri', 'data-busy': 'Starting…' }, rec.built ? '↻ Rebuild' : 'Build');
  build.addEventListener('click', busy(build, async () => { await startBuild({ name: rec.name, theme: rec.theme, pages: rec.pages }, job); }));
  const customize = h('button', { class: 'btn', title: 'Load into the designer below' }, 'Customize');
  customize.addEventListener('click', () => {
    design.theme = rec.theme; design.pages = new Set(rec.pages); design.name = rec.name;
    drawDesigner(designer, p);
    designer.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return h('div', { class: `rec ${rec.built ? 'built' : ''}` },
    h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
      h('div', {}, h('div', { class: 'row' }, h('b', {}, rec.title), rec.built ? h('span', { class: 'pill ok' }, 'Built') : h('span', { class: 'pill brand' }, 'Recommended')), h('div', { class: 'tiny muted' }, `For ${rec.audience.toLowerCase()} · ${theme?.name || rec.theme} theme`)),
      theme ? h('div', { class: 'recsw', title: theme.name }, h('i', { style: { background: theme.header } }), ...theme.dataColors.slice(0, 4).map((c) => h('i', { style: { background: c } }))) : null),
    h('div', { class: 'chips' }, pages.map((x) => h('span', { class: 'pill' }, x))),
    h('ul', { class: 'pre small' }, rec.reasons.map((x) => h('li', {}, x))),
    h('div', { class: 'row', style: { marginTop: 'auto' } }, build, customize, rec.built ? h('a', { class: 'btn', href: rec.built.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null),
    job);
}

// ---------------- org app ----------------
function appRecCard(rec) {
  const theme = catalog.themes.find((t) => t.id === rec.theme);
  const job = h('div');
  const build = h('button', { class: 'btn pri', 'data-busy': 'Starting…', disabled: !rec.available || undefined, title: rec.available ? 'Create or update the org app with all your reports' : 'Build a report first' }, rec.built ? '↻ Update app' : 'Create app');
  build.addEventListener('click', busy(build, async () => { await startJob('/jobs/org-app', { name: rec.name, theme: rec.theme }, job, 'Org app ready – add an audience and publish it in Fabric'); }));
  return h('div', { class: `rec ${rec.built ? 'built' : ''}` },
    h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
      h('div', {}, h('div', { class: 'row' }, h('b', {}, rec.title), rec.built ? h('span', { class: `pill ${rec.notInApp?.length ? 'warn' : 'ok'}` }, rec.notInApp?.length ? 'Update needed' : 'Created') : h('span', { class: 'pill brand' }, rec.available ? 'Recommended' : 'Next')), h('div', { class: 'tiny muted' }, `Fabric org app · ${theme?.name || rec.theme} colors`)),
      theme ? h('div', { class: 'recsw', title: theme.name }, h('i', { style: { background: theme.header } }), ...theme.dataColors.slice(0, 4).map((c) => h('i', { style: { background: c } }))) : null),
    h('div', { class: 'chips' }, h('span', { class: 'pill' }, 'Overview page'), h('span', { class: 'pill' }, `${rec.reportCount} report${rec.reportCount === 1 ? '' : 's'}`), h('span', { class: 'pill' }, 'Audiences in Fabric')),
    h('ul', { class: 'pre small' }, rec.reasons.map((x) => h('li', {}, x))),
    h('div', { class: 'row', style: { marginTop: 'auto' } }, build, rec.built ? h('a', { class: 'btn', href: rec.built.url, target: '_blank', rel: 'noopener', title: 'Open the workspace in Fabric to add an audience and publish the app' }, 'Publish in Fabric ↗') : null),
    job);
}

async function startJob(path, payload, container, doneText) {
  const j = await post(path, payload);
  app.watchJob(j.id);
  const render = (x) => { container.querySelector(':scope > .jobcard-slot')?.remove(); container.append(h('div', { class: 'jobcard-slot mt' }, app.jobCard(x))); };
  render(j);
  const off = on('job', (e) => {
    if (e.job.id !== j.id) return;
    render(e.job);
    if (e.job.status !== 'running') { off(); if (e.job.status === 'succeeded') { toast(doneText, 'ok'); app.refresh(); } }
  });
}

// ---------------- Copilot's suggested report ----------------
const pendingReportProposal = (p) => Boolean(p?.reportProposal && !p.reportProposal.appliedAt);

export function reportProposalText(pr) {
  const pages = (pr.pages || []).map((id) => catalog?.pages.find((x) => x.id === id)?.name || id);
  const theme = catalog?.themes.find((t) => t.id === pr.theme)?.name || pr.theme;
  return `${pr.name} · ${pages.join(', ')} · ${theme} theme`;
}

function proposalBanner(pr) {
  return h('div', { class: 'banner ok mb' },
    h('div', { style: { flex: 1 } }, h('b', {}, 'Copilot suggested a report. '), reportProposalText(pr)),
    h('button', { class: 'btn pri', onclick: () => applyReportProposal(pr) }, '✓ Apply suggestions'));
}

/** Review Copilot's suggested report, then build it exactly as shown. */
export async function applyReportProposal(pr) {
  const current = store.project?.reportProposal;
  if (!pr || !current) { toast('There are no suggestions to apply.', 'err'); return; }
  if (current.id !== pr.id) { toast('Copilot made newer suggestions – apply the latest ones.', 'err'); return; }
  if (current.appliedAt) { toast('These suggestions are already applied.', 'ok'); return; }
  const cat = await loadCatalog();
  const theme = cat.themes.find((t) => t.id === current.theme) || cat.themes[0];
  const body = h('div', { class: 'col' },
    current.summary ? h('p', { class: 'small', style: { margin: 0 } }, current.summary) : null,
    h('dl', { class: 'kv' },
      h('dt', {}, 'Report'), h('dd', {}, h('b', {}, current.name), current.updatesExisting ? ' – updates the existing report' : ' – new report'),
      current.audience ? [h('dt', {}, 'Audience'), h('dd', {}, current.audience)] : null,
      h('dt', {}, 'Semantic model'), h('dd', {}, store.project.semanticModel?.name || ''),
      h('dt', {}, 'Theme'), h('dd', {}, theme.name)),
    current.warnings?.length ? h('div', { class: 'banner warn' }, current.warnings.join(' ')) : null,
    h('h3', {}, `Pages (${current.pages.length})`),
    h('div', { class: 'ptiles' }, current.pages.map((id) => {
      const pg = cat.pages.find((x) => x.id === id);
      return h('div', { class: 'ptile on', style: { cursor: 'default' } }, layoutThumb(id, theme), h('b', {}, pg?.name || id), h('div', { class: 'tiny muted' }, pg?.description || ''));
    })),
    h('p', { class: 'tiny muted', style: { margin: 0 } }, 'Nothing changes in Fabric until you select the button below.'));
  modal({
    title: 'Apply Copilot\'s suggestions', className: 'appr wide', body,
    actions: [
      { label: 'Cancel' },
      {
        label: current.updatesExisting ? 'Update report' : 'Build report', class: 'pri',
        onClick: async () => {
          try {
            design.theme = current.theme; design.pages = new Set(current.pages); design.name = current.name;
            const j = await post('/jobs/report', { name: current.name, theme: current.theme, pages: current.pages, proposalId: current.id });
            app.watchJob(j.id);
            toast(`Building ${current.name}…`);
            const off = on('job', (e) => {
              if (e.job.id !== j.id || e.job.status === 'running') return;
              off();
              if (e.job.status === 'succeeded') { toast('Report deployed with Copilot\'s suggestions', 'ok'); app.refresh(); } else toast(e.job.error || 'The report was not built.', 'err');
            });
          } catch (e) { toast(e.message, 'err'); return false; }
          return true;
        },
      },
    ],
  });
}

// ---------------- reports already built ----------------
// ---------------- live dashboard (built in the Real-time tab) ----------------
function realtimeRecCard(p) {
  const d = p.realtime?.dashboard;
  const reasons = [
    'Watch orders, amounts and margin minute by minute, refreshed every 30 seconds',
    p.ontology ? 'Business-rule breaks are flagged the moment events arrive, next to your ontology\'s rules' : 'Business-rule breaks are flagged the moment events arrive',
    'Events carry your real products, customers, regions and prices, so it matches this model',
  ];
  return h('div', { class: `rec ${d ? 'built' : ''}` },
    h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
      h('div', {}, h('div', { class: 'row' }, h('b', {}, 'Real-Time Dashboard'), d ? h('span', { class: 'pill ok' }, 'Built') : h('span', { class: 'pill brand' }, 'Live')), h('div', { class: 'tiny muted' }, 'For operations · Eventhouse + auto refresh'))),
    h('div', { class: 'chips' }, h('span', { class: 'pill' }, 'Live overview'), h('span', { class: 'pill' }, 'Business rules')),
    h('ul', { class: 'pre small' }, reasons.map((x) => h('li', {}, x))),
    h('div', { class: 'row', style: { marginTop: 'auto' } },
      h('button', { class: `btn ${d ? '' : 'pri'}`, onclick: () => app.go('realtime') }, d ? 'Real-time tab' : 'Set up in Real-time'),
      d ? h('a', { class: 'btn', href: d.url, target: '_blank', rel: 'noopener' }, 'Open ↗') : null));
}

function reportsCard(p, reports) {
  const list = h('div', { class: 'col', style: { gap: '12px' } });
  if (p.realtime?.dashboard) {
    const d = p.realtime.dashboard;
    list.append(h('div', { class: 'rrow app' },
      h('div', { class: 'row sp' },
        h('div', {},
          h('div', { class: 'row' }, h('span', {}, '⚡'), h('b', {}, d.name), h('span', { class: 'pill ok' }, 'Real-Time Dashboard')),
          h('div', { class: 'tiny muted' }, `${d.tiles} tiles on ${d.pages.length} pages · refreshes every ${d.refreshSeconds} seconds · live events from ${p.realtime.eventhouse?.name || 'the Eventhouse'}`)),
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => app.go('realtime') }, 'Real-time tab'), h('a', { class: 'btn pri', href: d.url, target: '_blank', rel: 'noopener' }, 'Open ↗')))));
  }
  if (p.orgApp) {
    // Reports built after the app aren't in it until it is updated.
    const inApp = new Set(p.orgApp.reports || []);
    const missing = reports.filter((r) => !inApp.has(r.id));
    const update = h('button', { class: 'btn', 'data-busy': 'Starting…', title: 'Add the reports built since the app was last updated' }, '↻ Update the app');
    update.addEventListener('click', busy(update, async () => { await startJob('/jobs/org-app', { name: p.orgApp.name, theme: p.orgApp.theme }, list, 'Org app updated – publish it in Fabric to share the changes'); }));
    list.append(h('div', { class: 'rrow app' },
      h('div', { class: 'row sp' },
        h('div', {},
          h('div', { class: 'row' }, h('span', {}, '▦'), h('b', {}, p.orgApp.name), h('span', { class: 'pill ok' }, 'Org app'), missing.length ? h('span', { class: 'pill warn' }, `${missing.length} report${missing.length === 1 ? '' : 's'} not in the app yet`) : null),
          h('div', { class: 'tiny muted' }, `${p.orgApp.reports.length} report${p.orgApp.reports.length === 1 ? '' : 's'} · updated ${fmtDate(p.orgApp.builtAt)} · add an audience and publish it in Fabric to share it`),
          missing.length ? h('div', { class: 'tiny muted' }, `Not in the app yet: ${missing.map((r) => r.name).join(', ')} – update the app to add ${missing.length === 1 ? 'it' : 'them'}.`) : null),
        h('div', { class: 'row' }, missing.length ? update : null, h('a', { class: 'btn pri', href: p.orgApp.url, target: '_blank', rel: 'noopener' }, 'Publish in Fabric ↗')))));
  }
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
    const rebuild = h('button', { class: 'btn', 'data-busy': 'Starting…', title: r.template ? `Rebuild from the template ${r.template.name} with the current model` : 'Rebuild with the current model and the same pages and theme' }, '↻ Rebuild');
    // A report the studio built elsewhere (found in Fabric) is rebuilt only when its theme and pages are known.
    const canRebuild = Boolean(r.template) || !r.adoptedAt || (Boolean(r.theme) && r.pages.length > 0 && pageIds(r.pages).length === r.pages.length);
    rebuild.addEventListener('click', busy(rebuild, async () => {
      if (r.template) { await startJob('/jobs/report-template', { id: r.template.id, name: r.name }, list, 'Report deployed'); return; }
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
          h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'pill ok' }, 'Deployed'), theme ? h('span', { class: 'pill' }, theme.name) : null, r.template ? h('span', { class: 'pill', title: 'Built from your template' }, `Template: ${r.template.name}`) : null,
            r.adoptedAt ? h('span', { class: 'pill', title: 'Built by Fabric MCP Studio (its description in Fabric says so) and found on this model – it is the project\'s again' }, 'Built by the studio') : null),
          h('div', { class: 'tiny muted' }, [r.pages.length ? r.pages.join(' · ') : null, r.builtAt ? `built ${fmtDate(r.builtAt)}` : 'found in Fabric'].filter(Boolean).join(' · '))),
        h('div', { class: 'row' },
          h('a', { class: 'btn pri', href: r.url, target: '_blank', rel: 'noopener' }, 'Open in Power BI ↗'),
          toggle, canRebuild ? rebuild : null, remove)),
      preview));
  }
  // Reports already built on the model in Fabric: the studio shows them and never changes or deletes them.
  const theirs = (p.semanticModel?.linked?.reports || []).filter((r) => !reports.some((x) => x.id === r.id));
  for (const r of theirs) {
    list.append(h('div', { class: 'rrow' },
      h('div', { class: 'row sp' },
        h('div', {},
          h('div', { class: 'row' }, h('b', {}, r.name), h('span', { class: 'pill', title: 'Built in Fabric, not by the studio. The studio never changes or deletes it.' }, 'Existing report'), r.type === 'PaginatedReport' ? h('span', { class: 'pill' }, 'Paginated') : null),
          h('div', { class: 'tiny muted' }, `On ${p.semanticModel.name}${r.workspaceId && r.workspaceId !== p.workspace?.id ? ' · in another workspace' : ''}`)),
        h('a', { class: 'btn', href: r.url, target: '_blank', rel: 'noopener' }, 'Open in Power BI ↗'))));
  }
  return h('div', { class: 'card' },
    h('div', { class: 'row sp' }, h('div', {}, h('h2', {}, p.orgApp ? 'Your reports and app' : 'Your reports'), h('p', { class: 'lead' }, 'Power BI reports built on your semantic model, with your security and measures.')),
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
        h('dt', {}, 'Drill path'), h('dd', {}, pr.hierarchy.length ? pr.hierarchy.map((x) => x.label).join(' › ') : h('span', { class: 'muted' }, '–')),
        h('dt', {}, 'Map'), h('dd', {}, !pr.geo ? h('span', { class: 'muted' }, 'no location columns')
          : pr.geo.mode === 'points' ? `${(pr.geo.points || 0).toLocaleString()} points at ${pr.geo.lat.name} / ${pr.geo.lon.name}${pr.geo.label ? ` · ${pr.geo.label.label}` : ''}`
            : pr.geo.levels.map((c) => `${c.label}${pr.geo.distinct?.[c.level] ? ` (${pr.geo.distinct[c.level].toLocaleString()})` : ''}`).join(' › '))),
      pr.insights.length ? h('div', { class: 'banner ok mt' }, h('div', {}, h('b', {}, 'Insights. '), pr.insights.map((i) => i.text).join(' '))) : null,
      pr.warnings.length ? h('div', { class: 'banner warn mt' }, pr.warnings.join(' ')) : null,
      h('p', { class: 'tiny muted' }, 'Read-only DAX against your model; your permissions and row-level security apply.')].filter(Boolean));
  }).catch((e) => { body.innerHTML = ''; body.append(modelErrorBanner(e)); });
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
    h('div', { class: 'tsname' }, t.name, t.uploaded ? h('span', { class: 'tsyours', title: 'Your uploaded theme' }, 'Yours') : null));
  const pick = () => onPick(t.id);
  sw.addEventListener('click', pick);
  sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  return sw;
}

const LAYOUTS = {
  executive: [[0, 0, 100, 14, 'band'], [2, 18, 23, 14], [27, 18, 23, 14], [52, 18, 23, 14], [77, 18, 21, 14], [2, 36, 58, 30, 'line'], [62, 36, 36, 30, 'donut'], [2, 70, 36, 28, 'bars'], [40, 70, 58, 28, 'table']],
  drivers: [[0, 0, 100, 14, 'band'], [2, 18, 46, 80, 'table'], [50, 18, 48, 39, 'cols'], [50, 59, 48, 39, 'bars']],
  scorecard: [[0, 0, 100, 14, 'band'], [2, 18, 23, 12], [27, 18, 23, 12], [52, 18, 23, 12], [77, 18, 21, 12], [2, 34, 46, 32, 'table'], [50, 34, 48, 32, 'line'], [2, 70, 96, 28, 'table']],
  rules: [[0, 0, 100, 14, 'band'], [2, 18, 15, 13, 'alert'], [18.5, 18, 15, 13, 'alert'], [35, 18, 15, 13, 'alert'], [51.5, 18, 15, 13], [68, 18, 15, 13], [84.5, 18, 13.5, 13], [2, 35, 38, 63, 'text'], [42, 35, 56, 30, 'cols'], [42, 68, 56, 30, 'table']],
  plan: [[0, 0, 100, 14, 'band'], [2, 18, 18, 13], [21.5, 18, 18, 13], [41, 18, 18, 13, 'alert'], [60.5, 18, 18, 13, 'alert'], [80, 18, 18, 13], [2, 35, 96, 33, 'line'], [2, 71, 54, 27, 'table'], [58, 71, 40, 27, 'bars']],
  geo: [[0, 0, 100, 14, 'band'], [2, 18, 23, 12], [27, 18, 23, 12], [52, 18, 23, 12], [77, 18, 21, 12], [2, 34, 60, 64, 'map'], [64, 34, 34, 31, 'bars'], [64, 67, 34, 31, 'table']],
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
    if (!design.name) {
      const purpose = purposeOf(p.semanticModel.name, 'SemanticModel') || 'Main';
      // A report built before for the same purpose keeps its name (rebuilding updates it).
      design.name = (p.reports || []).find((r) => parseName(r.name)?.purpose === purpose)?.name || standardName('Report', purpose);
    }
    const name = input({ value: design.name });
    name.addEventListener('input', () => { design.name = name.value; });
    const theme = () => cat.themes.find((t) => t.id === design.theme) || cat.themes[0];

    const pagesBox = h('div', { class: 'ptiles' });
    // The Plan vs actual page needs the plan on this model (the plan lives on the model its Plan table was added to).
    const planHere = Boolean(p.planning?.spec && (!p.planning.semanticModelId || p.planning.semanticModelId === p.semanticModel.id));
    if (!planHere) design.pages.delete('plan');
    const drawPages = () => {
      pagesBox.innerHTML = '';
      for (const pg of cat.pages) {
        const off = pg.id === 'plan' && !planHere;
        const on = design.pages.has(pg.id);
        const cb = h('input', { type: 'checkbox', checked: on || undefined, disabled: off || undefined, 'aria-label': pg.name });
        const tile = h('label', { class: `ptile ${on ? 'on' : ''} ${off ? 'off' : ''}`, title: off ? (p.planning ? 'The plan is on another semantic model – switch to it to add this page' : 'Build the plan on the Planning tab first') : undefined }, layoutThumb(pg.id, theme()), h('div', { class: 'row', style: { gap: '6px' } }, cb, h('b', {}, pg.name)), h('div', { class: 'tiny muted' }, pg.description), h('div', { class: 'tiny' }, h('span', { class: 'pill' }, pg.archetype), off ? h('span', { class: 'pill' }, p.planning ? 'Plan on another model' : 'Needs a plan') : null));
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
      templatesSection(p, job, () => drawDesigner(card, p)),
      h('h3', { class: 'mt' }, 'Theme'), themesBox,
      h('div', { class: 'formgrid mt' }, field('Report name', name)),
      h('div', { class: 'row mt' }, build,
        h('button', { class: 'btn ai', onclick: () => app.ask('Recommend the best Power BI report for my semantic model: read studio_describe_report_options, explain which pages and theme fit my data and audience and why, then build it with studio_create_report after I confirm.') }, '✦ Recommend with Copilot')),
      job,
      h('p', { class: 'tiny muted' }, 'Building creates or updates a Report item in your workspace (you approve it here). Previews use Power BI export; if your tenant turns export off, open the report in Power BI instead.'));
  }).catch((e) => { body.innerHTML = ''; body.append(h('div', { class: 'banner err' }, e.message)); });
}

async function startBuild(payload, container) {
  await startJob('/jobs/report', payload, container, 'Report deployed');
}

// ---------------- your own templates ----------------
const SOURCE_LABEL = { pbit: 'Power BI template', pbix: 'Power BI report', zip: 'Power BI project', json: 'Report layout' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Upload, list and use the user's own Power BI templates and themes. */
function templatesSection(p, job, redraw) {
  const list = h('div', { class: 'tpls' }, h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), 'Loading your templates…'));
  const fileIn = h('input', { type: 'file', accept: '.pbit,.pbix,.zip,.json', multiple: true, style: { display: 'none' }, 'aria-label': 'Template files' });
  const btn = h('button', { class: 'btn', 'data-busy': 'Reading…', title: 'Power BI template (.pbit), report (.pbix), zipped Power BI project (.zip), report layout or theme (.json)' }, '⤒ Upload template');
  const send = busy(btn, async (files) => {
    try {
      for (const f of files) {
        const t = await upload(`/report-templates/upload?name=${encodeURIComponent(f.name)}`, f);
        toast(t.kind === 'theme' ? `Theme "${t.name}" added – it's in the Theme list` : `Template "${t.name}" added – ${plural(t.pages.length, 'page')}, ${plural(t.visuals, 'visual')}`, 'ok');
      }
    } finally { catalog = null; redraw(); }
  });
  btn.addEventListener('click', () => fileIn.click());
  fileIn.addEventListener('change', () => { const files = [...fileIn.files]; fileIn.value = ''; if (files.length) send(files); });
  const box = h('div', { class: 'tdrop mt' },
    h('div', { class: 'row sp', style: { alignItems: 'flex-start' } },
      h('div', { style: { minWidth: 0 } }, h('h3', { style: { margin: 0 } }, 'Your own templates'),
        h('div', { class: 'tiny muted' }, 'Use your organization\'s Power BI templates instead of the pages above: .pbit, .pbix, a zipped Power BI project, report.json, or a theme (.json). Drop files here or upload.')),
      h('div', { class: 'row', style: { flexShrink: 0 } }, btn, fileIn)),
    list);
  box.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); box.classList.add('over'); } });
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('over'); });
  box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('over'); const files = [...(e.dataTransfer?.files || [])]; if (files.length) send(files); });
  get('/report-templates').then(({ templates }) => {
    list.innerHTML = '';
    if (!templates.length) { list.append(h('div', { class: 'tiny muted' }, 'No templates yet. Reports keep their pages, visuals, filters, bookmarks, images and look; the studio binds them to your semantic model and matches the fields.')); return; }
    for (const t of templates) list.append(templateRow(t, p, job, redraw));
  }).catch((e) => { list.innerHTML = ''; list.append(h('div', { class: 'banner err' }, e.message)); });
  return box;
}

function templateRow(t, p, job, redraw) {
  const remove = h('button', { class: 'btn ghost danger-text', title: 'Remove from your templates (reports built from it stay)' }, 'Remove');
  remove.addEventListener('click', async () => {
    if (!(await confirmDialog('Remove template', `Remove "${t.name}" from your templates? Reports built from it stay in the workspace.`, 'Remove', true))) return;
    try {
      await del(`/report-templates/${t.id}`);
      if (t.kind === 'theme' && design.theme === t.themeId) design.theme = 'studio';
      catalog = null;
      toast(`Removed ${t.name}`, 'ok');
      redraw();
    } catch (e) { toast(e.message, 'err'); }
  });
  if (t.kind === 'theme') {
    return h('div', { class: 'tplrow' },
      h('div', { class: 'tplmain' },
        h('div', { class: 'row' }, h('b', {}, t.name), h('span', { class: 'pill' }, 'Theme')),
        h('div', { class: 'row', style: { gap: '8px' } }, h('div', { class: 'recsw' }, (t.colors || []).map((c) => h('i', { style: { background: c } }))), h('span', { class: 'tiny muted' }, t.fileName))),
      h('div', { class: 'row tplact' }, h('button', { class: 'btn', disabled: design.theme === t.themeId || undefined, onclick: () => { design.theme = t.themeId; redraw(); } }, design.theme === t.themeId ? 'Selected' : 'Use theme'), remove));
  }
  const built = (p.reports || []).find((r) => r.template?.id === t.id);
  const use = h('button', { class: 'btn pri', title: 'Check the fields against your semantic model, then build the report' }, built ? 'Use again' : 'Use template');
  use.addEventListener('click', () => useTemplate(t, p, job));
  const tables = t.tables.length ? ` · ${plural(t.tables.length, 'table')}: ${t.tables.slice(0, 4).join(', ')}${t.tables.length > 4 ? '…' : ''}` : '';
  return h('div', { class: 'tplrow' },
    h('div', { class: 'tplmain' },
      h('div', { class: 'row' }, h('b', {}, t.name), h('span', { class: 'pill' }, SOURCE_LABEL[t.source] || t.source), built ? h('span', { class: 'pill ok' }, 'Built') : null),
      h('div', { class: 'tiny muted' }, `${plural(t.pages.length, 'page')}: ${t.pages.slice(0, 4).join(' · ')}${t.pages.length > 4 ? ' …' : ''}`),
      h('div', { class: 'tiny muted' }, `${plural(t.visuals, 'visual')}${tables}${t.images ? ` · ${plural(t.images, 'image')}` : ''}${t.customVisuals.length ? ` · ${plural(t.customVisuals.length, 'custom visual')}` : ''}`)),
    h('div', { class: 'row tplact' }, use, remove));
}

/** Check the template against the model, then build it (named with the naming standard). */
function useTemplate(t, p, job) {
  const existing = (p.reports || []).find((r) => r.template?.id === t.id);
  const name = input({ value: existing?.name || standardName('Report', t.name) });
  const result = h('div', { class: 'row muted small' }, h('span', { class: 'spin' }), `Checking the fields against ${p.semanticModel.name}…`);
  let checked = null;
  const m = modal({
    title: `Use template ${t.name}`,
    body: h('div', { class: 'col' },
      h('p', { class: 'small', style: { margin: 0 } }, `${plural(t.pages.length, 'page')} (${t.pages.join(', ')}) · ${plural(t.visuals, 'visual')} · ${SOURCE_LABEL[t.source] || t.source}, ${t.format}. The report is bound to ${p.semanticModel.name}; its look, filters and bookmarks stay as they are.`),
      result,
      ...(t.notes || []).map((n) => h('div', { class: 'tiny muted' }, n)),
      field('Report name', name, 'Following your naming standard. A report with the same name is updated.')),
    actions: [
      { label: 'Cancel' },
      {
        label: existing ? 'Rebuild report' : 'Build report', class: 'pri',
        onClick: async () => {
          if (!checked) { toast('Wait for the field check to finish.', 'err'); return false; }
          try { await startJob('/jobs/report-template', { id: t.id, name: name.value.trim() }, job, 'Report deployed'); } catch (e) { toast(e.message, 'err'); return false; }
          job.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          return true;
        },
      },
    ],
  });
  get(`/report-templates/${t.id}/check`).then((c) => {
    checked = c;
    result.replaceWith(checkView(c));
  }).catch((e) => {
    checked = { failed: true };
    result.replaceWith(h('div', { class: 'banner warn' }, `Couldn't check the fields (${e.message}). You can still build it; visuals whose fields aren't in the model show an error.`));
  });
  return m;
}

function checkView(c) {
  const kind = !c.missing.length ? 'ok' : c.coverage < 50 ? 'err' : 'warn';
  const head = !c.missing.length
    ? `Every field is in ${c.model}${c.mapped.length ? ` (${plural(c.mapped.length, 'field')} matched by name)` : ''}.`
    : `${c.coverage}% of the fields are in ${c.model}. ${c.visualsAffected} of ${plural(c.visuals, 'visual')} use${c.visualsAffected === 1 ? 's' : ''} fields the model doesn't have – they show an error until you pick other fields in Power BI${c.pagesAffected.length ? ` (${c.pagesAffected.join(', ')})` : ''}.`;
  const lines = (items) => h('ul', { class: 'pre small tplfields' }, items.map((x) => h('li', {}, x)));
  return h('div', { class: 'col', style: { gap: '8px' } },
    h('div', { class: `banner ${kind}` }, h('div', {}, head)),
    h('div', { class: 'chips' },
      c.found ? h('span', { class: 'pill ok' }, `${c.found} found as they are`) : null,
      c.mapped.length ? h('span', { class: 'pill brand' }, `${c.mapped.length} matched by name`) : null,
      c.missing.length ? h('span', { class: 'pill err' }, `${c.missing.length} not in the model`) : null,
      c.unchecked.length ? h('span', { class: 'pill' }, `${c.unchecked.length} hierarchies not checked`) : null),
    c.tables.length ? h('div', { class: 'tiny muted' }, `Tables: ${c.tables.map((x) => `${x.from} → ${x.to}`).join(' · ')}`) : null,
    c.mapped.length ? h('details', {}, h('summary', { class: 'small' }, `Matched by name (${c.mapped.length})`), lines(c.mapped.map((x) => `${x.from} → ${x.to}`))) : null,
    c.missing.length ? h('details', { open: c.missing.length <= 8 || undefined }, h('summary', { class: 'small' }, `Not in your model (${c.missing.length})`), lines(c.missing.map((x) => `${x.field} (${x.via ? `used by the report measure ${x.via}` : x.kind})`))) : null,
    c.unchecked.length ? h('div', { class: 'tiny muted' }, `Hierarchies aren't checked: ${c.unchecked.map((x) => x.field).join(', ')}.`) : null);
}
