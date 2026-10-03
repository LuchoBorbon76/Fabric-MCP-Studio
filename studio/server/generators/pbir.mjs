// Power BI report (PBIR) generator: turns a report plan (pages, KPIs, charts, tables, slicers) into a Fabric Report
// item definition bound to an existing semantic model. Formatting lives in the custom theme (reports/themes.mjs);
// visuals carry data bindings plus container settings. Layout follows a 1280x720 canvas, 24 px margins, 16 px gutters.
import { createHash } from 'node:crypto';
import { themeJson } from '../reports/themes.mjs';

const S = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition';
const V = { report: '3.1.0', page: '2.0.0', visual: '2.0.0', pages: '1.0.0', version: '1.0.0' };
export const PAGE = { width: 1280, height: 720, margin: 24, gutter: 16, header: 72 };

// ---------------- expressions ----------------
const lit = (v) => ({ expr: { Literal: { Value: v } } });
const text = (s) => lit(`'${String(s).replace(/'/g, "''")}'`);
const dec = (n) => lit(`${n}D`);
const int = (n) => lit(`${Math.round(n)}L`);
const bool = (b) => lit(b ? 'true' : 'false');
const color = (hex) => ({ solid: { color: lit(`'${hex}'`) } });
const props = (p, selector) => ({ properties: p, ...(selector ? { selector } : {}) });

export const hexId = (...parts) => createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);

/** ref: { kind: 'measure' | 'column', table, name } */
export function fieldOf(ref) {
  const source = { Expression: { SourceRef: { Entity: ref.table } }, Property: ref.name };
  return ref.kind === 'measure' ? { Measure: source } : { Column: source };
}
const queryRef = (ref) => `${ref.table}.${ref.name}`;
function projection(ref, extra = {}) {
  return { field: fieldOf(ref), queryRef: queryRef(ref), nativeQueryRef: ref.name, ...(ref.label && ref.label !== ref.name ? { displayName: ref.label } : {}), ...extra };
}
const sortBy = (refs) => ({ sort: refs.map(([ref, direction]) => ({ field: fieldOf(ref), direction })), isDefaultSort: false });

/** Mix a hex color with white (amount 0..1) – soft fills such as data bars behind dark text. */
export function tint(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (s) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * amount);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

// ---------------- containers ----------------
function container(name, pos, visual, extra = {}) {
  return {
    $schema: `${S}/visualContainer/${V.visual}/schema.json`,
    name,
    position: { x: pos.x, y: pos.y, z: pos.z ?? 1000, width: pos.w, height: pos.h, tabOrder: pos.tab ?? pos.z ?? 1000 },
    visual,
    ...extra,
  };
}

/** Container settings for data visuals; set together so per-visual values don't reset the theme cascade. */
function frame(theme, { title, alt, background = true, border = true, padding = 10 } = {}) {
  const vco = {
    background: [props({ show: bool(background), ...(background ? { color: color(theme.card), transparency: dec(0) } : {}) })],
    border: [props({ show: bool(border), ...(border ? { color: color(theme.border), radius: dec(10) } : {}) })],
    padding: [props({ top: dec(padding), bottom: dec(Math.max(4, padding - 2)), left: dec(padding + 2), right: dec(padding + 2) })],
    title: [props(title ? { show: bool(true), text: text(title), fontColor: color(theme.ink), fontSize: dec(11), alignment: text('left') } : { show: bool(false) })],
  };
  if (alt) vco.general = [props({ altText: text(alt) })];
  return vco;
}

