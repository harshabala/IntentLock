export const DRIFT_CONFIDENCE_THRESHOLD = 0.7;

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'from', 'have', 'into', 'latest',
  'learn', 'look', 'make', 'need', 'page', 'read', 'some', 'task',
  'that', 'this', 'with', 'work', 'write', 'your'
]);

function words(value) {
  return String(value || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g) || [];
}

function intentTerms(intent) {
  return [...new Set(words(intent).filter(word => word.length > 3 && !STOP_WORDS.has(word)))];
}

function parseUrl(url) {
  try {
    const parsed = new URL(url);
    return {
      hostname: parsed.hostname.replace(/^www\./, '').toLowerCase(),
      text: `${parsed.hostname} ${parsed.pathname} ${parsed.search}`.toLowerCase()
    };
  } catch {
    return null;
  }
}

function isAlignedWithIntent(url, terms) {
  const parsed = parseUrl(url);
  if (!parsed || terms.length === 0) return false;
  return terms.some(term => parsed.text.includes(term));
}

function isConfiguredDistraction(hostname, distractionSites) {
  return distractionSites.some(site => {
    const normalized = String(site || '').replace(/^www\./, '').toLowerCase();
    return normalized && (hostname === normalized || hostname.endsWith(`.${normalized}`));
  });
}

function evaluateHeuristicDrift({ intent, url, events = [], distractionSites = [], now = Date.now() }) {
  const parsed = parseUrl(url);
  if (!parsed) {
    return { shouldIntervene: false, score: 0, reason: 'invalid_url' };
  }

  const terms = intentTerms(intent);
  const currentAligned = isAlignedWithIntent(url, terms);

  if (isConfiguredDistraction(parsed.hostname, distractionSites) && !currentAligned) {
    return { shouldIntervene: true, score: 0.9, reason: 'known_distraction' };
  }

  if (terms.length === 0) {
    return { shouldIntervene: false, score: 0, reason: 'empty_terms' };
  }

  const recentEvents = events.filter(event => now - event.timestamp <= 2 * 60 * 1000);
  const unrelatedEvents = recentEvents.filter(event => event.url && !isAlignedWithIntent(event.url, terms));
  const tabSwitches = recentEvents.filter(event => event.actionType === 'TAB_SWITCH').length;
  const sameDomainLoads = recentEvents.filter(event => {
    const eventUrl = parseUrl(event.url);
    return eventUrl && eventUrl.hostname === parsed.hostname;
  }).length;

  let score = currentAligned ? 0 : 0.25;
  if (unrelatedEvents.length >= 3) score += 0.35;
  if (tabSwitches >= 4) score += 0.25;
  if (!currentAligned && sameDomainLoads >= 2) score += 0.2;

  let reason = 'low_confidence';
  if (score >= DRIFT_CONFIDENCE_THRESHOLD) {
    reason = tabSwitches >= 4 ? 'rapid_context_switching' : 'repeated_unrelated_activity';
  }

  return {
    shouldIntervene: score >= DRIFT_CONFIDENCE_THRESHOLD,
    score: Math.min(score, 1),
    reason
  };
}

export { evaluateHeuristicDrift, intentTerms };
