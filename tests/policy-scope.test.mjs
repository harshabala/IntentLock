import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultPolicy, evaluatePolicyDrift, getSiteCategory, resolveDomainPolicy } from '../heuristic-policy.js';

const base = buildDefaultPolicy('deep_work', 'balanced');
const withRules = (block, allow) => ({ ...base, customBlockDomains: block, customAllowDomains: allow });

test('mobile YouTube follows the base YouTube rule', () => {
  assert.equal(getSiteCategory('m.youtube.com')?.categoryId, 'short_video');
  assert.equal(resolveDomainPolicy('m.youtube.com', base), resolveDomainPolicy('youtube.com', base));
  const result = evaluatePolicyDrift({ intent: 'draft quarterly report', policy: base, events: [],
    url: 'https://m.youtube.com/watch?v=synthetic' });
  assert.equal(result.shouldIntervene, true);
});

test('lookalike suffix hosts do not inherit a listed site', () => {
  assert.equal(getSiteCategory('youtube.com.evil.test'), null);
  assert.equal(getSiteCategory('m.youtube.com.evil.test'), null);
  assert.equal(resolveDomainPolicy('youtube.com.evil.test', base), 'neutral');
});

test('non-mobile subdomains do not inherit a parent category', () => {
  assert.equal(getSiteCategory('docs.aws.amazon.com')?.categoryId, 'documentation');
  assert.equal(getSiteCategory('console.aws.amazon.com'), null);
});

test('custom rules cover subdomains at label boundaries only', () => {
  const policy = withRules(['synthetic-forum.example'], []);
  assert.equal(resolveDomainPolicy('synthetic-forum.example', policy), 'block');
  assert.equal(resolveDomainPolicy('old.synthetic-forum.example', policy), 'block');
  assert.equal(resolveDomainPolicy('notsynthetic-forum.example', policy), 'neutral');
  assert.equal(resolveDomainPolicy('synthetic-forum.example.evil.test', policy), 'neutral');
});

test('most specific custom rule wins and exact-scope allow wins ties', () => {
  const nested = withRules(['synthetic-forum.example'], ['work.synthetic-forum.example']);
  assert.equal(resolveDomainPolicy('work.synthetic-forum.example', nested), 'allow');
  assert.equal(resolveDomainPolicy('team.work.synthetic-forum.example', nested), 'allow');
  assert.equal(resolveDomainPolicy('play.synthetic-forum.example', nested), 'block');
  const inverse = withRules(['play.synthetic-forum.example'], ['synthetic-forum.example']);
  assert.equal(resolveDomainPolicy('play.synthetic-forum.example', inverse), 'block');
  assert.equal(resolveDomainPolicy('synthetic-forum.example', inverse), 'allow');
  const tie = withRules(['synthetic-forum.example'], ['synthetic-forum.example']);
  assert.equal(resolveDomainPolicy('synthetic-forum.example', tie), 'allow');
});

test('custom subdomain block beats keyword alignment and custom allow suppresses category block', () => {
  const policy = withRules(['synthetic-forum.example'], ['m.youtube.com']);
  const blocked = evaluatePolicyDrift({ intent: 'quarterly report', policy, events: [],
    url: 'https://old.synthetic-forum.example/quarterly-report' });
  assert.equal(blocked.shouldIntervene, true);
  assert.equal(blocked.reason, 'blocked_category');
  const allowed = evaluatePolicyDrift({ intent: 'quarterly report', policy, events: [],
    url: 'https://m.youtube.com/watch?v=synthetic' });
  assert.equal(allowed.shouldIntervene, false);
  assert.equal(allowed.reason, 'explicit_allow');
});
