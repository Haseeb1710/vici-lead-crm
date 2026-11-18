const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { db, hashPassword, getSettings, updateSettings } = require('./db');
const {
  sanitizePhone,
  pushLeadToVici,
  agentClickToDial,
  agentCallControl,
  testViciConnection
} = require('./viciService');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ============================================================================
// AUTHENTICATION HELPERS (HMAC-SHA256 Signed Stateless Tokens)
// ============================================================================
function getSecret() {
  const settings = getSettings();
  return process.env.JWT_SECRET || settings.jwt_secret || 'vicilead-crm-secret-key-2026';
}

function signAuthToken(user) {
  const payload = {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    vici_agent_user: user.vici_agent_user,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
  };
  const dataB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(dataB64).digest('base64url');
  return `${dataB64}.${sig}`;
}

function verifyAuthToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [dataB64, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', getSecret()).update(dataB64).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function extractUserFromReq(req) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const user = verifyAuthToken(token);
    if (user) return user;
  }
  const cookies = parseCookies(req);
  if (cookies.vcrm_token) {
    const user = verifyAuthToken(cookies.vcrm_token);
    if (user) return user;
  }
  return null;
}

function requireAuth(req, res, next) {
  const user = extractUserFromReq(req);
  if (!user) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }
  req.user = user;
  next();
}

// ============================================================================
// 0. LOGIN / SESSION / USER AUTH ENDPOINTS
// ============================================================================

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const cleanUser = String(username).trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = ?').get(cleanUser);
  if (!user || user.password_hash !== hashPassword(password)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = signAuthToken(user);
  res.setHeader(
    'Set-Cookie',
    `vcrm_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`
  );

  return res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      vici_agent_user: user.vici_agent_user
    }
  });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'vcrm_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ success: true, user: req.user });
});

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password || String(new_password).length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters.' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(
    hashPassword(new_password),
    req.user.username
  );
  res.json({ success: true, message: 'Password updated successfully.' });
});

// Static assets
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================================
// 1. PUBLIC / PARTNER LEAD INTAKE API (Shareable with External Lead Vendors)
// ============================================================================

function resolveApiKey(req) {
  const headerKey = req.headers['x-api-key'];
  if (headerKey) return headerKey.trim();

  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }

  if (req.query.api_key) return String(req.query.api_key).trim();
  if (req.body && req.body.api_key) return String(req.body.api_key).trim();
  return null;
}

