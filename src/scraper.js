const {
  getSettings,
  setLastRun,
  upsertSet,
} = require('./db');
const { scrapeReddit } = require('./reddit-scraper');

const CURRENCY_SYMBOLS = { US: '$', UK: '£', CA: 'CA$', DE: '€' };

function formatPrice(amount, currency = 'US') {
  if (!amount || amount <= 0) return 'N/A';
  const symbol = CURRENCY_SYMBOLS[currency] || '$';
  return `${symbol}${Number(amount).toFixed(2)}`;
}

function emptyStats() {
  return {
    fetched: 0,
    created: 0,
    updated: 0,
    deals: 0,
    skipped: 0,
    errors: 0,
    brickset: 0,
    reddit: 0,
  };
}

async function fetchPage(settings, page) {
  const params = new URLSearchParams({
    apiKey: settings.api_key,
    userHash: settings.user_hash || '',
    params: JSON.stringify({
      pageSize: Number(settings.page_size),
      pageNumber: page,
      year: String(settings.year),
      orderBy: 'Number',
    }),
  });

  const response = await fetch(`https://brickset.com/api/v3.asmx/getSets?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Brickset API returned HTTP ${response.status}`);
  }

  const body = await response.json();

  if (!body || typeof body !== 'object') {
    throw new Error('Brickset API returned an invalid response');
  }

  if (body.status && body.status !== 'success') {
    throw new Error(body.message || 'Unknown Brickset API error');
  }

  return body;
}

function normalizeSet(raw, settings) {
  let currency = settings.currency;
  const msrpKey = `${currency}RetailPrice`;
  let msrp = Number(raw[msrpKey]) || 0;

  if (msrp <= 0 && raw.USRetailPrice) {
    msrp = Number(raw.USRetailPrice);
    currency = 'US';
  }

  const image =
    raw.image?.imageURL ||
    raw.image?.thumbnailURL ||
    '';

  const excerptParts = [
    raw.pieces ? `${raw.pieces} pieces` : '',
    raw.year ? String(raw.year) : '',
    raw.availability || '',
  ].filter(Boolean);

  return {
    set_number: String(raw.number || '').trim(),
    name: String(raw.name || '').trim(),
    current_price: msrp,
    original_price: msrp,
    source_name: 'Brickset',
    theme: String(raw.theme || '').trim(),
    subtheme: String(raw.subtheme || '').trim(),
    image_url: image,
    currency,
    year: Number(raw.year) || 0,
    pieces: Number(raw.pieces) || 0,
    availability: String(raw.availability || '').trim(),
    brickset_url: String(raw.bricksetURL || '').trim(),
    deal_url: '',
    reddit_url: '',
    retailer: '',
    excerpt: excerptParts.join(' · '),
  };
}

async function scrapeBrickset(settings) {
  const errors = [];
  const results = [];

  if (settings.scrape_brickset === 'false') {
    return { sets: results, errors };
  }

  if (!settings.api_key) {
    errors.push('Add your Brickset API key to scrape catalog data.');
    return { sets: results, errors };
  }

  let page = 1;
  const pageSize = Number(settings.page_size);

  try {
    while (page <= 20) {
      const body = await fetchPage(settings, page);
      if (!body.sets?.length) break;

      for (const raw of body.sets) {
        const set = normalizeSet(raw, settings);
        if (!set.set_number || !set.name) continue;
        results.push(set);
      }

      if (body.sets.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(err.message);
  }

  return { sets: results, errors };
}

function persistSets(sets, dealThreshold, stats) {
  for (const set of sets) {
    if (!set.set_number || !set.name) {
      stats.skipped++;
      continue;
    }

    try {
      const outcome = upsertSet(set, dealThreshold);
      stats[outcome.status]++;
      if (outcome.is_deal) stats.deals++;
    } catch (err) {
      stats.errors++;
      stats.errorMessages = stats.errorMessages || [];
      stats.errorMessages.push(err.message);
    }
  }
}

async function runScrape({ sources = ['brickset', 'reddit'] } = {}) {
  const settings = getSettings();
  const errors = [];
  const stats = emptyStats();
  const dealThreshold = Number(settings.deal_threshold) || 10;

  if (sources.includes('brickset')) {
    const brickset = await scrapeBrickset(settings);
    stats.brickset = brickset.sets.length;
    stats.fetched += brickset.sets.length;
    errors.push(...brickset.errors);
    persistSets(brickset.sets, dealThreshold, stats);
  }

  if (sources.includes('reddit')) {
    const reddit = await scrapeReddit(settings);
    stats.reddit = reddit.fetched;
    stats.fetched += reddit.fetched;
    errors.push(...reddit.errors);
    persistSets(reddit.sets, dealThreshold, stats);
  }

  if (stats.fetched === 0 && errors.length === 0) {
    errors.push('No sets were returned. Check your API key or Reddit subreddit settings.');
  }

  const summary = {
    success: stats.errors === 0,
    stats,
    errors: [...errors, ...(stats.errorMessages || [])],
  };

  delete summary.stats.errorMessages;
  setLastRun(summary);
  return summary;
}

module.exports = { runScrape, formatPrice };
