// Microsoft Entra ID tokens for Fabric, OneLake, SQL endpoints, Azure Resource Manager and Azure OpenAI.
// Default: reuse the customer's Azure CLI sign-in (`az login`). Fallback: interactive browser sign-in.
import { AzureCliCredential, InteractiveBrowserCredential } from '@azure/identity';
import { runAz } from './azcli.mjs';
import { getSettings } from './config.mjs';

export const SCOPES = {
  fabric: 'https://api.fabric.microsoft.com/.default',
  storage: 'https://storage.azure.com/.default',
  sql: 'https://database.windows.net/.default',
  arm: 'https://management.azure.com/.default',
  cognitive: 'https://cognitiveservices.azure.com/.default',
  graph: 'https://graph.microsoft.com/.default',
};

const cache = new Map();          // scope -> { token, expiresOn }
let browserCred = null;
let activeMode = null;            // 'azure-cli' | 'browser'
let identity = null;              // { name, upn, oid, tenantId }

function cliCred() {
  const tenantId = getSettings().azure.tenantId || undefined;
  return new AzureCliCredential(tenantId ? { tenantId } : {});
}

function getBrowserCred() {
  if (!browserCred) {
    const tenantId = getSettings().azure.tenantId || 'organizations';
    browserCred = new InteractiveBrowserCredential({ tenantId, redirectUri: 'http://localhost' });
  }
  return browserCred;
}

export async function getToken(scope = SCOPES.fabric, { interactive = false } = {}) {
  const hit = cache.get(scope);
  if (hit && hit.expiresOn - Date.now() > 5 * 60 * 1000) return hit.token;

  const mode = getSettings().azure.authMode;
  let tok = null;
  let lastErr = null;
  if (mode !== 'browser' && activeMode !== 'browser') {
    try { tok = await cliCred().getToken(scope); activeMode = 'azure-cli'; } catch (e) { lastErr = e; }
  }
  if (!tok && (mode === 'browser' || activeMode === 'browser' || interactive)) {
    try { tok = await getBrowserCred().getToken(scope); activeMode = 'browser'; } catch (e) { lastErr = e; }
  }
  if (!tok) {
    const err = new Error('Not signed in to Azure. Use "Sign in" in the studio (or run `az login`) with the work account that has access to Microsoft Fabric.');
    err.code = 'AUTH_REQUIRED';
    err.cause = lastErr;
    throw err;
  }
  cache.set(scope, { token: tok.token, expiresOn: tok.expiresOnTimestamp });
  if (!identity && scope === SCOPES.fabric) identity = decodeIdentity(tok.token);
  return tok.token;
}

export function tokenExpiresOn(scope = SCOPES.fabric) {
  return cache.get(scope)?.expiresOn || 0;
}

export async function signIn(mode = 'browser') {
  cache.clear();
  identity = null;
  if (mode === 'azure-cli') {
    await runAzLogin();
    activeMode = null;
  } else {
    browserCred = null;
    activeMode = 'browser';
  }
  await getToken(SCOPES.fabric, { interactive: mode === 'browser' });
  return whoAmI();
}

export function signOut() {
  cache.clear();
  identity = null;
  browserCred = null;
  activeMode = null;
}

export async function whoAmI() {
  try {
    await getToken(SCOPES.fabric);
    return { signedIn: true, mode: activeMode, ...identity };
  } catch (e) {
    return { signedIn: false, mode: null, error: e.message };
  }
}

function decodeIdentity(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return {
      name: p.name || p.upn || p.unique_name || 'Signed-in user',
      upn: p.upn || p.unique_name || p.preferred_username || '',
      oid: p.oid,
      tenantId: p.tid,
      tenantDomain: (p.upn || p.unique_name || '').split('@')[1] || '',
    };
  } catch {
    return { name: 'Signed-in user', tenantId: '' };
  }
}

function runAzLogin() {
  const tenant = getSettings().azure.tenantId;
  const args = ['login'];
  if (tenant) args.push('--tenant', tenant);
  return runAz(args, { json: false }).then(() => undefined);
}
