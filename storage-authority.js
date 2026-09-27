import { assertStorageCommit, runStorageMutation, storageCall } from './storage-queue.js';
import { buildDefaultPolicy } from './heuristic-policy.js';
import { validateProviderConfig } from './providers.js';
import { ERROR_LOG_RETENTION_MS, MAX_ERROR_LOG_ENTRIES, pruneByRetention, redactSecrets } from './privacy-utils.js';

export const SESSION_UNAVAILABLE = 'Session storage is unavailable, so an AI key cannot be saved. The local lock still works.';

export function isExtensionPage(sender) {
  if (sender?.id && sender.id !== chrome.runtime.id) return false;
  const base = chrome.runtime.getURL('');
  const url = sender?.url || '';
  return ['newtab.html', 'options.html', 'diagnostics.html', 'history.html', 'analytics.html', 'popup.html', 'intervention.html']
    .some(page => url === base + page || url.startsWith(base + page + '?') || url.startsWith(base + page + '#'));
}

async function write(area, method, value) {
  assertStorageCommit();
  return storageCall(area, method, value);
}

function fields(payload, allowed) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).some(key => !allowed.includes(key)) || JSON.stringify(payload).length > 32_768) {
    throw new Error('Invalid storage mutation fields.');
  }
}

function policyFields(policy) {
  fields(policy, ['categoryPolicies', 'customBlockDomains', 'customAllowDomains']);
  if (!policy.categoryPolicies || typeof policy.categoryPolicies !== 'object' ||
      Object.values(policy.categoryPolicies).some(value => !['allow', 'block', 'warn'].includes(value)) ||
      ['customBlockDomains', 'customAllowDomains'].some(key => !Array.isArray(policy[key]) ||
        policy[key].length > 200 || policy[key].some(domain => typeof domain !== 'string' || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)))) {
    throw new Error('Invalid site policy.');
  }
}

export function applyStorageCommand(command, payload, epoch) {
  return runStorageMutation(async () => {
    switch (command) {
      case 'saveProvider': {
        fields(payload, ['config', 'key']);
        fields(payload.config, ['providerId', 'model', 'baseUrl', 'customLabel', 'apiStyle', 'authType']);
        const error = validateProviderConfig(payload.config || {});
        if (error || (payload.key !== undefined && (typeof payload.key !== 'string' || payload.key.length > 8192))) {
          throw new Error(error || 'Invalid API key.');
        }
        // Keys live only in trusted-context session memory. Local storage is
        // readable by content scripts, so it is never a credential fallback.
        if (payload.key && !chrome.storage.session) throw new Error(SESSION_UNAVAILABLE);
        await write('local', 'set', { llmProviderConfig: payload.config });
        if (payload.key) await write('session', 'set', { llmApiKey: payload.key });
        return;
      }
      case 'clearKey':
        fields(payload, []);
        await removeAllKeyAliases();
        return;
      case 'saveSites': {
        policyFields(payload);
        const data = await storageCall('local', 'get', ['heuristicPolicy']);
        const current = data.heuristicPolicy?.version === 1 ? data.heuristicPolicy : buildDefaultPolicy('deep_work', 'balanced');
        await write('local', 'set', { heuristicPolicy: { ...current, ...payload, setupCompleted: true } });
        return;
      }
      case 'onboarding': {
        fields(payload, ['category', 'strictness']);
        if (typeof payload.category !== 'string' || typeof payload.strictness !== 'string') throw new Error('Invalid onboarding policy.');
        const policy = buildDefaultPolicy(payload.category, payload.strictness);
        policy.setupCompleted = true;
        await write('local', 'set', { heuristicPolicy: policy, hasSeenOnboarding: true });
        return;
      }
      case 'tracking':
        fields(payload, ['enabled']);
        if (typeof payload.enabled !== 'boolean') throw new Error('Invalid tracking preference.');
        await write('local', 'set', { trackingEnabled: payload.enabled });
        return;
      case 'theme':
        fields(payload, ['theme']);
        if (!['auto', 'dark', 'light'].includes(payload.theme)) throw new Error('Invalid theme.');
        await write('local', 'set', payload);
        return;
      case 'appendError':
      case 'readErrors':
      case 'clearErrors': {
        fields(payload, command === 'appendError' ? ['entry'] : []);
        if (command === 'appendError' && (typeof payload.entry?.message !== 'string' || !Number.isFinite(payload.entry?.timestamp))) throw new Error('Invalid diagnostic entry.');
        const data = await storageCall('local', 'get', ['errorLog']);
        const log = command === 'clearErrors' ? [] : pruneByRetention(Array.isArray(data.errorLog) ? data.errorLog : [], {
          retentionMs: ERROR_LOG_RETENTION_MS, maxEntries: MAX_ERROR_LOG_ENTRIES, newestFirst: true,
        }).map(entry => redactSecrets(entry));
        if (command === 'appendError') log.unshift(redactSecrets(payload.entry));
        log.length = Math.min(log.length, MAX_ERROR_LOG_ENTRIES);
        await write('local', 'set', { errorLog: log });
        return command === 'appendError' ? log[0] : log;
      }
      default: throw new Error('Unknown storage mutation.');
    }
  }, epoch);
}

async function removeAllKeyAliases() {
  if (chrome.storage.session) await write('session', 'remove', ['llmApiKey', 'openaiApiKey']);
  await write('local', 'remove', ['llmApiKey', 'openaiApiKey']);
}

export function migrateKeys(epoch) {
  return runStorageMutation(async () => {
    const local = await storageCall('local', 'get', ['llmApiKey', 'openaiApiKey']);
    if (!chrome.storage.session) {
      // Without trusted session memory a legacy key cannot be kept safely;
      // keyed AI stays off and offline enforcement continues.
      if (local.llmApiKey !== undefined || local.openaiApiKey !== undefined) {
        await write('local', 'remove', ['llmApiKey', 'openaiApiKey']);
      }
      return;
    }
    const session = await storageCall('session', 'get', ['llmApiKey', 'openaiApiKey']);
    const key = session.llmApiKey || session.openaiApiKey || local.llmApiKey || local.openaiApiKey;
    if (key && !session.llmApiKey) {
      await write('session', 'set', { llmApiKey: key });
      // Remove sources only after the canonical copy is confirmed readable.
      const verified = await storageCall('session', 'get', ['llmApiKey']);
      if (verified.llmApiKey !== key) throw new Error('API key migration could not be verified.');
    }
    await write('session', 'remove', ['openaiApiKey']);
    await write('local', 'remove', ['llmApiKey', 'openaiApiKey']);
  }, epoch);
}
