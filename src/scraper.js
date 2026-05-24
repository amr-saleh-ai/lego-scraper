const {
  getSettings,
  setLastRun,
  upsertSet,
} = require('./db');

const CURRENCY_SYMBOLS = { US: '$', UK: '£', CA: 'CA$', DE: '€' };

function formatPrice(amount, currency = 'US') {
  if (!amount || amount <= 0) return 'N/A';
  const symbol = CURRENCY_SYMBOLS[currency] || '$';
  return `${symbol}${Number(amount).toFixed(2)}`;
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
    excerpt: excerptParts.join(' · '),
  };
}

async function runScrape() {
  const settings = getSettings();
  const errors = [];
  const stats = { fetched: 0, created: 0, updated: 0, deals: 0, skipped: 0, errors: 0 };
  const dealThreshold = Number(settings.deal_threshold) || 10;

  if (!settings.api_key) {
    return {
      success: false,
      stats,
      errors: ['Add your Brickset API key in Admin before running a scrape.'],
    };
  }

  const results = [];
  let page = 1;
  const pageSize = Number(settings.page_size);

  try {
    while (page <= 20) {
      const body = await fetchPage(settings, page);

      if (!body.sets?.length) break;

      for (const raw of body.sets) {
        const set = normalizeSet(raw, settings);
        if (!set.set_number || !set.name) {
          stats.skipped++;
          continue;
        }
        results.push(set);
      }

      if (body.sets.length < pageSize) break;
      page++;
    }
  } catch (err) {
    errors.push(err.message);
  }

  stats.fetched = results.length;

  for (const set of results) {
    try {
      const outcome = upsertSet(set, dealThreshold);
      stats[outcome.status]++;
      if (outcome.is_deal) stats.deals++;
    } catch (err) {
      stats.errors++;
      errors.push(err.message);
    }
  }

  if (!results.length && !errors.length) {
    errors.push('No sets were returned from Brickset.');
  }

  const summary = { success: errors.length === 0, stats, errors };
  setLastRun(summary);
  return summary;
}

module.exports = { runScrape, formatPrice };
