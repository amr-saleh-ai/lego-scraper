const USER_AGENT = 'web:lego-scraper:v2.0 (contact: admin@lego-deals.app)';

const DEFAULT_SUBREDDITS = [
  'legodeals',
  'lego',
  'legomarket',
  'LegoDeals',
];

const SET_NUMBER_RE = /\b(\d{4,5}(?:-\d+)?)\b/;
const US_PRICE_RE = /\$(\d+(?:\.\d{1,2})?)/;
const UK_PRICE_RE = /£(\d+(?:\.\d{1,2})?)/;
const EURO_PRICE_RE = /€(\d+(?:\.\d{1,2})?)/;
const PERCENT_OFF_RE = /(\d{1,2})\s*%\s*(?:off|discount)/i;

const RETAILER_PATTERNS = [
  { pattern: /amazon/i, name: 'Amazon' },
  { pattern: /walmart/i, name: 'Walmart' },
  { pattern: /target/i, name: 'Target' },
  { pattern: /woot/i, name: 'Woot' },
  { pattern: /lego\.com|lego store/i, name: 'LEGO.com' },
  { pattern: /best buy/i, name: 'Best Buy' },
  { pattern: /kohl'?s/i, name: "Kohl's" },
  { pattern: /costco/i, name: 'Costco' },
  { pattern: /b&n|barnes/i, name: 'Barnes & Noble' },
  { pattern: /zavvi/i, name: 'Zavvi' },
  { pattern: /smyths/i, name: 'Smyths' },
  { pattern: /argos/i, name: 'Argos' },
];

function detectRetailer(text) {
  for (const { pattern, name } of RETAILER_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return '';
}

function cleanTitle(title) {
  return title
    .replace(/^\[[^\]]+\]\s*/g, '')
    .replace(/\s*[-–—|@]\s*.*$/, '')
    .replace(/\$\d+(?:\.\d{1,2})?/g, '')
    .replace(/£\d+(?:\.\d{1,2})?/g, '')
    .replace(/€\d+(?:\.\d{1,2})?/g, '')
    .replace(/\(\d{1,2}%\s*off\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(text) {
  if (!text) return null;

  let match = text.match(US_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'US' };

  match = text.match(UK_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'UK' };

  match = text.match(EURO_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'DE' };

  return null;
}

function parsePost(post) {
  const data = post.data;
  const title = data.title || '';
  const body = data.selftext || '';
  const combined = `${title}\n${body}`;

  const setMatch = combined.match(SET_NUMBER_RE);
  if (!setMatch) return null;

  const priceInfo = parsePrice(title) || parsePrice(body);
  if (!priceInfo || priceInfo.price <= 0) return null;

  const setNumber = setMatch[1];
  const retailer = detectRetailer(combined) || detectRetailer(data.link_flair_text || '');
  const percentOff = combined.match(PERCENT_OFF_RE);
  const subreddit = data.subreddit || '';
  const name = cleanTitle(title) || title;

  const excerptParts = [
    retailer,
    subreddit ? `r/${subreddit}` : '',
    percentOff ? `${percentOff[1]}% off` : '',
  ].filter(Boolean);

  return {
    set_number: setNumber,
    name: name.length > 3 ? name : `LEGO Set ${setNumber}`,
    current_price: priceInfo.price,
    original_price: 0,
    source_name: 'Reddit',
    theme: '',
    subtheme: '',
    image_url: data.thumbnail?.startsWith('http') ? data.thumbnail : '',
    currency: priceInfo.currency,
    year: 0,
    pieces: 0,
    availability: 'Deal',
    brickset_url: '',
    deal_url: data.url?.startsWith('http') ? data.url : `https://reddit.com${data.permalink}`,
    reddit_url: `https://reddit.com${data.permalink}`,
    retailer,
    excerpt: excerptParts.join(' · '),
    from_reddit: true,
  };
}

function parseSubreddits(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/^r\//i, ''))
    .filter(Boolean);

  return list.length ? list : DEFAULT_SUBREDDITS;
}

async function fetchSubredditListing(subreddit, sort, limit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.json?limit=${limit}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Reddit HTTP ${response.status} for r/${subreddit}/${sort}`);
  }

  const body = await response.json();
  return body?.data?.children || [];
}

async function scrapeReddit(settings) {
  const diagnostics = {
    enabled: settings.reddit_enabled !== 'false',
    subreddits: [],
    postsSeen: 0,
    parsed: 0,
    skippedNoSetOrPrice: 0,
  };

  if (!diagnostics.enabled) {
    return {
      sets: [],
      errors: ['Reddit scraping is disabled. Enable it in Admin settings or set REDDIT_ENABLED=true.'],
      fetched: 0,
      diagnostics,
    };
  }

  const subreddits = parseSubreddits(settings.reddit_subreddits);
  diagnostics.subreddits = subreddits;

  const limit = Math.min(100, Math.max(10, Number(settings.reddit_post_limit) || 50));
  const errors = [];
  const seen = new Set();
  const sets = [];

  for (const subreddit of subreddits) {
    for (const sort of ['new', 'hot']) {
      try {
        const posts = await fetchSubredditListing(subreddit, sort, limit);
        diagnostics.postsSeen += posts.length;

        for (const post of posts) {
          const parsed = parsePost(post);
          if (!parsed) {
            diagnostics.skippedNoSetOrPrice++;
            continue;
          }

          diagnostics.parsed++;

          const key = `${parsed.set_number}:${parsed.current_price}:${parsed.deal_url}`;
          if (seen.has(key)) continue;
          seen.add(key);

          sets.push(parsed);
        }
      } catch (err) {
        errors.push(err.message);
      }
    }
  }

  if (!sets.length && !errors.length) {
    errors.push(
      `Checked r/${subreddits.join(', r/')} — saw ${diagnostics.postsSeen} posts but none had both a set number and price.`
    );
  }

  return { sets, errors, fetched: sets.length, diagnostics };
}

module.exports = { scrapeReddit, parsePost, DEFAULT_SUBREDDITS };
