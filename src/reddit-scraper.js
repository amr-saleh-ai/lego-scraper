const USER_AGENT = 'lego-scraper/2.0 (by amr-saleh-ai)';

const SET_NUMBER_RE = /\b(\d{4,5}(?:-\d+)?)\b/;
const US_PRICE_RE = /\$(\d+(?:\.\d{1,2})?)/;
const UK_PRICE_RE = /£(\d+(?:\.\d{1,2})?)/;
const EURO_PRICE_RE = /€(\d+(?:\.\d{1,2})?)/;
const PERCENT_OFF_RE = /(\d{1,2})\s*%\s*(?:off|discount)/i;

const RETAILER_PATTERNS = [
  { pattern: /amazon/i, name: 'Amazon' },
  { pattern: /walmart/i, name: 'Walmart' },
  { pattern: /target/i, name: 'Target' },
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

function parsePrice(title) {
  let match = title.match(US_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'US' };

  match = title.match(UK_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'UK' };

  match = title.match(EURO_PRICE_RE);
  if (match) return { price: parseFloat(match[1]), currency: 'DE' };

  return null;
}

function parsePost(post) {
  const data = post.data;
  const title = data.title || '';
  const setMatch = title.match(SET_NUMBER_RE);

  if (!setMatch) return null;

  const priceInfo = parsePrice(title);
  if (!priceInfo || priceInfo.price <= 0) return null;

  const setNumber = setMatch[1];
  const retailer = detectRetailer(title) || detectRetailer(data.link_flair_text || '');
  const percentOff = title.match(PERCENT_OFF_RE);
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

async function fetchSubreddit(subreddit, limit) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/new.json?limit=${limit}`;

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Reddit returned HTTP ${response.status} for r/${subreddit}`);
  }

  const body = await response.json();
  return body?.data?.children || [];
}

async function scrapeReddit(settings) {
  const enabled = settings.reddit_enabled !== 'false';
  if (!enabled) {
    return { sets: [], errors: [], fetched: 0 };
  }

  const subreddits = String(settings.reddit_subreddits || 'legodeals,lego')
    .split(',')
    .map((s) => s.trim().replace(/^r\//i, ''))
    .filter(Boolean);

  const limit = Math.min(100, Math.max(10, Number(settings.reddit_post_limit) || 50));
  const errors = [];
  const seen = new Set();
  const sets = [];

  for (const subreddit of subreddits) {
    try {
      const posts = await fetchSubreddit(subreddit, limit);

      for (const post of posts) {
        const parsed = parsePost(post);
        if (!parsed) continue;

        const key = `${parsed.set_number}:${parsed.current_price}:${parsed.deal_url}`;
        if (seen.has(key)) continue;
        seen.add(key);

        sets.push(parsed);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  return { sets, errors, fetched: sets.length };
}

module.exports = { scrapeReddit, parsePost };
