// Report themes for generated Power BI reports. Styling lives in the theme (visualStyles) so generated visuals only
// carry data bindings and a few overrides. Visual defaults are adapted from the base theme of Microsoft's Power BI
// report skill (microsoft/skills-for-fabric, MIT License, Copyright (c) Microsoft Corporation).

const FONT = 'Segoe UI Variable, Segoe UI, sans-serif';
const FONT_SEMIBOLD = 'Segoe UI Semibold';

export const THEMES = [
  {
    id: 'studio', name: 'Fabric Studio', description: 'Deep blue header, crisp white cards, balanced palette.',
    header: '#0B3B73', headerText: '#FFFFFF', accent: '#2563EB', page: '#F3F6FA', card: '#FFFFFF', border: '#E3E8EF', ink: '#1F2937', muted: '#64748B', grid: '#EEF2F7',
    dataColors: ['#2563EB', '#14B8A6', '#F59E0B', '#8B5CF6', '#EF4444', '#0EA5E9', '#84CC16', '#64748B'],
  },
  {
    id: 'executive', name: 'Executive Navy', description: 'Navy and gold for board and leadership reviews.',
    header: '#14213D', headerText: '#FFFFFF', accent: '#B8892E', page: '#F6F5F1', card: '#FFFFFF', border: '#E5E1D8', ink: '#14213D', muted: '#6B7280', grid: '#EFECE4',
    dataColors: ['#1F3A5F', '#C9A13B', '#5B8DB8', '#8C6D2C', '#9DB4CC', '#3E5F7F', '#D9C08A', '#6B7A8F'],
  },
  {
    id: 'teal', name: 'Teal Modern', description: 'Fresh teal with warm highlights for operational teams.',
    header: '#0F766E', headerText: '#FFFFFF', accent: '#0D9488', page: '#F2F7F6', card: '#FFFFFF', border: '#DCEAE7', ink: '#134E4A', muted: '#5B6B69', grid: '#E8F1EF',
    dataColors: ['#0F766E', '#F97316', '#14B8A6', '#0EA5E9', '#A855F7', '#64748B', '#22C55E', '#EAB308'],
  },
  {
    id: 'slate', name: 'Slate Minimal', description: 'Quiet greys with a single blue accent – lets the numbers speak.',
    header: '#1E293B', headerText: '#F8FAFC', accent: '#0EA5E9', page: '#F8FAFC', card: '#FFFFFF', border: '#E2E8F0', ink: '#0F172A', muted: '#64748B', grid: '#F1F5F9',
    dataColors: ['#0EA5E9', '#334155', '#94A3B8', '#F43F5E', '#38BDF8', '#64748B', '#CBD5E1', '#0F172A'],
  },
  {
    id: 'accessible', name: 'Accessible', description: 'Color-blind safe (Okabe–Ito) palette with strong contrast.',
    header: '#0B3954', headerText: '#FFFFFF', accent: '#0072B2', page: '#FFFFFF', card: '#FFFFFF', border: '#D0D7DE', ink: '#111111', muted: '#4B5563', grid: '#EEEEEE',
    dataColors: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#56B4E9', '#CC79A7', '#F0E442', '#000000'],
  },
  {
    id: 'midnight', name: 'Midnight', description: 'Dark canvas with luminous accents for screens and events.',
    header: '#0B1220', headerText: '#E2E8F0', accent: '#38BDF8', page: '#0F172A', card: '#111C33', border: '#1E2A44', ink: '#E2E8F0', muted: '#94A3B8', grid: '#1E293B', dark: true,
    dataColors: ['#38BDF8', '#A78BFA', '#34D399', '#FBBF24', '#F472B6', '#60A5FA', '#F87171', '#94A3B8'],
  },
];