async function handleExternalLeadIntake(req, res) {
  try {
    const apiKey = resolveApiKey(req);
    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Missing API Key. Pass it via header "X-API-Key: <your_key>" or query param "?api_key=<your_key>".'
      });
    }

    const source = db.prepare('SELECT * FROM api_sources WHERE api_key = ? AND active = 1').get(apiKey);
    if (!source) {
      return res.status(403).json({
        success: false,
        error: 'Invalid or inactive API Key.'
      });
    }

    const payload = { ...req.query, ...(req.body || {}) };
    const rawPhone = payload.phone_number || payload.phone || payload.mobile || payload.tel || '';
    const cleanPhone = sanitizePhone(rawPhone);

    if (!cleanPhone || cleanPhone.length < 7) {
      return res.status(400).json({
        success: false,
        error: 'Valid phone_number (or phone) is required (minimum 7 digits).'
      });
    }

    const settings = getSettings();

    let firstName = payload.first_name || payload.fname || '';
    let lastName = payload.last_name || payload.lname || '';
    if (!firstName && !lastName && (payload.full_name || payload.name)) {
      const parts = String(payload.full_name || payload.name).trim().split(/\s+/);
      firstName = parts[0] || '';
      lastName = parts.slice(1).join(' ') || '';
    }

    const listId = String(payload.list_id || source.default_list_id || settings.vici_default_list_id || '999');
    const phoneCode = String(payload.phone_code || settings.vici_default_phone_code || '1');

    const standardKeys = new Set([
      'api_key', 'first_name', 'fname', 'last_name', 'lname', 'full_name', 'name',
      'phone_number', 'phone', 'mobile', 'tel', 'phone_code', 'email', 'company',
      'address1', 'address', 'city', 'state', 'postal_code', 'zip', 'country_code',
      'vendor_lead_code', 'external_id', 'list_id', 'notes', 'comments', 'auto_push'
    ]);
    const customObj = {};
    for (const [k, v] of Object.entries(payload)) {
      if (!standardKeys.has(k) && v !== undefined && v !== '') {
        customObj[k] = v;
      }
    }

    const insertResult = db.prepare(`
      INSERT INTO leads (
        first_name, last_name, phone_number, phone_code, email, company,
        address1, city, state, postal_code, country_code, vendor_lead_code,
        source_id, source_name, list_id, status, notes, custom_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NEW', ?, ?)
    `).run(
      firstName,
      lastName,
      cleanPhone,
      phoneCode,
      payload.email || '',
      payload.company || '',
      payload.address1 || payload.address || '',
      payload.city || '',
      payload.state || '',
      payload.postal_code || payload.zip || '',
      payload.country_code || 'USA',
      payload.vendor_lead_code || payload.external_id || '',
      source.id,
      source.name,
      listId,
      payload.notes || payload.comments || '',
      JSON.stringify(customObj)
    );

    const newLeadId = insertResult.lastInsertRowid;

    db.prepare('UPDATE api_sources SET leads_count = leads_count + 1 WHERE id = ?').run(source.id);

    const createdLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(newLeadId);

    const shouldAutoPush =
      source.auto_push_vici === 1 ||
      settings.vici_auto_push_global === 'true' ||
      payload.auto_push === true ||
      payload.auto_push === 'true' ||
      payload.auto_push === '1';

    let viciResult = null;
    if (shouldAutoPush) {
      viciResult = await pushLeadToVici(createdLead, {
        list_id: listId,
        add_to_hopper: payload.add_to_hopper === 'Y' || payload.add_to_hopper === true
      });
    }

    const updatedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(newLeadId);

    return res.status(201).json({
      success: true,
      message: 'Lead accepted into CRM',
      crm_lead_id: updatedLead.id,
      source: source.name,
      list_id: updatedLead.list_id,
      vici_pushed: Boolean(shouldAutoPush),
      vici_sync_status: updatedLead.vici_sync_status,
      vici_lead_id: updatedLead.vici_lead_id || null,
      vici_response: viciResult ? viciResult.response : undefined
    });
  } catch (err) {
    console.error('Lead intake error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error processing lead: ' + err.message
    });
  }
}

app.post('/api/v1/leads/intake', handleExternalLeadIntake);
app.get('/api/v1/leads/intake', handleExternalLeadIntake);

