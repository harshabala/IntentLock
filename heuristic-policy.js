// heuristic-policy.js — IntentLock heuristic & site policy engine
// Storage schema: chrome.storage.local key `heuristicPolicy`, version 1

export const DRIFT_CONFIDENCE_THRESHOLD = 0.7;
export const DWELL_DISTRACTION_MS = 60_000;
export const DWELL_UNALIGNED_MS = 120_000;

// ── Intent taxonomy ────────────────────────────────────────────────────

export const INTENT_CATEGORIES = [
  {
    id: 'job_search',
    label: 'Job Search',
    description: 'Applying for jobs, reviewing offers, interview prep',
    keywords: ['job', 'jobs', 'resume', 'cv', 'apply', 'application', 'interview', 'career',
      'hiring', 'salary', 'recruiter', 'linkedin', 'glassdoor', 'offer', 'employment',
      'position', 'role', 'cover', 'letter', 'portfolio', 'openings'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'deep_work',
    label: 'Deep Work',
    description: 'Focused uninterrupted work on a specific deliverable',
    keywords: ['deep', 'focus', 'concentrate', 'report', 'proposal', 'deliverable', 'deadline',
      'quarterly', 'annual', 'analysis', 'presentation', 'deck', 'spreadsheet', 'document',
      'review', 'audit', 'plan', 'strategy'],
    defaultStrictness: 'strict',
  },
  {
    id: 'coding',
    label: 'Coding',
    description: 'Writing, debugging, or reviewing code',
    keywords: ['code', 'coding', 'programming', 'debug', 'feature', 'bug', 'fix', 'refactor',
      'deploy', 'build', 'test', 'api', 'function', 'component', 'module', 'react', 'python',
      'javascript', 'typescript', 'extension', 'backend', 'frontend', 'script', 'class',
      'database', 'query', 'endpoint', 'pull', 'request', 'merge', 'commit'],
    defaultStrictness: 'strict',
  },
  {
    id: 'learning',
    label: 'Learning',
    description: 'Studying a topic, taking a course, reading technical material',
    keywords: ['learn', 'study', 'course', 'tutorial', 'understand', 'lecture', 'lesson',
      'chapter', 'book', 'documentation', 'algorithm', 'concept', 'machine', 'data', 'science',
      'math', 'physics', 'history', 'language', 'certificate', 'exam', 'practice'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'writing',
    label: 'Writing',
    description: 'Writing a document, article, essay, or creative piece',
    keywords: ['write', 'draft', 'drafting', 'article', 'blog', 'essay', 'post', 'content',
      'copy', 'script', 'story', 'novel', 'chapter', 'edit', 'revise', 'proofread', 'outline',
      'thesis', 'email', 'newsletter', 'caption'],
    defaultStrictness: 'strict',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Gathering information on a specific topic',
    keywords: ['research', 'investigate', 'find', 'information', 'facts', 'sources', 'references',
      'compare', 'survey', 'literature', 'background', 'context', 'data', 'statistics',
      'market', 'competitors', 'pricing'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'admin',
    label: 'Admin & Ops',
    description: 'Email, scheduling, invoicing, and operational tasks',
    keywords: ['email', 'calendar', 'schedule', 'invoice', 'billing', 'expense', 'meeting',
      'agenda', 'slack', 'admin', 'operational', 'payroll', 'contract', 'sign', 'approval',
      'onboard', 'offboard', 'ticket', 'helpdesk'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'creative',
    label: 'Creative Work',
    description: 'Design, illustration, video editing, or other creative output',
    keywords: ['design', 'illustration', 'graphic', 'creative', 'art', 'video', 'edit', 'photo',
      'brand', 'logo', 'ui', 'ux', 'figma', 'sketch', 'canva', 'animation', 'render',
      'color', 'typography', 'layout', 'wireframe', 'prototype'],
    defaultStrictness: 'balanced',
  },
  {
    id: 'health',
    label: 'Health & Wellness',
    description: 'Medical research, fitness, nutrition, or mental health tasks',
    keywords: ['health', 'fitness', 'workout', 'diet', 'nutrition', 'medical', 'doctor',
      'symptom', 'exercise', 'wellness', 'mental', 'therapy', 'medication', 'appointment',
      'insurance', 'prescription', 'condition'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'shopping',
    label: 'Shopping',
    description: 'Purchasing specific items or comparing products',
    keywords: ['buy', 'purchase', 'shop', 'order', 'product', 'price', 'compare', 'amazon',
      'ebay', 'gift', 'checkout', 'cart', 'shipping', 'deal', 'discount', 'coupon'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'communication',
    label: 'Communication',
    description: 'Messaging, email catch-up, or coordinating with others',
    keywords: ['message', 'chat', 'email', 'communicate', 'reply', 'respond', 'send',
      'coordinate', 'team', 'colleague', 'client', 'follow', 'meeting', 'standup',
      'update', 'sync', 'discuss'],
    defaultStrictness: 'relaxed',
  },
  {
    id: 'entertainment_allowed',
    label: 'Entertainment (Allowed)',
    description: 'Intentional relaxation — browsing is the goal',
    keywords: ['watch', 'relax', 'fun', 'entertain', 'movie', 'show', 'game', 'gaming',
      'browse', 'scroll', 'chill', 'leisure', 'break', 'hobby', 'youtube', 'netflix',
      'series', 'stream', 'anime'],
    defaultStrictness: 'relaxed',
  },
];

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'from', 'have', 'into', 'latest',
  'make', 'need', 'page', 'some', 'task', 'that', 'this', 'with', 'your',
  'going', 'want', 'just', 'doing', 'today', 'been', 'will', 'should',
  'could', 'would', 'when', 'what', 'which', 'where', 'very',
]);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

export function classifyIntentCategory(intentText) {
  const tokens = tokenize(intentText).filter(w => w.length > 2 && !STOP_WORDS.has(w));
  if (tokens.length === 0) {
    return { categoryId: null, confidence: 0, matchedKeywords: [] };
  }

  let bestCategory = null;
  let bestScore = 0;
  let bestMatched = [];

  for (const cat of INTENT_CATEGORIES) {
    const keywordSet = new Set(cat.keywords);
    const matched = tokens.filter(t =>
      keywordSet.has(t) || cat.keywords.some(k => t.length > 4 && (k.startsWith(t) || t.startsWith(k)))
    );
    const score = matched.length / Math.max(tokens.length, 1);
    if (score > bestScore) {
      bestScore = score;
      bestCategory = cat.id;
      bestMatched = matched;
    }
  }

  return {
    categoryId: bestCategory,
    confidence: Math.min(bestScore, 1),
    matchedKeywords: [...new Set(bestMatched)],
  };
}
