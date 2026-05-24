const express = require('express');
const cron = require('node-cron');
const path = require('path');
const {
  getSettings,
  saveSettings,
  getLastRun,
  listSets,
  getStats,
} = require('./db');
const { runScrape, formatPrice } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (auth.slice(7) !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/sets', (req, res) => {
  const sets = listSets({
    dealsOnly: req.query.deals === 'true',
    theme: req.query.theme || '',
    limit: Math.min(100, Number(req.query.limit) || 48),
  });

  res.json({ sets: sets.map(serializeSet) });
});

app.get('/api/stats', (_req, res) => {
  res.json({
    ...getStats(),
    lastRun: getLastRun(),
    settings: publicSettings(getSettings()),
  });
});

app.get('/api/settings', requireAdmin, (_req, res) => {
  res.json({ settings: getSettings(), lastRun: getLastRun() });
});

app.post('/api/settings', requireAdmin, (req, res) => {
  const settings = saveSettings(req.body);
  scheduleCron();
  res.json({ settings, lastRun: getLastRun() });
});

app.post('/api/scrape', requireAdmin, async (_req, res) => {
  const result = await runScrape();
  res.json(result);
});

function serializeSet(row) {
  return {
    id: row.id,
    setNumber: row.set_number,
    name: row.name,
    theme: row.theme,
    year: row.year,
    pieces: row.pieces,
    imageUrl: row.image_url,
    bricksetUrl: row.brickset_url,
    currentPrice: row.current_price,
    originalPrice: row.original_price,
    discountPercent: row.discount_percent,
    isDeal: Boolean(row.is_deal),
    currency: row.currency,
    formattedCurrent: formatPrice(row.current_price, row.currency),
    formattedOriginal: formatPrice(row.original_price, row.currency),
    excerpt: row.excerpt,
  };
}

function publicSettings(settings) {
  return {
    year: settings.year,
    currency: settings.currency,
    dealThreshold: settings.deal_threshold,
    cronEnabled: settings.cron_enabled === 'true',
  };
}

let cronTask = null;

function scheduleCron() {
  if (cronTask) {
    cronTask.stop();
    cronTask = null;
  }

  const settings = getSettings();
  if (settings.cron_enabled !== 'true') return;
  if (!cron.validate(settings.cron_schedule)) return;

  cronTask = cron.schedule(settings.cron_schedule, () => {
    runScrape().catch((err) => console.error('Scheduled scrape failed:', err));
  });
}

scheduleCron();

app.listen(PORT, () => {
  console.log(`LEGO Deals app running on port ${PORT}`);
});

module.exports = app;