// VICIdial Dispo Call URL Webhook
app.all('/api/v1/vici/webhook', (req, res) => {
  try {
    const data = { ...req.query, ...(req.body || {}) };
    const viciLeadId = String(data.lead_id || '').trim();
    const vendorCode = String(data.vendor_lead_code || '').trim();
    const phone = sanitizePhone(data.phone_number || data.phone || '');
    const dispoStatus = String(data.status || data.dispo || 'CONTACTED').trim();
    const agentUser = String(data.user || data.agent_user || '').trim();

    let lead = null;
    if (viciLeadId) {
      lead = db.prepare('SELECT * FROM leads WHERE vici_lead_id = ?').get(viciLeadId);
    }
    if (!lead && vendorCode) {
      lead = db.prepare('SELECT * FROM leads WHERE id = ? OR vendor_lead_code = ?').get(vendorCode, vendorCode);
    }
    if (!lead && phone) {
      lead = db.prepare('SELECT * FROM leads WHERE phone_number = ? ORDER BY id DESC LIMIT 1').get(phone);
    }

    if (!lead) {
      return res.status(404).json({ success: false, message: 'No matching CRM lead found for webhook update' });
    }

    const noteAddition = `[VICI Dispo: ${dispoStatus}${agentUser ? ` by Agent ${agentUser}` : ''} @ ${new Date().toISOString()}]`;
    const updatedNotes = [lead.notes, noteAddition].filter(Boolean).join('\n');

    db.prepare(`
      UPDATE leads
      SET status = ?,
          vici_lead_id = COALESCE(NULLIF(?, ''), vici_lead_id),
          notes = ?,
          last_called_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(dispoStatus, viciLeadId, updatedNotes, lead.id);

    db.prepare(`
      INSERT INTO vici_logs (lead_id, action_type, request_url, response_text, success)
      VALUES (?, 'VICI_DISPO_WEBHOOK', ?, ?, 1)
    `).run(lead.id, req.originalUrl, `Updated status to ${dispoStatus}`);

    return res.json({ success: true, lead_id: lead.id, updated_status: dispoStatus });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 2. PROTECTED INTERNAL CRM DASHBOARD API
// ============================================================================

app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const totalLeads = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const syncedLeads = db.prepare('SELECT COUNT(*) as c FROM leads WHERE vici_synced = 1').get().c;
  const pendingLeads = db.prepare("SELECT COUNT(*) as c FROM leads WHERE vici_sync_status = 'PENDING'").get().c;
  const failedLeads = db.prepare("SELECT COUNT(*) as c FROM leads WHERE vici_sync_status = 'FAILED'").get().c;
  const dialedToday = db.prepare("SELECT COUNT(*) as c FROM leads WHERE last_called_at >= date('now')").get().c;
  const activeSources = db.prepare('SELECT COUNT(*) as c FROM api_sources WHERE active = 1').get().c;
  const settings = getSettings();

  res.json({
    total_leads: totalLeads,
    synced_leads: syncedLeads,
    pending_leads: pendingLeads,
    failed_leads: failedLeads,
    dialed_today: dialedToday,
    active_sources: activeSources,
    simulation_mode: settings.vici_simulation_mode === 'true',
    default_agent_user: settings.vici_default_agent_user || '1001',
    current_user: req.user
  });
});

app.get('/api/leads', requireAuth, (req, res) => {
  const { search, status, vici_status, source_id, list_id } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (search) {
    sql += ` AND (first_name LIKE ? OR last_name LIKE ? OR phone_number LIKE ? OR email LIKE ? OR company LIKE ? OR vendor_lead_code LIKE ?)`;
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term, term, term);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (vici_status) {
    sql += ' AND vici_sync_status = ?';
    params.push(vici_status);
  }
  if (source_id) {
    sql += ' AND source_id = ?';
    params.push(Number(source_id));
  }
  if (list_id) {
    sql += ' AND list_id = ?';
    params.push(String(list_id));
  }

  sql += ' ORDER BY id DESC LIMIT 500';
  const leads = db.prepare(sql).all(...params);
  res.json({ leads });
});

app.post('/api/leads', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const cleanPhone = sanitizePhone(b.phone_number);
    if (!cleanPhone) {
      return res.status(400).json({ error: 'Valid phone number is required' });
    }

    const settings = getSettings();
    const listId = String(b.list_id || settings.vici_default_list_id || '999');

    const result = db.prepare(`
      INSERT INTO leads (
        first_name, last_name, phone_number, phone_code, email, company,
        address1, city, state, postal_code, country_code, vendor_lead_code,
        source_name, list_id, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Manual Entry', ?, ?, ?)
    `).run(
      b.first_name || '',
      b.last_name || '',
      cleanPhone,
      b.phone_code || settings.vici_default_phone_code || '1',
      b.email || '',
      b.company || '',
      b.address1 || '',
      b.city || '',
      b.state || '',
      b.postal_code || '',
      b.country_code || 'USA',
      b.vendor_lead_code || '',
      listId,
      b.status || 'NEW',
      b.notes || ''
    );

    const newLeadId = result.lastInsertRowid;
    let lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(newLeadId);

    if (b.push_to_vici) {
      await pushLeadToVici(lead, { list_id: listId, add_to_hopper: b.add_to_hopper });
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(newLeadId);
    }

    res.status(201).json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/bulk', requireAuth, async (req, res) => {
  try {
    const { leads, list_id, push_to_vici } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: 'Provide a non-empty array of leads' });
    }

    const settings = getSettings();
    const targetListId = String(list_id || settings.vici_default_list_id || '999');

    const insertStmt = db.prepare(`
      INSERT INTO leads (
        first_name, last_name, phone_number, phone_code, email, company,
        city, state, postal_code, vendor_lead_code, source_name, list_id, status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CSV Import', ?, 'NEW', ?)
    `);

    const insertedIds = [];
    for (const item of leads) {
      const cleanPhone = sanitizePhone(item.phone_number || item.phone || item.Phone || '');
      if (!cleanPhone || cleanPhone.length < 7) continue;

      const r = insertStmt.run(
        item.first_name || item.FirstName || item.name || '',
        item.last_name || item.LastName || '',
        cleanPhone,
        item.phone_code || '1',
        item.email || item.Email || '',
        item.company || item.Company || '',
        item.city || item.City || '',
        item.state || item.State || '',
        item.postal_code || item.Zip || '',
        item.vendor_lead_code || '',
        item.list_id || targetListId,
        item.notes || ''
      );
      insertedIds.push(r.lastInsertRowid);
    }

    let pushedCount = 0;
    if (push_to_vici && insertedIds.length > 0) {
      for (const id of insertedIds) {
        const l = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
        if (l) {
          const resVici = await pushLeadToVici(l, { list_id: l.list_id });
          if (resVici.success) pushedCount++;
        }
      }
    }

    res.json({
      success: true,
      imported_count: insertedIds.length,
      pushed_count: pushedCount
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/leads/:id', requireAuth, (req, res) => {
  try {
    const id = Number(req.params.id);
    const b = req.body || {};
    const existing = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Lead not found' });

    const cleanPhone = b.phone_number ? sanitizePhone(b.phone_number) : existing.phone_number;

    db.prepare(`
      UPDATE leads
      SET first_name = ?,
          last_name = ?,
          phone_number = ?,
          phone_code = ?,
          email = ?,
          company = ?,
          city = ?,
          state = ?,
          postal_code = ?,
          list_id = ?,
          status = ?,
          notes = ?,
          vendor_lead_code = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      b.first_name ?? existing.first_name,
      b.last_name ?? existing.last_name,
      cleanPhone,
      b.phone_code ?? existing.phone_code,
      b.email ?? existing.email,
      b.company ?? existing.company,
      b.city ?? existing.city,
      b.state ?? existing.state,
      b.postal_code ?? existing.postal_code,
      b.list_id ?? existing.list_id,
      b.status ?? existing.status,
      b.notes ?? existing.notes,
      b.vendor_lead_code ?? existing.vendor_lead_code,
      id
    );

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    res.json({ success: true, lead: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/leads/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  res.json({ success: true });
});

// ============================================================================
// 3. VICIDIAL DIALER ACTIONS (PUSH TO LIST, BATCH PUSH, CLICK-TO-DIAL)
// ============================================================================

app.post('/api/leads/:id/vici-push', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const result = await pushLeadToVici(lead, req.body || {});
    const updatedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    res.json({ ...result, lead: updatedLead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vici/batch-push', requireAuth, async (req, res) => {
  try {
    const { lead_ids, list_id, add_to_hopper } = req.body || {};
    let leadsToPush = [];

    if (Array.isArray(lead_ids) && lead_ids.length > 0) {
      const placeholders = lead_ids.map(() => '?').join(',');
      leadsToPush = db.prepare(`SELECT * FROM leads WHERE id IN (${placeholders})`).all(...lead_ids.map(Number));
    } else {
      leadsToPush = db.prepare('SELECT * FROM leads WHERE vici_synced = 0 ORDER BY id ASC LIMIT 200').all();
    }

    let successCount = 0;
    let failCount = 0;
    const results = [];

    for (const lead of leadsToPush) {
      const r = await pushLeadToVici(lead, {
        list_id: list_id || lead.list_id,
        add_to_hopper: Boolean(add_to_hopper)
      });
      if (r.success) successCount++;
      else failCount++;
      results.push({ lead_id: lead.id, ...r });
    }

    res.json({
      success: true,
      total: leadsToPush.length,
      synced: successCount,
      failed: failCount,
      results
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/leads/:id/vici-dial', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (!lead.vici_synced && req.body?.ensure_synced !== false) {
      await pushLeadToVici(lead, { list_id: lead.list_id });
      lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
    }

    const result = await agentClickToDial(lead, req.body || {});
    const updatedLead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

    res.json({ ...result, lead: updatedLead });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vici/agent-control', requireAuth, async (req, res) => {
  try {
    const { action, agent_user, dispo_status, pause_value, lead_id } = req.body || {};
    const result = await agentCallControl(action, {
      agent_user,
      dispo_status,
      pause_value,
      lead_id
    });

    if (result.success && action === 'status' && lead_id && dispo_status) {
      db.prepare("UPDATE leads SET status = ?, updated_at = datetime('now') WHERE id = ?").run(dispo_status, Number(lead_id));
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/vici/test', requireAuth, async (req, res) => {
  const result = await testViciConnection();
  res.json(result);
});

app.get('/api/vici/logs', requireAuth, (req, res) => {
  const logs = db.prepare(`
    SELECT l.*, ld.first_name, ld.last_name, ld.phone_number
    FROM vici_logs l
    LEFT JOIN leads ld ON l.lead_id = ld.id
    ORDER BY l.id DESC
    LIMIT 100
  `).all();
  res.json({ logs });
});

// ============================================================================
// 4. PARTNER API SOURCES & SETTINGS MANAGEMENT
// ============================================================================

app.get('/api/sources', requireAuth, (req, res) => {
  const sources = db.prepare('SELECT * FROM api_sources ORDER BY id DESC').all();
  res.json({ sources });
});

app.post('/api/sources', requireAuth, (req, res) => {
  try {
    const { name, source_code, default_list_id, auto_push_vici } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Source Name is required' });

    const code = (source_code || name.toUpperCase().replace(/[^A-Z0-9]/g, '_')).slice(0, 20);
    const apiKey = 'vcrm_live_' + crypto.randomBytes(12).toString('hex');

    const r = db.prepare(`
      INSERT INTO api_sources (name, source_code, api_key, default_list_id, auto_push_vici, active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(name, code, apiKey, String(default_list_id || '999'), auto_push_vici ? 1 : 0);

    const created = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(r.lastInsertRowid);
    res.status(201).json({ success: true, source: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/sources/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const { name, default_list_id, auto_push_vici, active } = req.body || {};
  const existing = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'API Source not found' });

  db.prepare(`
    UPDATE api_sources
    SET name = ?,
        default_list_id = ?,
        auto_push_vici = ?,
        active = ?
    WHERE id = ?
  `).run(
    name ?? existing.name,
    default_list_id ?? existing.default_list_id,
    auto_push_vici !== undefined ? (auto_push_vici ? 1 : 0) : existing.auto_push_vici,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    id
  );

  const updated = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(id);
  res.json({ success: true, source: updated });
});

app.post('/api/sources/:id/regenerate-key', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const newKey = 'vcrm_live_' + crypto.randomBytes(12).toString('hex');
  db.prepare('UPDATE api_sources SET api_key = ? WHERE id = ?').run(newKey, id);
  const updated = db.prepare('SELECT * FROM api_sources WHERE id = ?').get(id);
  res.json({ success: true, source: updated });
});

app.delete('/api/sources/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM api_sources WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get('/api/settings', requireAuth, (req, res) => {
  const s = getSettings();
  delete s.jwt_secret;
  res.json({ settings: s });
});

app.put('/api/settings', requireAuth, (req, res) => {
  const updated = updateSettings(req.body || {});
  delete updated.jwt_secret;
  res.json({ success: true, settings: updated });
});

// Only start listening if executed directly (not imported by Vercel serverless runtime)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n========================================================`);
    console.log(`  ViciLead CRM & Dialer Bridge running on port ${PORT}`);
    console.log(`  Login Screen:     http://localhost:${PORT}/login`);
    console.log(`  Dashboard UI:     http://localhost:${PORT}`);
    console.log(`  Lead Intake API:  http://localhost:${PORT}/api/v1/leads/intake`);
    console.log(`========================================================\n`);
  });
}

module.exports = app;