// Themes uploaded by the user (Power BI theme .json files); kept in step with the template library.
const uploaded = [];
export function setUploadedThemes(list) { uploaded.splice(0, uploaded.length, ...list); }
/** Built-in themes followed by the user's uploaded themes. */
export const allThemes = () => [...THEMES, ...uploaded];
export const themeById = (id) => allThemes().find((t) => t.id === id) || THEMES[0];

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i;
const hex = (v) => {
  if (typeof v !== 'string' || !HEX.test(v.trim())) return null;
  const s = v.trim().slice(1, 7);
  return `#${(s.length === 3 ? s.split('').map((c) => c + c).join('') : s).toUpperCase()}`;
};
const luminance = (c) => {
  const n = parseInt(c.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => { const v = x / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const isDark = (c) => luminance(c) < 0.25;
const styleColor = (json, visual, prop) => hex(json?.visualStyles?.[visual]?.['*']?.[prop]?.[0]?.color?.solid?.color);

/**
 * A studio theme made from a Power BI theme file: its colors drive the generated pages, and the file itself is used
 * as the report's custom theme (so its text classes and visual styles apply too).
 */
export function themeFromPowerBi(json, { id, name }) {
  const colors = (Array.isArray(json.dataColors) ? json.dataColors : []).map(hex).filter(Boolean);
  const dataColors = colors.length ? colors : THEMES[0].dataColors;
  const card = hex(json.background) || styleColor(json, '*', 'background') || '#FFFFFF';
  const dark = isDark(card);
  const page = styleColor(json, 'page', 'background') || (dark ? card : '#F3F6FA');
  const accent = hex(json.tableAccent) || dataColors[0];
  const header = hex(json.tableAccent) || dataColors[0];
  return {
    id, name, description: 'Your Power BI theme (uploaded).', uploaded: true,
    header, headerText: isDark(header) ? '#FFFFFF' : '#111827', accent, page, card,
    border: dark ? '#1E2A44' : '#E3E8EF', ink: hex(json.foreground) || (dark ? '#E2E8F0' : '#1F2937'),
    muted: dark ? '#94A3B8' : '#64748B', grid: dark ? '#1E293B' : '#EEF2F7', dark: isDark(page) || undefined,
    dataColors, json,
  };
}

const solid = (color) => ({ solid: { color } });

/** Power BI report theme JSON for a theme definition. */
export function themeJson(t) {
  const axis = { fontSize: 10, labelColor: solid(t.muted), showAxisTitle: false };
  const cartesian = (legend) => ({
    '*': {
      labels: [{ show: true, fontSize: 9, color: solid(t.ink) }],
      valueAxis: [{ show: false, gridlineShow: false, showAxisTitle: false }],
      categoryAxis: [{ show: true, ...axis, innerPadding: 20, gridlineShow: false }],
      dataPoint: [{ borderShow: false }],
      legend: [{ show: legend, fontSize: 9, labelColor: solid(t.muted), position: 'Top', showTitle: false }],
    },
  });
  const table = {
    '*': {
      columnHeaders: [{ autoSizeColumnWidth: true, columnAdjustment: 'growToFit', backColor: solid(t.dark ? '#16233F' : '#F3F5F8'), fontColor: solid(t.ink), bold: true, fontFamily: FONT_SEMIBOLD, fontSize: 9 }],
      values: [{ backColorPrimary: solid(t.card), backColorSecondary: solid(t.dark ? '#14203A' : '#FAFBFC'), fontColorPrimary: solid(t.ink), fontColorSecondary: solid(t.ink), fontSize: 9 }],
      total: [{ backColor: solid(t.dark ? '#16233F' : '#F3F5F8'), fontColor: solid(t.ink), bold: true }],
      grid: [{ gridHorizontal: true, gridHorizontalColor: solid(t.grid), gridVertical: false, rowPadding: 4 }],
    },
  };
  return {
    name: `Fabric Studio – ${t.name}`,
    dataColors: t.dataColors,
    background: t.card,
    foreground: t.ink,
    tableAccent: t.accent,
    good: '#16A34A',
    neutral: '#D97706',
    bad: '#DC2626',
    maximum: t.accent,
    center: '#D9B300',
    minimum: t.dark ? '#1E293B' : '#E0ECFF',
    null: '#FF7F48',
    textClasses: {
      callout: { fontSize: 26, fontFace: FONT, color: t.ink },
      title: { fontSize: 12, fontFace: FONT_SEMIBOLD, color: t.ink },
      header: { fontSize: 11, fontFace: FONT_SEMIBOLD, color: t.ink },
      label: { fontSize: 9, fontFace: FONT, color: t.muted },
    },
    visualStyles: {
      '*': {
        '*': {
          background: [{ show: true, color: solid(t.card), transparency: 0 }],
          border: [{ show: true, color: solid(t.border), radius: 10 }],
          dropShadow: [{ show: false }],
          padding: [{ top: 10, bottom: 8, left: 12, right: 12 }],
          title: [{ show: true, fontColor: solid(t.ink), fontSize: 11, fontFamily: FONT_SEMIBOLD, alignment: 'left' }],
          categoryAxis: [{ gridlineStyle: 'dotted', gridlineColor: solid(t.grid) }],
          valueAxis: [{ gridlineStyle: 'dotted', gridlineColor: solid(t.grid) }],
        },
      },
      page: {
        '*': {
          background: [{ color: solid(t.page), transparency: 0 }],
          outspace: [{ color: solid(t.page), transparency: 0 }],
        },
      },
      cardVisual: {
        '*': {
          value: [{ bold: true, fontSize: 24, fontColor: solid(t.ink), $id: 'default' }],
          label: [{ show: true, fontSize: 10, fontColor: solid(t.muted), $id: 'default' }],
          cardCalloutArea: [{ paddingUniform: 0 }],
          border: [{ show: true, color: solid(t.border), radius: 10 }],
          title: [{ show: false }],
          padding: [{ top: 6, bottom: 6, left: 6, right: 6 }],
        },
      },
      card: {
        '*': {
          labels: [{ color: solid(t.ink), fontSize: 24, fontFamily: FONT_SEMIBOLD }],
          categoryLabels: [{ show: true, color: solid(t.muted), fontSize: 10 }],
          title: [{ show: false }],
        },
      },
      textbox: { '*': { padding: [{ top: 0, bottom: 0, left: 0, right: 0 }], background: [{ show: false }], border: [{ show: false }], title: [{ show: false }] } },
      shape: { '*': { border: [{ show: false }], background: [{ show: false }], title: [{ show: false }], padding: [{ top: 0, bottom: 0, left: 0, right: 0 }] } },
      image: { '*': { border: [{ show: false }], background: [{ show: false }], title: [{ show: false }] } },
      barChart: cartesian(false),
      clusteredBarChart: cartesian(true),
      columnChart: cartesian(false),
      clusteredColumnChart: cartesian(true),
      lineChart: {
        '*': {
          lineStyles: [{ strokeWidth: 2.5, lineChartType: 'smooth', interpolationSmooth: 'monotoneX', areaShow: true, areaMatchStrokeColor: true }],
          dataPoint: [{ transparency: 85 }],
          labels: [{ show: false }],
          categoryAxis: [{ show: true, ...axis, gridlineShow: false }],
          valueAxis: [{ show: true, fontSize: 9, labelColor: solid(t.muted), showAxisTitle: false, gridlineShow: true, gridlineStyle: 'dotted', gridlineColor: solid(t.grid) }],
          legend: [{ show: true, fontSize: 9, labelColor: solid(t.muted), position: 'Top', showTitle: false }],
        },
      },
      donutChart: {
        '*': {
          legend: [{ show: true, position: 'RightCenter', fontSize: 9, labelColor: solid(t.muted) }],
          labels: [{ show: true, labelStyle: 'Percent of total', fontSize: 9, color: solid(t.ink) }],
          slices: [{ innerRadiusRatio: 62 }],
        },
      },
      tableEx: table,
      pivotTable: table,
      slicer: {
        '*': {
          header: [{ fontFamily: FONT_SEMIBOLD, textSize: 9, fontColor: solid(t.muted), outlineStyle: 0 }],
          items: [{ fontFamily: FONT, textSize: 9, fontColor: solid(t.ink), outlineStyle: 0, padding: 2, background: solid(t.card) }],
          date: [{ fontFamily: FONT, textSize: 9, fontColor: solid(t.ink) }],
          title: [{ show: false }],
        },
      },
    },
  };
}
