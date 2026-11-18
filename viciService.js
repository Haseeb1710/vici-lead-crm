const { db, getSettings } = require('./db');

/**
 * Clean phone number to digits only for VICIdial compatibility
 */
function sanitizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  // If US number starts with 1 and is 11 digits, strip leading 1 if phone_code is 1
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

/**
 * Mask password in URLs before storing in logs
 */
function maskUrlPassword(urlStr) {
  return urlStr.replace(/([?&]pass=)[^&]+/i, '$1********');
}

/**
 * Push a lead to VICIdial via Non-Agent API (`add_lead`)
 */
async function pushLeadToVici(lead, options = {}) {
  const settings = getSettings();
  const baseUrl = (settings.vici_server_url || '').replace(/\/+$/, '');
  const nonAgentPath = settings.vici_non_agent_path || '/vicidial/non_agent_api.php';

  const listId = options.list_id || lead.list_id || settings.vici_default_list_id || '999';
  const phoneCode = lead.phone_code || settings.vici_default_phone_code || '1';
  const cleanPhone = sanitizePhone(lead.phone_number);

  const params = new URLSearchParams({
    source: settings.vici_source || 'ViciCRM',
    user: settings.vici_api_user || '6666',
    pass: settings.vici_api_pass || '1234',
    function: 'add_lead',
    phone_number: cleanPhone,
    phone_code: phoneCode,
    list_id: String(listId),
    first_name: lead.first_name || '',
    last_name: lead.last_name || '',
    email: lead.email || '',
    address1: lead.address1 || '',
    city: lead.city || '',
    state: lead.state || '',
    postal_code: lead.postal_code || '',
    country_code: lead.country_code || 'USA',
    vendor_lead_code: lead.vendor_lead_code || String(lead.id),
    source_id: lead.source_name || 'CRM',
    comments: [lead.company ? `Company: ${lead.company}` : '', lead.notes || ''].filter(Boolean).join(' | ')
  });

  if (settings.vici_duplicate_check && settings.vici_duplicate_check !== 'NONE') {
    params.set('duplicate_check', settings.vici_duplicate_check);
  }

  // Optional hopper priority injection
  if (options.add_to_hopper) {
    params.set('add_to_hopper', 'Y');
    params.set('hopper_priority', options.hopper_priority || '99');
  }

  const fullUrl = `${baseUrl}${nonAgentPath}?${params.toString()}`;
  const maskedUrl = maskUrlPassword(fullUrl);

  let responseText = '';
  let isSuccess = false;
  let viciLeadId = lead.vici_lead_id || '';

  if (settings.vici_simulation_mode === 'true') {
    // Simulated VICIdial Non-Agent API response format:
    // SUCCESS: add_lead LEAD HAS BEEN ADDED - 3125550192|6666|101|194821
    viciLeadId = viciLeadId || String(Math.floor(100000 + Math.random() * 900000));
    responseText = `SUCCESS: add_lead LEAD HAS BEEN ADDED - ${cleanPhone}|${settings.vici_api_user}|${listId}|${viciLeadId} (SIMULATION MODE)`;
    isSuccess = true;
  } else {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(fullUrl, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);
      responseText = (await res.text()).trim();
      isSuccess = responseText.toUpperCase().includes('SUCCESS');

      // Extract VICI lead_id from standard response: ...|phone|user|list_id|lead_id
      const pipeParts = responseText.split('|');
      if (isSuccess && pipeParts.length >= 4) {
        const parsedId = pipeParts[pipeParts.length - 1].replace(/\D/g, '');
        if (parsedId) viciLeadId = parsedId;
      }
    } catch (err) {
      responseText = `CONNECTION_ERROR: ${err.message}`;
      isSuccess = false;
    }
  }

  // Update lead record
  db.prepare(`
    UPDATE leads
    SET vici_synced = ?,
        vici_sync_status = ?,
        vici_lead_id = ?,
        vici_last_response = ?,
        list_id = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    isSuccess ? 1 : 0,
    isSuccess ? 'SYNCED' : 'FAILED',
    viciLeadId,
    responseText,
    String(listId),
    lead.id
  );

  // Log API interaction
  db.prepare(`
    INSERT INTO vici_logs (lead_id, action_type, request_url, response_text, success)
    VALUES (?, 'NON_AGENT_ADD_LEAD', ?, ?, ?)
  `).run(lead.id, maskedUrl, responseText, isSuccess ? 1 : 0);

  return {
    success: isSuccess,
    vici_lead_id: viciLeadId,
    response: responseText,
    request_url: maskedUrl
  };
}

/**
 * Trigger Agent Click-to-Dial via VICIdial Agent API (`external_dial`)
 */
async function agentClickToDial(lead, agentOptions = {}) {
  const settings = getSettings();
  const baseUrl = (settings.vici_server_url || '').replace(/\/+$/, '');
  const agentPath = settings.vici_agent_path || '/agc/api.php';

  const agentUser = agentOptions.agent_user || settings.vici_default_agent_user || '';
  if (!agentUser) {
    throw new Error('Agent User ID is required for VICIdial Agent API external_dial.');
  }

  const cleanPhone = sanitizePhone(lead.phone_number);
  const phoneCode = lead.phone_code || settings.vici_default_phone_code || '1';

  const params = new URLSearchParams({
    source: settings.vici_source || 'ViciCRM',
    user: settings.vici_api_user || '6666',
    pass: settings.vici_api_pass || '1234',
    agent_user: String(agentUser),
    function: 'external_dial',
    value: cleanPhone,
    phone_code: phoneCode,
    search: agentOptions.search || 'YES',
    preview: agentOptions.preview || 'NO',
    focus: agentOptions.focus || 'YES'
  });

  if (lead.vici_lead_id) {
    params.set('lead_id', String(lead.vici_lead_id));
  }
  if (lead.vendor_lead_code) {
    params.set('vendor_id', String(lead.vendor_lead_code));
  }

  const fullUrl = `${baseUrl}${agentPath}?${params.toString()}`;
  const maskedUrl = maskUrlPassword(fullUrl);

  let responseText = '';
  let isSuccess = false;

  if (settings.vici_simulation_mode === 'true') {
    responseText = `SUCCESS: external_dial function set - ${cleanPhone}|${agentUser}|${phoneCode}|YES|NO|YES (SIMULATION MODE)`;
    isSuccess = true;
  } else {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(fullUrl, {
        method: 'GET',
        signal: controller.signal
      });
      clearTimeout(timeout);
      responseText = (await res.text()).trim();
      isSuccess = responseText.toUpperCase().includes('SUCCESS');
    } catch (err) {
      responseText = `CONNECTION_ERROR: ${err.message}`;
      isSuccess = false;
    }
  }

  // Update lead status & timestamp
  if (isSuccess) {
    db.prepare(`
      UPDATE leads
      SET status = CASE WHEN status = 'NEW' THEN 'DIALING' ELSE status END,
          last_called_at = datetime('now'),
          vici_last_response = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(responseText, lead.id);
  }

  // Log interaction
  db.prepare(`
    INSERT INTO vici_logs (lead_id, action_type, request_url, response_text, success)
    VALUES (?, 'AGENT_EXTERNAL_DIAL', ?, ?, ?)
  `).run(lead.id, maskedUrl, responseText, isSuccess ? 1 : 0);

  return {
    success: isSuccess,
    agent_user: agentUser,
    phone_number: cleanPhone,
    response: responseText,
    request_url: maskedUrl
  };
}