// ---------------- visuals ----------------
export const V_ = {
  band(theme, pos, fill, radius = 0) {
    return {
      visualType: 'shape',
      objects: {
        shape: [props({ tileShape: text('rectangle'), roundEdge: int(radius) })],
        fill: [props({ fillColor: color(fill), transparency: dec(0) }, { id: 'default' })],
        outline: [props({ show: bool(false) }, { id: 'default' })],
      },
      visualContainerObjects: { background: [props({ show: bool(false) })], border: [props({ show: bool(false) })], padding: [props({ top: dec(0), bottom: dec(0), left: dec(0), right: dec(0) })], title: [props({ show: bool(false) })] },
      drillFilterOtherVisuals: true,
    };
  },

  textbox(lines) {
    return {
      visualType: 'textbox',
      objects: {
        general: [props({
          paragraphs: lines.map((l) => ({
            textRuns: [{ value: l.text, textStyle: { fontFamily: l.bold ? 'Segoe UI Semibold' : 'Segoe UI', fontSize: `${l.size}px`, ...(l.bold ? { fontWeight: 'bold' } : {}), color: l.color } }],
            horizontalTextAlignment: l.align || 'left',
          })),
        })],
      },
      visualContainerObjects: { background: [props({ show: bool(false) })], border: [props({ show: bool(false) })], padding: [props({ top: dec(0), bottom: dec(0), left: dec(0), right: dec(0) })], title: [props({ show: bool(false) })] },
    };
  },

  card(theme, measure, { label, accent } = {}) {
    const f = frame(theme, { alt: `${label || measure.name} card` });
    f.padding = [props({ top: dec(0), bottom: dec(0), left: dec(0), right: dec(0) })];
    return {
      visualType: 'cardVisual',
      query: { queryState: { Data: { projections: [projection(measure)] } } },
      objects: {
        value: [props({ fontSize: dec(24), fontColor: color(theme.ink), bold: bool(true) }, { id: 'default' })],
        label: [props({ show: bool(true), ...(label ? { text: text(label) } : {}), fontSize: dec(10), fontColor: color(theme.muted) }, { id: 'default' })],
        accentBar: [props({ show: bool(true), position: text('Left'), width: dec(4), color: color(accent || theme.accent) }, { id: 'default' })],
        outline: [props({ show: bool(false) }, { id: 'default' })],
        padding: [props({ paddingUniform: dec(14) }, { id: 'default' })],
      },
      visualContainerObjects: f,
    };
  },

  trend(theme, { measures, axis, title, area = true, labels = false }) {
    return {
      visualType: 'lineChart',
      query: {
        queryState: {
          Category: { projections: axis.map((a) => projection(a, { active: true })) },
          Y: { projections: measures.map((m) => projection(m)) },
        },
        sortDefinition: sortBy(axis.map((a) => [a, 'Ascending'])),
      },
      objects: {
        // Year + period on one axis: hierarchical labels (periods above, years below) instead of "2012 3".
        categoryAxis: [props({ axisType: text('Categorical'), concatenateLabels: bool(false), showAxisTitle: bool(false), gridlineShow: bool(false) })],
        valueAxis: [props({ showAxisTitle: bool(false), start: dec(0) })],
        lineStyles: [props({ strokeWidth: dec(2.5), lineChartType: text('smooth'), areaShow: bool(area), areaMatchStrokeColor: bool(true), showMarker: bool(labels) })],
        labels: [props({ show: bool(labels), fontSize: dec(9), labelPosition: text('Above') })],
        legend: [props({ show: bool(measures.length > 1), position: text('Top'), showTitle: bool(false) })],
      },
      visualContainerObjects: frame(theme, { title, alt: title }),
    };
  },

  bars(theme, { measures, category, title, horizontal = true, series }) {
    return {
      visualType: horizontal ? 'clusteredBarChart' : 'clusteredColumnChart',
      query: {
        queryState: {
          Category: { projections: [projection(category, { active: true })] },
          Y: { projections: measures.map((m) => projection(m)) },
          ...(series ? { Series: { projections: [projection(series)] } } : {}),
        },
        sortDefinition: horizontal || category.sortByValue ? sortBy([[measures[0], 'Descending']]) : sortBy([[category, 'Ascending']]),
      },
      objects: {
        labels: [props({ show: bool(true), fontSize: dec(9) })],
        legend: [props({ show: bool(measures.length > 1 || Boolean(series)), position: text('Top'), showTitle: bool(false) })],
        valueAxis: [props({ show: bool(false), start: dec(0) })],
        ...(horizontal ? { categoryAxis: [props({ maxMarginFactor: int(40) })] } : {}),
      },
      visualContainerObjects: frame(theme, { title, alt: title }),
    };
  },

  donut(theme, { measure, category, title }) {
    return {
      visualType: 'donutChart',
      query: {
        queryState: { Category: { projections: [projection(category, { active: true })] }, Y: { projections: [projection(measure)] } },
        sortDefinition: sortBy([[measure, 'Descending']]),
      },
      objects: {
        legend: [props({ show: bool(true), position: text('RightCenter'), showTitle: bool(false) })],
        labels: [props({ show: bool(true), labelStyle: text('Percent of total'), percentageLabelPrecision: int(0) })],
      },
      visualContainerObjects: frame(theme, { title, alt: title }),
    };
  },

  table(theme, { columns, measures, title, bars }) {
    const all = [...columns, ...measures];
    return {
      visualType: 'tableEx',
      query: {
        queryState: { Values: { projections: all.map((r) => projection(r)) } },
        sortDefinition: sortBy([[measures[0], 'Descending']]),
      },
      objects: bars ? {
        columnFormatting: [props({ dataBars: { positiveColor: color(tint(theme.accent, theme.dark ? 0.35 : 0.72)), negativeColor: color(tint('#DC2626', 0.6)), axisColor: color(theme.border), reverseDirection: bool(false), hideText: bool(false) } }, { metadata: queryRef(measures[0]) })],
      } : {},
      visualContainerObjects: frame(theme, { title, alt: title }),
    };
  },

  matrix(theme, { rows, columns, measures, title }) {
    return {
      visualType: 'pivotTable',
      query: {
        queryState: {
          Rows: { projections: rows.map((r) => projection(r, { active: true })) },
          ...(columns?.length ? { Columns: { projections: columns.map((r) => projection(r, { active: true })) } } : {}),
          Values: { projections: measures.map((m) => projection(m)) },
        },
      },
      visualContainerObjects: frame(theme, { title, alt: title }),
    };
  },

  slicer(theme, { field, title, mode = 'Dropdown' }) {
    const f = frame(theme, { padding: 6 });
    f.border = [props({ show: bool(false) })];
    f.background = [props({ show: bool(true), color: color(theme.card), transparency: dec(0) })];
    return {
      visualType: 'slicer',
      query: { queryState: { Values: { projections: [projection(field, { active: true })] } } },
      objects: {
        data: [props({ mode: text(mode) })],
        header: [props({ show: bool(true), text: text(title || field.label || field.name), fontColor: color(theme.muted), textSize: dec(8) })],
        items: [props({ textSize: dec(10), fontColor: color(theme.ink) })],
        selection: [props({ selectAllCheckboxEnabled: bool(true), singleSelect: bool(false) })],
      },
      visualContainerObjects: f,
    };
  },
};

