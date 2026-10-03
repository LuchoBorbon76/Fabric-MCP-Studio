// Activator alerts on live business-rule breaks: a KQL source over the live table (polled every minute), one
// event-trigger rule per business rule, and a Teams message or email with the event details.
import { stableUuid } from '../config.mjs';
import { kqlName } from './kusto.mjs';

export const ALERT_CHANNELS = ['teams', 'email'];
const EMAIL_RX = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export function cleanRecipients(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
  const bad = arr.filter((x) => !EMAIL_RX.test(x));
  if (bad.length) throw new Error(`Not an email address: ${bad.join(', ')}`);
  const uniq = [...new Set(arr.map((x) => x.toLowerCase()))];
  if (!uniq.length) throw new Error('Add at least one recipient.');
  if (uniq.length > 10) throw new Error('Use at most 10 recipients (or a distribution list).');
  return uniq;
}

/** The KQL the Activator runs. startTime/endTime are filled by Activator (watermark → now − ingestion delay). */
export function alertQuery(scenario, { minAmount = 0 } = {}) {
  const R = Object.fromEntries(scenario.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
  const time = R.time || 'EventTime';
  const keep = ['time', 'order', 'channel', 'item', 'party', 'region', 'site', 'qty', 'amount', 'discount', 'margin', 'rule'].map((r) => R[r]).filter(Boolean);
  const amountFilter = R.amount && Number(minAmount) > 0 ? ` and ${kqlName(R.amount)} >= ${Number(minAmount)}` : '';
  return [
    'declare query_parameters(startTime:datetime, endTime:datetime);',
    kqlName(scenario.table),
    `| where ${kqlName(time)} > startTime and ${kqlName(time)} <= endTime`,
    `| where isnotempty(${kqlName(R.rule || 'RuleBreak')})${amountFilter}`,
    `| project ${[...new Set(keep)].map(kqlName).join(', ')}`,
  ].join('\n');
}

const str = (v) => ({ type: 'string', value: v });
const fieldPart = (f) => ({ kind: 'EventFieldReference', type: 'complex', arguments: [{ name: 'fieldName', type: 'string', value: f }] });
const pair = (name, f) => ({ kind: 'NameReferencePair', type: 'complex', arguments: [{ name: 'name', type: 'string', value: name }, { kind: 'EventFieldReference', type: 'complexReference', name: 'reference', arguments: [{ name: 'fieldName', type: 'string', value: f }] }] });

/**
 * ReflexEntities.json for the alerts.
 * rules: scenario rules to alert on ([{ id, label, description }]); channel: teams | email; recipients: emails.
 */
export function alertEntities({ workspaceId, database, scenario, rules, channel, recipients, minAmount = 0, intervalSeconds = 60, startAt = new Date() }) {
  const id = (...p) => stableUuid('rfx', database.id, ...p);
  const R = Object.fromEntries(scenario.columns.filter((c) => c.role).map((c) => [c.role, c.name]));
  const label = (role) => scenario.columns.find((c) => c.role === role)?.label || role;
  const C = id('container'), S = id('source'), E = id('event');
  const at = startAt.toISOString();
  const entities = [
    { uniqueIdentifier: C, payload: { name: 'Business rule alerts', type: 'kqlQueries' }, type: 'container-v1' },
    {
      uniqueIdentifier: S,
      payload: {
        name: `Live ${scenario.unit} rule breaks`,
        runSettings: { executionIntervalInSeconds: intervalSeconds },
        query: { queryString: alertQuery(scenario, { minAmount }) },
        eventhouseItem: { itemId: database.id, workspaceId, itemType: 'KustoDatabase' },
        queryParameters: [{ name: 'startTime', type: 'DURATION_START', value: at }, { name: 'endTime', type: 'DURATION_END', value: at }],
        eventTimeSettings: { timeFieldName: R.time || 'EventTime', ingestionDelayInSeconds: 60, timeZone: 'UTC' },
        metadata: { workspaceId, measureName: '', querySetId: '', queryId: '' },
        parentContainer: { targetUniqueIdentifier: C },
      },
      type: 'kqlSource-v1',
    },
    {
      uniqueIdentifier: E,
      payload: {
        name: 'Rule breaks',
        parentContainer: { targetUniqueIdentifier: C },
        definition: { type: 'Event', instance: JSON.stringify({ templateId: 'SourceEvent', templateVersion: '1.2.4', steps: [{ name: 'SourceEventStep', id: id('event', 'step'), rows: [{ name: 'SourceSelector', kind: 'SourceReference', arguments: [{ name: 'entityId', type: 'string', value: S }] }] }] }) },
      },
      type: 'timeSeriesView-v1',
    },
  ];

  const subject = (rule) => [str(`${rule.label}: `), fieldPart(R.item || R.order || R.rule)];
  const message = [
    ...(R.order ? [str(`${label('order')} `), fieldPart(R.order)] : [str('An event')]),
    ...(R.party ? [str(' for '), fieldPart(R.party)] : []),
    ...(R.region ? [str(' in '), fieldPart(R.region)] : []),
    str(' broke a business rule.'),
  ];
  const details = ['amount', 'discount', 'margin', 'qty', 'channel', 'site'].filter((r) => R[r]).map((r) => pair(label(r), R[r]));

  for (const rule of rules) {
    const act = channel === 'email'
      ? { name: 'EmailBinding', kind: 'EmailMessage', arguments: [
        { name: 'messageLocale', type: 'string', value: 'en-us' },
        { name: 'sentTo', type: 'array', values: recipients.map(str) },
        { name: 'copyTo', type: 'array', values: [] },
        { name: 'bCCTo', type: 'array', values: [] },
        { name: 'subject', type: 'array', values: subject(rule) },
        { name: 'headline', type: 'array', values: [str(rule.label)] },
        { name: 'optionalMessage', type: 'array', values: [...message, str(` ${rule.description || ''}`.trimEnd())] },
        { name: 'additionalInformation', type: 'array', values: details },
      ] }
      : { name: 'TeamsBinding', kind: 'TeamsMessage', arguments: [
        { name: 'messageLocale', type: 'string', value: '' },
        { name: 'recipients', type: 'array', values: recipients.map(str) },
        { name: 'headline', type: 'array', values: subject(rule) },
        { name: 'optionalMessage', type: 'array', values: [...message, str(` ${rule.description || ''}`.trimEnd())] },
        { name: 'additionalInformation', type: 'array', values: details },
      ] };
    const instance = {
      templateId: 'EventTrigger', templateVersion: '1.2.4',
      steps: [
        { name: 'FieldsDefaultsStep', id: id('rule', rule.id, 'fields'), rows: [{ name: 'EventSelector', kind: 'Event', arguments: [{ name: 'event', kind: 'EventReference', type: 'complex', arguments: [{ name: 'entityId', type: 'string', value: E }] }] }] },
        { name: 'EventDetectStep', id: id('rule', rule.id, 'detect'), rows: [
          { name: 'EventFieldSelector', kind: 'EventField', arguments: [{ name: 'fieldName', type: 'string', value: R.rule || 'RuleBreak' }] },
          { name: 'TextValueCondition', kind: 'TextValueCondition', arguments: [{ name: 'op', type: 'string', value: 'IsEqualTo' }, { name: 'value', type: 'string', value: rule.label }] },
        ] },
        { name: 'ActStep', id: id('rule', rule.id, 'act'), rows: [act] },
      ],
    };
    entities.push({
      uniqueIdentifier: id('rule', rule.id),
      payload: {
        name: rule.label,
        description: `${rule.description || ''} Created by Fabric MCP Studio.`.trim(),
        parentContainer: { targetUniqueIdentifier: C },
        definition: { type: 'Rule', instance: JSON.stringify(instance), settings: { shouldRun: true, shouldApplyRuleOnUpdate: false } },
      },
      type: 'timeSeriesView-v1',
    });
  }
  return entities;
}
