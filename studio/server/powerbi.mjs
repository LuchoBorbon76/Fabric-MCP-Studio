// Power BI REST: DAX queries against semantic models (model metadata and profiling) and report export for previews.
import { getToken, SCOPES } from './auth.mjs';
import { sleep } from './config.mjs';

const API = 'https://api.powerbi.com/v1.0/myorg';

export class PowerBIError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body; }
}

async function pbi(method, path, body, { raw = false } = {}) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const token = await getToken(SCOPES.powerbi);
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep((Number(res.headers.get('retry-after')) || 4 * attempt) * 1000);
      continue;
    }
    if (raw) {
      if (!res.ok) throw new PowerBIError(`${method} ${path} failed (${res.status}): ${await res.text()}`, res.status);
      return res;
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = json?.error?.['pbi.error']?.details?.[0]?.detail?.value || json?.error?.message || json?.message || text || res.statusText;
      // A paused or overloaded capacity can't open the model: say so instead of the engine message.
      if (/Failed to open the MSOLAP connection/i.test(msg)) throw new PowerBIError('The semantic model can\'t be queried right now. Check that the workspace\'s Fabric capacity is running (a paused capacity can\'t answer queries), then try again.', res.status, json);
      throw new PowerBIError(`${method} ${path} failed (${res.status}): ${msg}`, res.status, json);
    }
    return json;
  }
  throw new PowerBIError(`${method} ${path} failed after retries`, 0);
}

/** Run one DAX query and return the rows with the brackets removed from column names. */
export async function dax(workspaceId, datasetId, query) {
  const r = await pbi('POST', `/groups/${workspaceId}/datasets/${datasetId}/executeQueries`, { queries: [{ query }], serializerSettings: { includeNulls: true } });
  const t = r?.results?.[0];
  if (t?.error) throw new PowerBIError(t.error.message || 'DAX query failed', 400, t.error);
  return (t?.tables?.[0]?.rows || []).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/^.*\[(.*)\]$/, '$1'), v])));
}

/**
 * Semantic model metadata from the INFO.VIEW functions: works for any model the user can query (not only models the
 * studio created), and needs only Build/Read permission.
 */
export async function modelMetadata(workspaceId, datasetId) {
  const [tables, columns, measures, relationships] = await Promise.all([
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.TABLES(), "Name", [Name], "IsHidden", [IsHidden], "DataCategory", [DataCategory], "Description", [Description])'),
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.COLUMNS(), "Table", [Table], "Name", [Name], "DataType", [DataType], "DataCategory", [DataCategory], "IsHidden", [IsHidden], "IsKey", [IsKey], "FormatString", [FormatString], "SortByColumn", [SortByColumn], "Type", [Type], "Description", [Description])'),
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.MEASURES(), "Table", [Table], "Name", [Name], "Expression", [Expression], "FormatString", [FormatString], "DisplayFolder", [DisplayFolder], "IsHidden", [IsHidden], "Description", [Description], "DataType", [DataType])'),
    dax(workspaceId, datasetId, 'EVALUATE SELECTCOLUMNS(INFO.VIEW.RELATIONSHIPS(), "FromTable", [FromTable], "FromColumn", [FromColumn], "ToTable", [ToTable], "ToColumn", [ToColumn], "IsActive", [IsActive], "FromCardinality", [FromCardinality], "ToCardinality", [ToCardinality])'),
  ]);
  const visibleCol = (c) => !c.IsHidden && c.Type !== 'RowNumber' && !/^RowNumber-/.test(c.Name);
  return {
    tables: tables.filter((t) => !t.IsHidden).map((t) => ({ name: t.Name, dataCategory: t.DataCategory || '', description: t.Description || '' })),
    columns: columns.filter(visibleCol).map((c) => ({ table: c.Table, name: c.Name, dataType: c.DataType, dataCategory: c.DataCategory || '', isKey: Boolean(c.IsKey), formatString: c.FormatString || '', sortBy: c.SortByColumn || '', description: c.Description || '' })),
    measures: measures.filter((m) => !m.IsHidden).map((m) => ({ table: m.Table, name: m.Name, expression: m.Expression || '', formatString: m.FormatString || '', displayFolder: m.DisplayFolder || '', description: m.Description || '', dataType: m.DataType })),
    relationships: relationships.map((r) => ({ fromTable: r.FromTable, fromColumn: r.FromColumn, toTable: r.ToTable, toColumn: r.ToColumn, active: r.IsActive !== false, fromCardinality: r.FromCardinality, toCardinality: r.ToCardinality })),
  };
}

