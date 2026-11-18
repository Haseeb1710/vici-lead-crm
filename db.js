const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Support both local folder and serverless (/tmp on Vercel)
const isVercel = Boolean(process.env.VERCEL);
const dataDir = isVercel ? path.join(os.tmpdir(), 'vici-crm-data') : path.join(__dirname, 'data');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;
try {
  const { DatabaseSync } = require('node:sqlite');
  const dbPath = path.join(dataDir, 'crm.sqlite');
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
} catch (err) {
  console.warn('node:sqlite unavailable, falling back to JSON file persistence:', err.message);
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password) + '_vicicrm_salt').digest('hex');
}

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT DEFAULT 'admin',
    vici_agent_user TEXT DEFAULT '1001',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source_code TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    default_list_id TEXT DEFAULT '999',
    auto_push_vici INTEGER DEFAULT 0,
    active INTEGER DEFAULT 1,
    leads_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    phone_number TEXT NOT NULL,
    phone_code TEXT DEFAULT '1',
    email TEXT DEFAULT '',
    company TEXT DEFAULT '',
    address1 TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    postal_code TEXT DEFAULT '',
    country_code TEXT DEFAULT 'USA',
    vendor_lead_code TEXT DEFAULT '',
    source_id INTEGER,
    source_name TEXT DEFAULT 'Manual',
    list_id TEXT DEFAULT '999',
    status TEXT DEFAULT 'NEW',
    notes TEXT DEFAULT '',
    custom_fields TEXT DEFAULT '{}',
    vici_lead_id TEXT DEFAULT '',
    vici_synced INTEGER DEFAULT 0,
    vici_sync_status TEXT DEFAULT 'PENDING',
    vici_last_response TEXT DEFAULT '',
    last_called_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (source_id) REFERENCES api_sources(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS vici_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    action_type TEXT NOT NULL,
    request_url TEXT NOT NULL,
    response_text TEXT DEFAULT '',
    success INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default settings
const defaultSettings = {
  vici_server_url: 'https://your-vicidial-server.com',
  vici_non_agent_path: '/vicidial/non_agent_api.php',
  vici_agent_path: '/agc/api.php',
  vici_api_user: '6666',
  vici_api_pass: '1234',
  vici_source: 'ViciCRM',
  vici_default_list_id: '999',
  vici_default_phone_code: '1',
  vici_duplicate_check: 'DUPLIVE',
  vici_auto_push_global: 'false',
  vici_default_agent_user: '1001',
  vici_simulation_mode: 'true',
  jwt_secret: process.env.JWT_SECRET || 'vicilead-crm-secret-key-2026'
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [key, value] of Object.entries(defaultSettings)) {
  insertSetting.run(key, value);
}

// Seed default users if empty
const countUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
if (countUsers.cnt === 0) {
  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, display_name, role, vici_agent_user)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertUser.run('admin', hashPassword('admin123'), 'Administrator', 'admin', '1001');
  insertUser.run('haseeb', hashPassword('haseeb123'), 'Haseeb (Admin)', 'admin', '1001');
}

// Seed default partner API keys if empty
const countSources = db.prepare('SELECT COUNT(*) as cnt FROM api_sources').get();
if (countSources.cnt === 0) {
  const insertSource = db.prepare(`
    INSERT INTO api_sources (name, source_code, api_key, default_list_id, auto_push_vici, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  insertSource.run(
    'Facebook / Meta Lead Ads',
    'FB_ADS',
    'vcrm_live_fb882910a4c7d1e2b3f49012',
    '101',
    1
  );
  insertSource.run(
    'Landing Page / Website Webhook',
    'WEB_LP',
    'vcrm_live_lp771920b5d8e3f1a2c38045',
    '102',
    0
  );
}

// Seed sample leads if empty
const countLeads = db.prepare('SELECT COUNT(*) as cnt FROM leads').get();
if (countLeads.cnt === 0) {
  const firstSource = db.prepare('SELECT id, name, default_list_id FROM api_sources LIMIT 1').get();
  const insertLead = db.prepare(`
    INSERT INTO leads (
      first_name, last_name, phone_number, phone_code, email, company,
      city, state, postal_code, vendor_lead_code, source_id, source_name,
      list_id, status, notes, vici_synced, vici_sync_status, vici_lead_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertLead.run(
    'Marcus', 'Vance', '3125550192', '1', 'marcus.vance@apexmotors.com', 'Apex Motors Group',
    'Chicago', 'IL', '60601', 'EXT-9001', firstSource?.id || null, firstSource?.name || 'API',
    '101', 'NEW', 'Interested in commercial fleet expansion Q4', 1, 'SYNCED', '88412'
  );
  insertLead.run(
    'Elena', 'Rostova', '4155550148', '1', 'erostova@horizonlogistics.io', 'Horizon Logistics',
    'San Francisco', 'CA', '94105', 'EXT-9002', firstSource?.id || null, firstSource?.name || 'API',
    '101', 'NEW', 'Requested callback via landing page form', 0, 'PENDING', ''
  );
  insertLead.run(
    'David', 'Thornton', '2145550173', '1', 'd.thornton@lonestarbuilders.com', 'LoneStar Builders',
    'Dallas', 'TX', '75201', 'EXT-9003', null, 'Manual Entry',
    '102', 'CONTACTED', 'Spoke briefly, wants quote tomorrow at 2 PM CST', 1, 'SYNCED', '88415'
  );

  if (firstSource?.id) {
    db.prepare('UPDATE api_sources SET leads_count = 2 WHERE id = ?').run(firstSource.id);
  }
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of rows) {
    settings[r.key] = r.value;
  }
  return settings;
}

function updateSettings(newSettings) {
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(newSettings)) {
    if (k === 'jwt_secret') continue;
    upsert.run(k, String(v ?? ''));
  }
  return getSettings();
}

module.exports = {
  db,
  hashPassword,
  getSettings,
  updateSettings
};
