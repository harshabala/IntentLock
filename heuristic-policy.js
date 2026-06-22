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

// ── Site taxonomy ──────────────────────────────────────────────────────

export const SITE_CATEGORIES = [
  {
    id: 'social_media',
    label: 'Social Media',
    description: 'General social networking and sharing platforms',
    defaultPolicy: 'block',
    domains: [
      'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'threads.net',
      'snapchat.com', 'pinterest.com', 'tumblr.com', 'mastodon.social', 'mastodon.online',
      'bsky.app', 'myspace.com', 'vk.com', 'weibo.com', 'wechat.com', 'renren.com',
      'mewe.com', 'parler.com', 'gab.com', 'clubhouse.com', 'mix.com',
      'band.us', 'nextdoor.com', 'taringa.net', 'diaspora.social',
    ],
  },
  {
    id: 'short_video',
    label: 'Short Video & YouTube',
    description: 'Video platforms optimized for passive entertainment consumption',
    defaultPolicy: 'block',
    domains: [
      'youtube.com', 'tiktok.com', 'douyin.com', 'kwai.com', 'triller.co',
      'likee.video', 'cheez.tv', 'snackvideo.com', 'moj.in', 'roposo.com',
    ],
    pathPatterns: ['youtube\\.com/watch', 'youtube\\.com/shorts', 'youtube\\.com/feed'],
  },
  {
    id: 'streaming',
    label: 'Video Streaming',
    description: 'Movie and TV show streaming services',
    defaultPolicy: 'block',
    domains: [
      'netflix.com', 'hulu.com', 'disneyplus.com', 'hbomax.com', 'max.com',
      'primevideo.com', 'tv.apple.com', 'peacocktv.com', 'paramountplus.com',
      'fubo.tv', 'sling.com', 'philo.com', 'crunchyroll.com', 'funimation.com',
      'mubi.com', 'britbox.com', 'acornnetwork.com', 'shudder.com',
      'discoveryplus.com', 'espnplus.com', 'plex.tv', 'tubitv.com',
      'pluto.tv', 'vudu.com', 'crackle.com', 'kanopy.com', 'mxplayer.in',
      'hotstar.com', 'sonyliv.com', 'zee5.com', 'voot.com', 'jiocinema.com',
    ],
  },
  {
    id: 'gaming',
    label: 'Gaming',
    description: 'Online games, gaming platforms, and game stores',
    defaultPolicy: 'warn',
    domains: [
      'twitch.tv', 'store.steampowered.com', 'epicgames.com', 'gog.com',
      'origin.com', 'ubisoft.com', 'blizzard.com', 'xbox.com', 'playstation.com',
      'nintendo.com', 'itch.io', 'miniclip.com', 'kongregate.com',
      'armor-games.com', 'coolmathgames.com', 'poki.com', 'y8.com',
      'friv.com', 'addictinggames.com', 'roblox.com', 'minecraft.net',
      'fortnite.com', 'leagueoflegends.com', 'dota2.com', 'pathofexile.com',
      'guildwars2.com', 'wowhead.com', 'curse.com', 'overwolf.com',
      'gamesradar.com', 'ign.com', 'gamespot.com', 'polygon.com',
    ],
  },
  {
    id: 'news',
    label: 'News',
    description: 'General news, politics, and current events',
    defaultPolicy: 'warn',
    domains: [
      'cnn.com', 'foxnews.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
      'theguardian.com', 'washingtonpost.com', 'wsj.com', 'reuters.com',
      'apnews.com', 'nbcnews.com', 'cbsnews.com', 'msnbc.com',
      'huffpost.com', 'politico.com', 'thehill.com', 'npr.org',
      'aljazeera.com', 'dw.com', 'euronews.com', 'axios.com',
      'vox.com', 'theatlantic.com', 'newyorker.com', 'slate.com',
      'salon.com', 'dailybeast.com', 'breitbart.com', 'newsweek.com',
      'time.com', 'techcrunch.com', 'theverge.com', 'wired.com',
      'arstechnica.com', 'engadget.com', 'zdnet.com', 'cnet.com',
      'gizmodo.com', 'lifehacker.com', 'mashable.com', 'buzzfeed.com',
      'vice.com', 'businessinsider.com', 'fortune.com', 'fastcompany.com',
      'inc.com', 'entrepreneur.com', 'cnbc.com', 'marketwatch.com',
      'usatoday.com', 'latimes.com', 'nypost.com', 'dailymail.co.uk',
      'independent.co.uk', 'telegraph.co.uk', 'thesun.co.uk',
    ],
  },
  {
    id: 'forums',
    label: 'Forums & Discussion',
    description: 'Community discussion boards and Q&A sites',
    defaultPolicy: 'warn',
    domains: [
      'reddit.com', 'news.ycombinator.com', 'quora.com', 'stackexchange.com',
      'stackoverflow.com', 'superuser.com', 'serverfault.com', 'askubuntu.com',
      'unix.stackexchange.com', 'math.stackexchange.com', 'physics.stackexchange.com',
      '4chan.org', 'community.atlassian.com', 'discuss.python.org',
      'forum.unity.com', 'forums.developer.apple.com', 'discourse.org',
      'lemmy.world', 'kbin.social', 'tildes.net',
    ],
  },
  {
    id: 'shopping',
    label: 'Shopping',
    description: 'E-commerce and retail sites',
    defaultPolicy: 'warn',
    domains: [
      'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com',
      'bestbuy.com', 'newegg.com', 'costco.com', 'bhphotovideo.com',
      'adorama.com', 'aliexpress.com', 'wish.com', 'temu.com',
      'shein.com', 'asos.com', 'zara.com', 'hm.com', 'uniqlo.com',
      'nordstrom.com', 'macys.com', 'kohls.com', 'gap.com',
      'wayfair.com', 'overstock.com', 'homedepot.com', 'lowes.com',
      'ikea.com', 'chewy.com', 'petco.com', 'petsmart.com',
      'rei.com', 'patagonia.com', 'nike.com', 'adidas.com', 'underarmour.com',
      'zappos.com', 'sephora.com', 'ulta.com', 'walgreens.com', 'cvs.com',
      'rakuten.com', 'groupon.com', 'woot.com', 'slickdeals.net',
    ],
  },
  {
    id: 'email',
    label: 'Email',
    description: 'Web-based email clients',
    defaultPolicy: 'allow',
    domains: [
      'mail.google.com', 'gmail.com', 'outlook.com', 'outlook.live.com',
      'mail.yahoo.com', 'protonmail.com', 'mail.proton.me', 'tutanota.com',
      'fastmail.com', 'zoho.com', 'icloud.com', 'aol.com', 'gmx.com',
      'yandex.com', 'mail.ru',
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging & Chat',
    description: 'Instant messaging and team communication tools',
    defaultPolicy: 'allow',
    domains: [
      'slack.com', 'discord.com', 'web.whatsapp.com', 'web.telegram.org',
      'signal.org', 'messenger.com', 'teams.microsoft.com',
      'meet.google.com', 'zoom.us', 'whereby.com', 'gather.town',
      'lark.com', 'mattermost.com', 'rocketchat.com', 'wire.com',
      'keybase.io', 'element.io', 'matrix.org',
    ],
  },
  {
    id: 'job_boards',
    label: 'Job Boards',
    description: 'Job listings and application platforms',
    defaultPolicy: 'allow',
    domains: [
      'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
      'careerbuilder.com', 'simplyhired.com', 'dice.com', 'greenhouse.io',
      'lever.co', 'workday.com', 'icims.com', 'taleo.net', 'jobvite.com',
      'hired.com', 'wellfound.com', 'otta.com', 'remoteok.com',
      'weworkremotely.com', 'remotive.io', 'flexjobs.com', 'angel.co',
      'builtin.com', 'techcareers.com', 'cyberseek.org',
    ],
  },
  {
    id: 'professional_network',
    label: 'Professional Network',
    description: 'LinkedIn and professional community platforms',
    defaultPolicy: 'allow',
    domains: [
      'linkedin.com', 'xing.com', 'meetup.com', 'lunchclub.com',
      'clarity.fm', 'toptal.com', 'upwork.com', 'fiverr.com',
      'freelancer.com', 'guru.com', '99designs.com', 'contra.com',
      'workco.com', 'bench.co',
    ],
  },
  {
    id: 'documentation',
    label: 'Documentation & Reference',
    description: 'Technical documentation, API references, and language specs',
    defaultPolicy: 'allow',
    domains: [
      'developer.mozilla.org', 'devdocs.io', 'docs.python.org',
      'docs.microsoft.com', 'learn.microsoft.com', 'docs.aws.amazon.com',
      'cloud.google.com', 'developer.apple.com', 'developer.android.com',
      'docs.docker.com', 'kubernetes.io', 'reactjs.org', 'vuejs.org',
      'angular.io', 'nextjs.org', 'svelte.dev', 'deno.land',
      'nodejs.org', 'npmjs.com', 'pypi.org', 'crates.io', 'pkg.go.dev',
      'rubygems.org', 'packagist.org', 'hex.pm', 'docs.rs',
      'cppreference.com', 'en.cppreference.com', 'php.net',
      'ruby-doc.org', 'javadoc.io', 'docs.spring.io',
    ],
  },
  {
    id: 'code_forge',
    label: 'Code & Version Control',
    description: 'Source code hosting, CI/CD, and collaborative development',
    defaultPolicy: 'allow',
    domains: [
      'github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org',
      'sourceforge.net', 'gitee.com', 'launchpad.net', 'sr.ht',
      'replit.com', 'glitch.com', 'codepen.io', 'jsfiddle.net',
      'codesandbox.io', 'stackblitz.com', 'gitpod.io',
      'circleci.com', 'travis-ci.org', 'jenkins.io', 'drone.io',
    ],
  },
  {
    id: 'ai_tools',
    label: 'AI Tools',
    description: 'AI assistants, code generation, and LLM platforms',
    defaultPolicy: 'allow',
    domains: [
      'chat.openai.com', 'claude.ai', 'gemini.google.com', 'bard.google.com',
      'perplexity.ai', 'you.com', 'phind.com', 'poe.com',
      'character.ai', 'replika.com', 'midjourney.com', 'stability.ai',
      'playground.ai', 'runwayml.com', 'elevenlabs.io',
      'huggingface.co', 'replicate.com', 'together.ai', 'cohere.com',
      'anthropic.com', 'openai.com', 'mistral.ai', 'groq.com',
    ],
  },
  {
    id: 'finance',
    label: 'Finance & Markets',
    description: 'Stock markets, banking, trading, and crypto',
    defaultPolicy: 'warn',
    domains: [
      'bloomberg.com', 'finance.yahoo.com', 'cnbc.com',
      'investing.com', 'seekingalpha.com', 'morningstar.com',
      'robinhood.com', 'etrade.com', 'schwab.com', 'fidelity.com',
      'vanguard.com', 'tdameritrade.com', 'webull.com', 'm1finance.com',
      'binance.com', 'coinbase.com', 'kraken.com', 'crypto.com',
      'coinmarketcap.com', 'coingecko.com', 'tradingview.com',
      'bankrate.com', 'nerdwallet.com', 'mint.com', 'creditkarma.com',
      'experian.com', 'equifax.com', 'transunion.com',
      'ally.com', 'sofi.com', 'chime.com', 'capitalone.com',
    ],
  },
  {
    id: 'sports',
    label: 'Sports',
    description: 'Sports news, scores, fantasy sports, and analysis',
    defaultPolicy: 'warn',
    domains: [
      'espn.com', 'nfl.com', 'nba.com', 'mlb.com', 'nhl.com',
      'mls.com', 'fifa.com', 'uefa.com', 'si.com', 'bleacherreport.com',
      'cbssports.com', 'nbcsports.com', 'foxsports.com', 'theathletic.com',
      'sofascore.com', 'flashscore.com', 'soccerway.com',
      'draftkings.com', 'fanduel.com', 'yahoo.com/sports',
    ],
  },
  {
    id: 'gambling',
    label: 'Gambling',
    description: 'Online casinos, sports betting, and poker sites',
    defaultPolicy: 'block',
    domains: [
      'betway.com', 'bet365.com', 'ladbrokes.com', 'williamhill.com',
      'pokerstars.com', '888casino.com', 'bwin.com', 'unibet.com',
      'paddypower.com', 'bodog.com', 'bovada.lv', 'mybookie.ag',
      'betmgm.com', 'caesarssportsbook.com', 'pointsbet.com',
      'barstoolsportsbook.com', 'wynnbet.com',
    ],
  },
  {
    id: 'memes',
    label: 'Memes & Humor',
    description: 'Meme aggregators and humor content sites',
    defaultPolicy: 'block',
    domains: [
      '9gag.com', 'ifunny.co', 'imgur.com', 'memedroid.com',
      'cheezburger.com', 'knowyourmeme.com', 'funnyjunk.com',
      'lolcat.com', 'ebaumsworld.com',
    ],
  },
  {
    id: 'productivity',
    label: 'Productivity Tools',
    description: 'Task management, notes, documents, and work tools',
    defaultPolicy: 'allow',
    domains: [
      'notion.so', 'trello.com', 'asana.com', 'monday.com', 'clickup.com',
      'todoist.com', 'ticktick.com', 'evernote.com', 'onenote.com',
      'obsidian.md', 'roamresearch.com', 'logseq.com', 'coda.io',
      'airtable.com', 'docs.google.com', 'sheets.google.com',
      'slides.google.com', 'drive.google.com', 'dropbox.com',
      'box.com', 'onedrive.live.com', 'calendar.google.com',
      'calendly.com', 'loom.com', 'descript.com', 'grammarly.com',
      'hemingwayapp.com', 'zotero.org', 'mendeley.com',
      'miro.com', 'figjam.com', 'figma.com', 'canva.com',
      'lucidchart.com', 'whimsical.com', 'linear.app',
      'jira.atlassian.com', 'confluence.atlassian.com',
      'basecamp.com', 'wrike.com', 'teamwork.com', 'smartsheet.com',
      'craft.do', 'bear.app', 'ulysses.app', 'ia.net',
    ],
  },
  {
    id: 'health',
    label: 'Health & Medical',
    description: 'Health information, medical resources, and wellness apps',
    defaultPolicy: 'allow',
    domains: [
      'webmd.com', 'mayoclinic.org', 'healthline.com', 'medlineplus.gov',
      'nih.gov', 'cdc.gov', 'who.int', 'nhs.uk', 'drugs.com',
      'rxlist.com', 'medscape.com', 'pubmed.ncbi.nlm.nih.gov',
      'myfitnesspal.com', 'loseit.com', 'cronometer.com',
      'calm.com', 'headspace.com', 'betterhelp.com', 'talkspace.com',
      'zocdoc.com', 'goodrx.com', 'cvs.com/minuteclinic',
    ],
  },
  {
    id: 'travel',
    label: 'Travel & Booking',
    description: 'Flight and hotel booking, travel planning and research',
    defaultPolicy: 'allow',
    domains: [
      'booking.com', 'airbnb.com', 'hotels.com', 'expedia.com',
      'kayak.com', 'priceline.com', 'orbitz.com', 'tripadvisor.com',
      'skyscanner.com', 'momondo.com', 'google.com/travel',
      'united.com', 'delta.com', 'aa.com', 'southwest.com',
      'vrbo.com', 'hipcamp.com', 'hostelworld.com', 'agoda.com',
    ],
  },
];

export const DOMAIN_TO_CATEGORY = new Map();
for (const cat of SITE_CATEGORIES) {
  for (const domain of cat.domains) {
    const normalized = String(domain).replace(/^www\./, '').toLowerCase();
    if (normalized && !DOMAIN_TO_CATEGORY.has(normalized)) {
      DOMAIN_TO_CATEGORY.set(normalized, cat.id);
    }
  }
}

export function getSiteCategory(hostname) {
  if (!hostname) return null;
  const normalized = String(hostname).replace(/^www\./, '').toLowerCase();
  const categoryId = DOMAIN_TO_CATEGORY.get(normalized);
  if (!categoryId) return null;
  const cat = SITE_CATEGORIES.find(c => c.id === categoryId);
  return cat ? { categoryId, label: cat.label } : null;
}

// ── Policy schema + builders ──────────────────────────────────────────

export const STRICTNESS_PRESETS = {
  strict: {
    social_media:        'block',
    short_video:         'block',
    streaming:           'block',
    gaming:              'block',
    forums:              'block',
    memes:               'block',
    gambling:            'block',
    news:                'warn',
    shopping:            'warn',
    sports:              'warn',
    finance:             'warn',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
  balanced: {
    social_media:        'block',
    short_video:         'block',
    streaming:           'block',
    gaming:              'warn',
    forums:              'warn',
    memes:               'block',
    gambling:            'block',
    news:                'warn',
    shopping:            'warn',
    sports:              'warn',
    finance:             'allow',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
  relaxed: {
    social_media:        'warn',
    short_video:         'block',
    streaming:           'warn',
    gaming:              'warn',
    forums:              'allow',
    memes:               'warn',
    gambling:            'warn',
    news:                'allow',
    shopping:            'allow',
    sports:              'allow',
    finance:             'allow',
    email:               'allow',
    messaging:           'allow',
    job_boards:          'allow',
    professional_network:'allow',
    documentation:       'allow',
    code_forge:          'allow',
    ai_tools:            'allow',
    productivity:        'allow',
    health:              'allow',
    travel:              'allow',
  },
};

export function buildDefaultPolicy(intentCategoryId, strictness) {
  const intentCat = INTENT_CATEGORIES.find(c => c.id === intentCategoryId);
  const resolvedStrictness = strictness || intentCat?.defaultStrictness || 'balanced';
  const preset = STRICTNESS_PRESETS[resolvedStrictness] || STRICTNESS_PRESETS.balanced;
  return {
    version: 1,
    intentCategoryId: intentCategoryId || null,
    strictness: resolvedStrictness,
    categoryPolicies: { ...preset },
    customBlockDomains: [],
    customAllowDomains: [],
    setupCompleted: false,
  };
}

export function mergePolicyWithIntent(intentText, existingPolicy = null) {
  const classification = classifyIntentCategory(intentText);
  const base = existingPolicy ? { ...existingPolicy } : buildDefaultPolicy(classification.categoryId, null);
  base.intentCategoryId = classification.categoryId;
  return base;
}

function normalizeHostname(h) {
  return String(h || '').replace(/^www\./, '').toLowerCase();
}

export function resolveDomainPolicy(hostname, policy) {
  try {
    if (!policy || typeof policy !== 'object') return 'neutral';
    const normalized = normalizeHostname(hostname);
    if (!normalized) return 'neutral';

    const allowList = Array.isArray(policy.customAllowDomains) ? policy.customAllowDomains : [];
    const blockList = Array.isArray(policy.customBlockDomains) ? policy.customBlockDomains : [];

    if (allowList.some(d => normalizeHostname(d) === normalized)) return 'allow';
    if (blockList.some(d => normalizeHostname(d) === normalized)) return 'block';

    const lookup = getSiteCategory(normalized);
    if (!lookup) return 'neutral';
    return policy.categoryPolicies?.[lookup.categoryId] || 'neutral';
  } catch {
    return 'neutral';
  }
}

export function getEffectiveBlockList(policy) {
  if (!policy || typeof policy !== 'object') return [];
  const blocked = new Set();
  const allowSet = new Set(
    (Array.isArray(policy.customAllowDomains) ? policy.customAllowDomains : []).map(normalizeHostname)
  );

  for (const cat of SITE_CATEGORIES) {
    if (policy.categoryPolicies?.[cat.id] === 'block') {
      for (const domain of cat.domains) {
        const n = normalizeHostname(domain);
        if (!allowSet.has(n)) blocked.add(n);
      }
    }
  }

  for (const d of (Array.isArray(policy.customBlockDomains) ? policy.customBlockDomains : [])) {
    const n = normalizeHostname(d);
    if (!allowSet.has(n)) blocked.add(n);
  }

  return [...blocked];
}