/**
 * Refresh (reframe) a semantic model and wait for it to finish. Direct Lake models only reload their metadata, so this
 * takes seconds. Returns the final status ('Completed', 'Failed', or 'Timeout').
 */
export async function refreshDataset(workspaceId, datasetId, { timeoutMs = 3 * 60 * 1000, signal } = {}) {
  await pbi('POST', `/groups/${workspaceId}/datasets/${datasetId}/refreshes`, { notifyOption: 'NoNotification' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('Cancelled');
    await sleep(4000);
    const r = await pbi('GET', `/groups/${workspaceId}/datasets/${datasetId}/refreshes?$top=1`);
    const s = r?.value?.[0];
    if (s && s.status && s.status !== 'Unknown' && s.status !== 'NotStarted') return { status: s.status, error: s.serviceExceptionJson || null };
  }
  return { status: 'Timeout' };
}

/**
 * Make a DirectQuery semantic model use each viewer's own Microsoft Entra identity (single sign-on) for its cloud
 * data sources, e.g. an Eventhouse. `tokenFor(datasource)` returns an access token for that source (the caller's).
 * Returns the data sources that were set up and the ones that failed, with the reason.
 */
export async function useSingleSignOn(workspaceId, datasetId, tokenFor) {
  const list = (await pbi('GET', `/groups/${workspaceId}/datasets/${datasetId}/datasources`))?.value || [];
  const done = [];
  const failed = [];
  for (const ds of list) {
    if (!ds.gatewayId || !ds.datasourceId) { failed.push({ datasource: ds.datasourceType, error: 'No cloud data source to configure yet.' }); continue; }
    try {
      const accessToken = await tokenFor(ds);
      await pbi('PATCH', `/gateways/${ds.gatewayId}/datasources/${ds.datasourceId}`, {
        credentialDetails: {
          credentialType: 'OAuth2',
          credentials: JSON.stringify({ credentialData: [{ name: 'accessToken', value: accessToken }] }),
          encryptedConnection: 'Encrypted', encryptionAlgorithm: 'None', privacyLevel: 'Organizational', useEndUserOAuth2Credentials: true,
        },
      });
      done.push({ datasource: ds.datasourceType, details: ds.connectionDetails || null });
    } catch (e) { failed.push({ datasource: ds.datasourceType, error: e.message }); }
  }
  return { done, failed, total: list.length };
}

/**
 * Render a report for a preview. PNG needs the "Export reports as image files" tenant setting (off by default), so fall
 * back to PDF (on by default). Returns { format, contentType, bytes }.
 */
export async function exportReport(workspaceId, reportId, { pages, signal, timeoutMs = 4 * 60 * 1000 } = {}) {
  const pageSettings = pages?.length ? { powerBIReportConfiguration: { pages: pages.map((pageName) => ({ pageName })) } } : {};
  let format = 'PNG';
  let job;
  try {
    job = await pbi('POST', `/groups/${workspaceId}/reports/${reportId}/ExportTo`, { format, ...pageSettings });
  } catch (e) {
    if (!/image|disabled|PNG/i.test(e.message)) throw e;
    format = 'PDF';
    job = await pbi('POST', `/groups/${workspaceId}/reports/${reportId}/ExportTo`, { format, ...pageSettings });
  }
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new Error('Cancelled');
    if (Date.now() > deadline) throw new PowerBIError('The report export took too long.', 0);
    await sleep(4000);
    const s = await pbi('GET', `/groups/${workspaceId}/reports/${reportId}/exports/${job.id}`);
    if (s.status === 'Succeeded') break;
    if (s.status === 'Failed') throw new PowerBIError(`The report export failed: ${s.error?.message || 'unknown error'}`, 0, s);
  }
  const file = await pbi('GET', `/groups/${workspaceId}/reports/${reportId}/exports/${job.id}/file`, undefined, { raw: true });
  return { format, contentType: file.headers.get('content-type') || (format === 'PDF' ? 'application/pdf' : 'image/png'), bytes: Buffer.from(await file.arrayBuffer()) };
}