/**
 * Control active Agent call (Hangup, Pause/Resume, Set Disposition) via Agent API
 */
async function agentCallControl(action, payload = {}) {
  const settings = getSettings();
  const baseUrl = (settings.vici_server_url || '').replace(/\/+$/, '');
  const agentPath = settings.vici_agent_path || '/agc/api.php';
  const agentUser = payload.agent_user || settings.vici_default_agent_user;

  if (!agentUser) {
    throw new Error('Agent User ID is required');
  }

  const params = new URLSearchParams({
    source: settings.vici_source || 'ViciCRM',
    user: settings.vici_api_user || '6666',
    pass: settings.vici_api_pass || '1234',
    agent_user: String(agentUser)
  });

  if (action === 'hangup') {
    params.set('function', 'external_hangup');
    params.set('value', '1');
  } else if (action === 'status') {
    params.set('function', 'external_status');
    params.set('value', payload.dispo_status || 'A');
  } else if (action === 'pause') {
    params.set('function', 'external_pause');
    params.set('value', payload.pause_value || 'PAUSE');
  } else {
    throw new Error(`Unsupported agent action: ${action}`);
  }

  const fullUrl = `${baseUrl}${agentPath}?${params.toString()}`;
  const maskedUrl = maskUrlPassword(fullUrl);

  let responseText = '';
  let isSuccess = false;

  if (settings.vici_simulation_mode === 'true') {
    responseText = `SUCCESS: ${params.get('function')} function set - ${params.get('value')}|${agentUser} (SIMULATION MODE)`;
    isSuccess = true;
  } else {
    try {
      const res = await fetch(fullUrl);
      responseText = (await res.text()).trim();
      isSuccess = responseText.toUpperCase().includes('SUCCESS');
    } catch (err) {
      responseText = `CONNECTION_ERROR: ${err.message}`;
      isSuccess = false;
    }
  }

  db.prepare(`
    INSERT INTO vici_logs (lead_id, action_type, request_url, response_text, success)
    VALUES (?, ?, ?, ?, ?)
  `).run(payload.lead_id || null, `AGENT_${action.toUpperCase()}`, maskedUrl, responseText, isSuccess ? 1 : 0);

  return {
    success: isSuccess,
    response: responseText,
    request_url: maskedUrl
  };
}

/**
 * Test VICIdial Non-Agent API connectivity (`version` function)
 */
async function testViciConnection() {
  const settings = getSettings();
  const baseUrl = (settings.vici_server_url || '').replace(/\/+$/, '');
  const nonAgentPath = settings.vici_non_agent_path || '/vicidial/non_agent_api.php';

  const params = new URLSearchParams({
    source: settings.vici_source || 'ViciCRM',
    user: settings.vici_api_user || '6666',
    pass: settings.vici_api_pass || '1234',
    function: 'version'
  });

  const fullUrl = `${baseUrl}${nonAgentPath}?${params.toString()}`;
  const maskedUrl = maskUrlPassword(fullUrl);

  if (settings.vici_simulation_mode === 'true') {
    return {
      success: true,
      simulation: true,
      response: 'VERSION: 2.14-618a|BUILD: 210415-1432|DATE: 2026-11-19 (SIMULATION MODE ACTIVE)',
      request_url: maskedUrl
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(fullUrl, { signal: controller.signal });
    clearTimeout(timeout);
    const text = (await res.text()).trim();
    const ok = text.toUpperCase().includes('VERSION') || text.toUpperCase().includes('SUCCESS');
    return {
      success: ok,
      simulation: false,
      response: text,
      request_url: maskedUrl
    };
  } catch (err) {
    return {
      success: false,
      simulation: false,
      response: `Failed to reach VICIdial server: ${err.message}`,
      request_url: maskedUrl
    };
  }
}

module.exports = {
  sanitizePhone,
  pushLeadToVici,
  agentClickToDial,
  agentCallControl,
  testViciConnection
};