/** Top N filter on a category by a measure (visual level). Every entity used in the subquery must be in its From. */
export function topNFilter(category, measure, n) {
  const sameTable = measure.table === category.table;
  const mSource = sameTable ? 'c' : 'm';
  const orderBy = measure.kind === 'measure'
    ? { Measure: { Expression: { SourceRef: { Source: mSource } }, Property: measure.name } }
    : { Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: mSource } }, Property: measure.name } }, Function: 0 } };
  return {
    filters: [{
      name: `Filter${hexId('topn', queryRef(category), queryRef(measure), n).slice(0, 18)}`,
      field: fieldOf(category),
      type: 'TopN',
      filter: {
        Version: 2,
        From: [
          {
            Name: 'subquery',
            Expression: {
              Subquery: {
                Query: {
                  Version: 2,
                  From: [{ Name: 'c', Entity: category.table, Type: 0 }, ...(sameTable ? [] : [{ Name: 'm', Entity: measure.table, Type: 0 }])],
                  Select: [{ Column: { Expression: { SourceRef: { Source: 'c' } }, Property: category.name }, Name: 'field' }],
                  OrderBy: [{ Direction: 2, Expression: orderBy }],
                  Top: n,
                },
              },
            },
            Type: 2,
          },
          { Name: 'c', Entity: category.table, Type: 0 },
        ],
        Where: [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 'c' } }, Property: category.name } }], Table: { SourceRef: { Source: 'subquery' } } } } }],
      },
      howCreated: 'User',
    }],
  };
}

