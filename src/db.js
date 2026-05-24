const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'lego.db');
const dir = path.dirname(dbPath);

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    set_number TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    theme TEXT,
    subtheme TEXT,
    year INTEGER,
    pieces INTEGER,
    availability TEXT,
    image_url TEXT,
    brickset_url TEXT,
    current_price REAL,
    original_price REAL,
    previous_price REAL,
    discount_percent INTEGER DEFAULT 0,
    is_deal INTEGER DEFAULT 0,
    currency TEXT DEFAULT 'US',
    source_name TEXT DEFAULT 'Brickset',
    excerpt TEXT,
    last_synced INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sets_is_deal ON sets(is_deal);
  CREATE INDEX IF NOT EXISTS idx_sets_theme ON sets(theme);
  CREATE INDEX IF NOT EXISTS idx_sets_discount ON sets(discount_percent DESC);
`);

const defaults = {
  api_key: process.env.BRICKSET_API_KEY || '',
  user_hash: process.env.BRICKSET_USER_HASH || '',
  page_size: '50',
  year: String(new Date().getFullYear()),
  currency: 'US',
  deal_threshold: '10',
  cron_enabled: process.env.CRON_ENABLED !== 'false' ? 'true' : 'false',
  cron_schedule: process.env.CRON_SCHEDULE || '0 6 * * *',
};

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...defaults, ...stored };
}

function saveSettings(input) {
  const clean = {
    api_key: String(input.api_key || '').trim(),
    user_hash: String(input.user_hash || '').trim(),
    page_size: String(Math.min(500, Math.max(10, Number(input.page_size) || 50))),
    year: String(Math.min(2100, Math.max(1950, Number(input.year) || new Date().getFullYear()))),
    currency: ['US', 'UK', 'CA', 'DE'].includes(input.currency) ? input.currency : 'US',
    deal_threshold: String(Math.min(90, Math.max(1, Number(input.deal_threshold) || 10))),
    cron_enabled: input.cron_enabled ? 'true' : 'false',
    cron_schedule: String(input.cron_schedule || '0 6 * * *'),
  };

  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (@key, @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const tx = db.transaction((settings) => {
    for (const [key, value] of Object.entries(settings)) {
      stmt.run({ key, value });
    }
  });

  tx(clean);
  return clean;
}

function getLastRun() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'last_run'").get();
  return row ? JSON.parse(row.value) : null;
}

function setLastRun(summary) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES ('last_run', @value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ value: JSON.stringify({ ...summary, timestamp: Date.now() }) });
}

function findSet(setNumber) {
  return db.prepare('SELECT * FROM sets WHERE set_number = ?').get(setNumber);
}

function upsertSet(data, dealThreshold) {
  const existing = findSet(data.set_number);
  const now = Date.now();
  const previousPrice = existing ? existing.current_price : 0;
  const currentPrice = Number(data.current_price) || 0;
  let originalPrice = Number(data.original_price) || currentPrice;
  if (originalPrice <= 0 && currentPrice > 0) originalPrice = currentPrice;

  let discount = 0;
  if (originalPrice > 0 && currentPrice > 0 && currentPrice < originalPrice) {
    discount = Math.round(((originalPrice - currentPrice) / originalPrice) * 100);
  }

  const priceDropped = previousPrice > 0 && currentPrice > 0 && currentPrice < previousPrice;
  const isDeal = discount >= dealThreshold || priceDropped ? 1 : 0;

  if (existing) {
    db.prepare(`
      UPDATE sets SET
        name = @name,
        theme = @theme,
        subtheme = @subtheme,
        year = @year,
        pieces = @pieces,
        availability = @availability,
        image_url = COALESCE(@image_url, image_url),
        brickset_url = @brickset_url,
        current_price = @current_price,
        original_price = @original_price,
        previous_price = @previous_price,
        discount_percent = @discount_percent,
        is_deal = @is_deal,
        currency = @currency,
        source_name = @source_name,
        excerpt = @excerpt,
        last_synced = @last_synced,
        updated_at = @updated_at
      WHERE set_number = @set_number
    `).run({
      ...data,
      previous_price: previousPrice,
      discount_percent: discount,
      is_deal: isDeal,
      last_synced: now,
      updated_at: now,
    });

    return { status: 'updated', is_deal: isDeal, discount };
  }

  db.prepare(`
    INSERT INTO sets (
      set_number, name, theme, subtheme, year, pieces, availability,
      image_url, brickset_url, current_price, original_price, previous_price,
      discount_percent, is_deal, currency, source_name, excerpt,
      last_synced, created_at, updated_at
    ) VALUES (
      @set_number, @name, @theme, @subtheme, @year, @pieces, @availability,
      @image_url, @brickset_url, @current_price, @original_price, @previous_price,
      @discount_percent, @is_deal, @currency, @source_name, @excerpt,
      @last_synced, @created_at, @updated_at
    )
  `).run({
    ...data,
    previous_price: 0,
    discount_percent: discount,
    is_deal: isDeal,
    last_synced: now,
    created_at: now,
    updated_at: now,
  });

  return { status: 'created', is_deal: isDeal, discount };
}

function listSets({ dealsOnly = false, theme = '', limit = 48 } = {}) {
  let sql = 'SELECT * FROM sets WHERE 1=1';
  const params = [];

  if (dealsOnly) {
    sql += ' AND is_deal = 1';
  }

  if (theme) {
    sql += ' AND theme = ?';
    params.push(theme);
  }

  sql += dealsOnly
    ? ' ORDER BY discount_percent DESC, updated_at DESC'
    : ' ORDER BY updated_at DESC';

  sql += ' LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) AS count FROM sets').get().count;
  const deals = db.prepare('SELECT COUNT(*) AS count FROM sets WHERE is_deal = 1').get().count;
  const themes = db.prepare(`
    SELECT theme, COUNT(*) AS count
    FROM sets
    WHERE theme IS NOT NULL AND theme != ''
    GROUP BY theme
    ORDER BY count DESC
    LIMIT 20
  `).all();

  return { total, deals, themes };
}

module.exports = {
  db,
  getSettings,
  saveSettings,
  getLastRun,
  setLastRun,
  upsertSet,
  listSets,
  getStats,
};