// ---------------- report assembly ----------------

/**
 * report: { name, semanticModelId, theme, pages: [{ name, displayName, visuals: [{ key, pos, visual, filterConfig? }] }] }
 * Returns the Fabric REST definition files map (path -> JSON/string).
 */
export function reportFiles(report) {
  const theme = report.theme;
  const themeName = `FabricStudio-${theme.id}.json`;
  const themeFile = { ...themeJson(theme), name: themeName };
  const files = {
    'definition.pbir': { $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json', version: '4.0', datasetReference: { byConnection: { connectionString: `semanticmodelid=${report.semanticModelId}` } } },
    'definition/version.json': { $schema: `${S}/versionMetadata/${V.version}/schema.json`, version: '2.0.0' },
    'definition/report.json': {
      $schema: `${S}/report/${V.report}/schema.json`,
      themeCollection: {
        baseTheme: { name: 'CY25SU12', reportVersionAtImport: { visual: '2.5.0', report: '3.1.0', page: '2.3.0' }, type: 'SharedResources' },
        customTheme: { name: themeName, reportVersionAtImport: { visual: '2.5.0', report: '3.1.0', page: '2.3.0' }, type: 'RegisteredResources' },
      },
      resourcePackages: [
        { name: 'SharedResources', type: 'SharedResources', items: [{ name: 'CY25SU12', path: 'BaseThemes/CY25SU12.json', type: 'BaseTheme' }] },
        { name: 'RegisteredResources', type: 'RegisteredResources', items: [{ name: themeName, path: themeName, type: 'CustomTheme' }] },
      ],
      objects: { outspacePane: [props({ expanded: bool(false), visible: bool(true) })] },
      settings: { useStylableVisualContainerHeader: true, defaultDrillFilterOtherVisuals: true, defaultFilterActionIsDataFilter: true, allowChangeFilterTypes: true, useEnhancedTooltips: true },
    },
    [`StaticResources/RegisteredResources/${themeName}`]: themeFile,
    'definition/pages/pages.json': { $schema: `${S}/pagesMetadata/${V.pages}/schema.json`, pageOrder: report.pages.map((p) => p.name), activePageName: report.pages[0].name },
  };
  for (const p of report.pages) {
    files[`definition/pages/${p.name}/page.json`] = {
      $schema: `${S}/page/${V.page}/schema.json`,
      name: p.name,
      displayName: p.displayName,
      displayOption: 'FitToPage',
      height: PAGE.height,
      width: PAGE.width,
      objects: {
        background: [props({ color: color(theme.page), transparency: dec(0) })],
        outspace: [props({ color: color(theme.page), transparency: dec(0) })],
      },
      ...(p.filterConfig ? { filterConfig: p.filterConfig } : {}),
    };
    p.visuals.forEach((v, i) => {
      const name = hexId(p.name, v.key);
      files[`definition/pages/${p.name}/visuals/${name}/visual.json`] = container(name, { ...v.pos, z: v.pos.z ?? (i + 1) * 1000, tab: (i + 1) * 1000 }, v.visual, v.filterConfig ? { filterConfig: v.filterConfig } : {});
    });
  }
  return files;
}
