let currentLeads = [];
let currentSources = [];
let selectedSource = null;

// Intercept internal /api/* fetches to attach Auth token & redirect to /login on 401
const originalFetch = window.fetch.bind(window);
window.fetch = async function (url, options = {}) {
  const token = localStorage.getItem('vcrm_token');
  const headers = new Headers(options.headers || {});
  if (token && !headers.has('Authorization') && !String(url).includes('/api/v1/leads/intake')) {
    headers.set('Authorization', 'Bearer ' + token);
  }
  const res = await originalFetch(url, { ...options, headers });
  if (res.status === 401 && !String(url).includes('/api/v1/leads/intake') && !String(url).includes('/api/auth/login')) {
    localStorage.removeItem('vcrm_token');
    window.location.href = '/login';
  }
  return res;
};

async function logoutUser() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } catch {}
  localStorage.removeItem('vcrm_token');
  localStorage.removeItem('vcrm_user');
  window.location.href = '/login';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Verify session before loading dashboard
  try {
    const authRes = await fetch('/api/auth/me');
    if (!authRes.ok) {
      window.location.href = '/login';
      return;
    }
    const authData = await authRes.json();
    const badge = document.getElementById('loggedInUserBadge');
    if (badge && authData.user) {
      badge.textContent = authData.user.display_name || authData.user.username;
    }
  } catch {
    window.location.href = '/login';
    return;
  }

  refreshAll();
  const baseUrl = window.location.origin;
  document.getElementById('viciDispoWebhookUrl').textContent =
    `${baseUrl}/api/v1/vici/webhook?lead_id=--A--lead_id--B--&vendor_lead_code=--A--vendor_lead_code--B--&status=--A--dispo--B--&phone_number=--A--phone_number--B--&user=--A--user--B--`;
});

async function refreshAll() {
  await Promise.all([
    loadDashboardStats(),
    loadLeads(),
    loadApiSources(),
    loadViciSettings(),
    loadViciLogs()
  ]);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  const colors = {
    success: 'bg-emerald-950/95 border-emerald-500/40 text-emerald-200',
    error: 'bg-rose-950/95 border-rose-500/40 text-rose-200',
    info: 'bg-slate-900/95 border-indigo-500/40 text-slate-200'
  };
  el.className = `px-4 py-3 rounded-xl border shadow-xl text-xs font-medium flex items-center gap-2.5 transition-all ${colors[type] || colors.info}`;
  el.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check text-emerald-400' : type === 'error' ? 'fa-triangle-exclamation text-rose-400' : 'fa-circle-info text-indigo-400'}"></i><span>${escapeHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function switchTab(tabName) {
  ['leads', 'api', 'vici', 'logs'].forEach((t) => {
    const sec = document.getElementById(`tab-${t}`);
    const btn = document.getElementById(`tabBtn-${t}`);
    if (t === tabName) {
      sec.classList.remove('hidden');
      btn.className = 'tab-btn px-4 py-2.5 text-sm font-medium border-b-2 border-indigo-500 text-indigo-400 flex items-center gap-2';
    } else {
      sec.classList.add('hidden');
      btn.className = 'tab-btn px-4 py-2.5 text-sm font-medium border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center gap-2';
    }
  });
  if (tabName === 'logs') loadViciLogs();
}

// ============================================================================
// DASHBOARD STATS
// ============================================================================
async function loadDashboardStats() {
  try {
    const res = await fetch('/api/dashboard/stats');
    const data = await res.json();
    document.getElementById('statTotalLeads').textContent = data.total_leads ?? 0;
    document.getElementById('statSyncedLeads').textContent = data.synced_leads ?? 0;
    document.getElementById('statPendingLeads').textContent = data.pending_leads ?? 0;
    document.getElementById('statFailedLeads').textContent = data.failed_leads ?? 0;
    document.getElementById('statDialedToday').textContent = data.dialed_today ?? 0;
    document.getElementById('statActiveSources').textContent = data.active_sources ?? 0;

    const simBadge = document.getElementById('simBadge');
    if (data.simulation_mode) {
      simBadge.classList.remove('hidden');
    } else {
      simBadge.classList.add('hidden');
    }

    const agentInput = document.getElementById('activeAgentInput');
    if (data.default_agent_user && !agentInput.dataset.modified) {
      agentInput.value = data.default_agent_user;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ============================================================================
// LEADS TABLE & VICIDIAL ACTIONS
// ============================================================================
async function loadLeads() {
  const search = document.getElementById('leadSearchInput').value.trim();
  const status = document.getElementById('filterStatus').value;
  const vici_status = document.getElementById('filterViciStatus').value;

  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (status) qs.set('status', status);
  if (vici_status) qs.set('vici_status', vici_status);

  const res = await fetch(`/api/leads?${qs.toString()}`);
  const data = await res.json();
  currentLeads = data.leads || [];
  renderLeadsTable();
}

function getStatusBadge(status) {
  const map = {
    NEW: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
    DIALING: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
    CONTACTED: 'bg-blue-500/15 text-blue-300 border-blue-500/30',
    INTERESTED: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    CALLBACK: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    SALE: 'bg-green-500/20 text-green-300 border-green-500/40',
    DNC: 'bg-rose-500/15 text-rose-300 border-rose-500/30'
  };
  const cls = map[status] || 'bg-slate-800 text-slate-300 border-slate-700';
  return `<span class="px-2 py-0.5 text-[11px] font-semibold rounded-md border ${cls}">${escapeHtml(status)}</span>`;
}

function getViciSyncBadge(lead) {
  if (lead.vici_sync_status === 'SYNCED') {
    return `
      <div class="flex flex-col">
        <span class="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
          <i class="fa-solid fa-circle-check"></i> Synced
        </span>
        ${lead.vici_lead_id ? `<span class="text-[11px] text-slate-400 mono">VICI ID: #${escapeHtml(lead.vici_lead_id)}</span>` : ''}
      </div>
    `;
  }
  if (lead.vici_sync_status === 'FAILED') {
    return `
      <div class="flex flex-col" title="${escapeHtml(lead.vici_last_response)}">
        <span class="inline-flex items-center gap-1 text-xs font-semibold text-rose-400">
          <i class="fa-solid fa-circle-exclamation"></i> Failed
        </span>
        <span class="text-[10px] text-slate-500 truncate max-w-[140px]">${escapeHtml(lead.vici_last_response)}</span>
      </div>
    `;
  }
  return `
    <span class="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
      <i class="fa-regular fa-clock"></i> Pending Push
    </span>
  `;
}

function renderLeadsTable() {
  const tbody = document.getElementById('leadsTableBody');
  if (currentLeads.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-500 text-sm">
          No leads match your filter. Add a lead manually or send one via your Shareable Intake API.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = currentLeads.map((lead) => {
    const fullName = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Unnamed Lead';
    return `
      <tr class="hover:bg-slate-800/40 transition">
        <td class="py-3.5 px-4">
          <div class="font-semibold text-white">${escapeHtml(fullName)}</div>
          <div class="text-xs text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
            ${lead.company ? `<span><i class="fa-regular fa-building mr-1 text-slate-500"></i>${escapeHtml(lead.company)}</span>` : ''}
            ${lead.city || lead.state ? `<span>• ${escapeHtml([lead.city, lead.state].filter(Boolean).join(', '))}</span>` : ''}
          </div>
          ${lead.notes ? `<div class="text-[11px] text-slate-500 mt-1 italic truncate max-w-xs" title="${escapeHtml(lead.notes)}">"${escapeHtml(lead.notes)}"</div>` : ''}
        </td>

        <td class="py-3.5 px-4">
          <div class="mono font-semibold text-slate-200 text-sm">+${escapeHtml(lead.phone_code || '1')} ${escapeHtml(lead.phone_number)}</div>
          ${lead.email ? `<div class="text-xs text-slate-400 truncate max-w-[180px]">${escapeHtml(lead.email)}</div>` : ''}
        </td>

        <td class="py-3.5 px-4">
          <div class="text-xs font-medium text-slate-200">${escapeHtml(lead.source_name || 'Manual')}</div>
          <div class="text-[11px] text-slate-400 mono mt-0.5">List ID: <span class="text-cyan-400 font-semibold">${escapeHtml(lead.list_id)}</span></div>
        </td>

        <td class="py-3.5 px-4">
          ${getStatusBadge(lead.status)}
          ${lead.last_called_at ? `<div class="text-[10px] text-slate-500 mt-1">Dialed: ${escapeHtml(lead.last_called_at)}</div>` : ''}
        </td>

        <td class="py-3.5 px-4">
          ${getViciSyncBadge(lead)}
        </td>

        <td class="py-3.5 px-4 text-right">
          <div class="inline-flex items-center gap-1.5">
            <!-- Click to Dial via VICIdial Agent API -->
            <button onclick="dialLeadWithVici(${lead.id})"
              class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 shadow shadow-emerald-600/20 transition"
              title="Dial immediately in logged-in VICIdial Agent screen (external_dial)">
              <i class="fa-solid fa-phone"></i> Dial in VICI
            </button>

            <!-- Push to VICIdial List via Non-Agent API -->
            <button onclick="pushSingleLeadToVici(${lead.id})"
              class="px-2.5 py-1.5 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-xs font-medium transition"
              title="Push/Update Lead in VICIdial List ${escapeHtml(lead.list_id)} (add_lead)">
              <i class="fa-solid fa-cloud-arrow-up"></i>
            </button>

            <!-- Edit Lead -->
            <button onclick="openEditLeadModal(${lead.id})"
              class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition"
              title="Edit Lead">
              <i class="fa-solid fa-pen"></i>
            </button>

            <!-- Delete Lead -->
            <button onclick="deleteLead(${lead.id})"
              class="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 text-xs transition"
              title="Delete Lead">
              <i class="fa-solid fa-trash"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function dialLeadWithVici(leadId) {
  const agentUser = document.getElementById('activeAgentInput').value.trim();
  if (!agentUser) {
    showToast('Enter your VICIdial Agent User ID in the top bar first.', 'error');
    return;
  }

  try {
    showToast(`Sending external_dial to VICIdial Agent ${agentUser}...`, 'info');
    const res = await fetch(`/api/leads/${leadId}/vici-dial`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_user: agentUser })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Dialing ${data.phone_number} on Agent ${agentUser}! (${data.response})`, 'success');
    } else {
      showToast(`VICIdial Dial Error: ${data.response || data.error}`, 'error');
    }
    await Promise.all([loadLeads(), loadDashboardStats()]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function pushSingleLeadToVici(leadId) {
  try {
    const res = await fetch(`/api/leads/${leadId}/vici-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add_to_hopper: true })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Lead pushed to VICIdial! VICI Lead ID: #${data.vici_lead_id}`, 'success');
    } else {
      showToast(`VICI Push Failed: ${data.response || data.error}`, 'error');
    }
    await Promise.all([loadLeads(), loadDashboardStats()]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function batchPushUnsynced() {
  try {
    showToast('Pushing unsynced leads to VICIdial...', 'info');
    const res = await fetch('/api/vici/batch-push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add_to_hopper: true })
    });
    const data = await res.json();
    if (data.total === 0) {
      showToast('All leads are already synced to VICIdial!', 'info');
    } else {
      showToast(`Batch push complete: ${data.synced}/${data.total} leads synced to VICIdial.`, data.failed === 0 ? 'success' : 'error');
    }
    await Promise.all([loadLeads(), loadDashboardStats()]);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function triggerAgentControl(action, extra = {}) {
  const agentUser = document.getElementById('activeAgentInput').value.trim();
  if (!agentUser) {
    showToast('Enter your VICIdial Agent User ID first.', 'error');
    return;
  }

  try {
    const res = await fetch('/api/vici/agent-control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, agent_user: agentUser, ...extra })
    });
    const data = await res.json();
    if (data.success) {
      showToast(`Agent ${agentUser}: ${data.response}`, 'success');
    } else {
      showToast(`Agent Control Error: ${data.response || data.error}`, 'error');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ============================================================================
// ADD / EDIT / BULK IMPORT LEADS
// ============================================================================
function openAddLeadModal() {
  document.getElementById('leadModalTitle').textContent = 'Add New Lead';
  document.getElementById('modalLeadId').value = '';
  document.getElementById('modalFirstName').value = '';
  document.getElementById('modalLastName').value = '';
  document.getElementById('modalPhone').value = '';
  document.getElementById('modalListId').value = '101';
  document.getElementById('modalCompany').value = '';
  document.getElementById('modalEmail').value = '';
  document.getElementById('modalCity').value = '';
  document.getElementById('modalState').value = '';
  document.getElementById('modalStatus').value = 'NEW';
  document.getElementById('modalNotes').value = '';
  document.getElementById('modalPushRow').classList.remove('hidden');
  const modal = document.getElementById('leadModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function openEditLeadModal(id) {
  const lead = currentLeads.find((l) => l.id === id);
  if (!lead) return;

  document.getElementById('leadModalTitle').textContent = `Edit Lead #${lead.id}`;
  document.getElementById('modalLeadId').value = lead.id;
  document.getElementById('modalFirstName').value = lead.first_name || '';
  document.getElementById('modalLastName').value = lead.last_name || '';
  document.getElementById('modalPhone').value = lead.phone_number || '';
  document.getElementById('modalListId').value = lead.list_id || '999';
  document.getElementById('modalCompany').value = lead.company || '';
  document.getElementById('modalEmail').value = lead.email || '';
  document.getElementById('modalCity').value = lead.city || '';
  document.getElementById('modalState').value = lead.state || '';
  document.getElementById('modalStatus').value = lead.status || 'NEW';
  document.getElementById('modalNotes').value = lead.notes || '';
  document.getElementById('modalPushRow').classList.add('hidden');

  const modal = document.getElementById('leadModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeLeadModal() {
  const modal = document.getElementById('leadModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

async function submitLeadModal(e) {
  e.preventDefault();
  const id = document.getElementById('modalLeadId').value;
  const payload = {
    first_name: document.getElementById('modalFirstName').value.trim(),
    last_name: document.getElementById('modalLastName').value.trim(),
    phone_number: document.getElementById('modalPhone').value.trim(),
    list_id: document.getElementById('modalListId').value.trim(),
    company: document.getElementById('modalCompany').value.trim(),
    email: document.getElementById('modalEmail').value.trim(),
    city: document.getElementById('modalCity').value.trim(),
    state: document.getElementById('modalState').value.trim(),
    status: document.getElementById('modalStatus').value,
    notes: document.getElementById('modalNotes').value.trim(),
    push_to_vici: document.getElementById('modalPushVici').checked,
    add_to_hopper: document.getElementById('modalAddHopper').checked
  };

  const url = id ? `/api/leads/${id}` : '/api/leads';
  const method = id ? 'PUT' : 'POST';

  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();

  if (!res.ok) {
    showToast(data.error || 'Failed to save lead', 'error');
    return;
  }

  closeLeadModal();
  showToast(id ? 'Lead updated!' : 'Lead added!', 'success');
  await Promise.all([loadLeads(), loadDashboardStats()]);
}

async function deleteLead(id) {
  await fetch(`/api/leads/${id}`, { method: 'DELETE' });
  showToast(`Lead #${id} deleted.`, 'info');
  await Promise.all([loadLeads(), loadDashboardStats()]);
}

function openBulkImportModal() {
  const modal = document.getElementById('bulkModal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
}

function closeBulkImportModal() {
  const modal = document.getElementById('bulkModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
}

function handleCsvFileSelect(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    document.getElementById('csvPasteArea').value = ev.target.result || '';
  };
  reader.readAsText(file);
}

async function submitBulkCsvImport() {
  const raw = document.getElementById('csvPasteArea').value.trim();
  if (!raw) {
    showToast('Paste CSV rows or select a CSV file first.', 'error');
    return;
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return;

  const firstCols = lines[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
  const hasHeader = firstCols.some((c) => /phone|name|email|company/i.test(c));

  const parsedLeads = [];
  if (hasHeader) {
    const headers = firstCols.map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h] = cols[idx] || '';
      });
      parsedLeads.push(obj);
    }
  } else {
    // Assume order: first_name,last_name,phone_number,company,email
    for (const line of lines) {
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
      parsedLeads.push({
        first_name: cols[0] || '',
        last_name: cols[1] || '',
        phone_number: cols[2] || cols[0] || '',
        company: cols[3] || '',
        email: cols[4] || ''
      });
    }
  }

  const list_id = document.getElementById('bulkListId').value.trim() || '101';
  const push_to_vici = document.getElementById('bulkPushVici').checked;

  const res = await fetch('/api/leads/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leads: parsedLeads, list_id, push_to_vici })
  });
  const data = await res.json();

  if (data.success) {
    closeBulkImportModal();
    showToast(`Imported ${data.imported_count} leads (${data.pushed_count} pushed to VICIdial).`, 'success');
    await Promise.all([loadLeads(), loadDashboardStats()]);
  } else {
    showToast(data.error || 'CSV Import failed', 'error');
  }
}

// ============================================================================
// TAB 2: SHAREABLE PARTNER API KEYS & WEBHOOK DOCS
// ============================================================================
async function loadApiSources() {
  const res = await fetch('/api/sources');
  const data = await res.json();
  currentSources = data.sources || [];
  if (!selectedSource && currentSources.length > 0) {
    selectedSource = currentSources[0];
  } else if (selectedSource) {
    selectedSource = currentSources.find((s) => s.id === selectedSource.id) || currentSources[0] || null;
  }
  renderApiSources();
  updateShareableDocs();
}

function selectApiSource(id) {
  selectedSource = currentSources.find((s) => s.id === id) || null;
  renderApiSources();
  updateShareableDocs();
}

function renderApiSources() {
  const container = document.getElementById('apiSourcesContainer');
  if (currentSources.length === 0) {
    container.innerHTML = `<div class="text-xs text-slate-500">No partner API keys created yet.</div>`;
    return;
  }

  container.innerHTML = currentSources.map((s) => {
    const isSelected = selectedSource && selectedSource.id === s.id;
    return `
      <div onclick="selectApiSource(${s.id})"
        class="p-3.5 rounded-xl border cursor-pointer transition ${
          isSelected
            ? 'bg-indigo-950/30 border-indigo-500/60'
            : 'bg-slate-950/70 border-slate-800 hover:border-slate-700'
        }">
        <div class="flex items-center justify-between">
          <div class="font-semibold text-sm text-white flex items-center gap-2">
            <span>${escapeHtml(s.name)}</span>
            <span class="px-2 py-0.5 text-[10px] rounded bg-slate-800 text-cyan-400 mono">List #${escapeHtml(s.default_list_id)}</span>
          </div>
          <span class="text-xs font-semibold text-slate-400">${s.leads_count} leads</span>
        </div>

        <div class="mt-2 flex items-center justify-between gap-2 bg-slate-900 border border-slate-800 rounded-lg px-2.5 py-1.5">
          <code class="text-xs text-emerald-400 truncate select-all">${escapeHtml(s.api_key)}</code>
          <button onclick="event.stopPropagation(); navigator.clipboard.writeText('${escapeHtml(s.api_key)}'); showToast('API Key copied!', 'success')"
            class="text-xs text-slate-400 hover:text-white px-1.5" title="Copy API Key">
            <i class="fa-regular fa-copy"></i>
          </button>
        </div>

        <div class="mt-2.5 flex items-center justify-between text-xs">
          <label onclick="event.stopPropagation()" class="flex items-center gap-1.5 text-slate-300 cursor-pointer">
            <input type="checkbox" ${s.auto_push_vici ? 'checked' : ''}
              onchange="toggleSourceAutoPush(${s.id}, this.checked)"
              class="rounded bg-slate-900 border-slate-700 text-indigo-500" />
            <span>Auto-Push to VICIdial on Intake</span>
          </label>
          <button onclick="event.stopPropagation(); deleteApiSource(${s.id})"
            class="text-slate-500 hover:text-rose-400">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

async function createApiSource(e) {
  e.preventDefault();
  const name = document.getElementById('newSourceName').value.trim();
  const default_list_id = document.getElementById('newSourceListId').value.trim() || '999';
  const auto_push_vici = document.getElementById('newSourceAutoPush').checked;

  const res = await fetch('/api/sources', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, default_list_id, auto_push_vici })
  });
  const data = await res.json();
  if (data.success) {
    document.getElementById('newSourceName').value = '';
    selectedSource = data.source;
    showToast(`Created API Key for ${data.source.name}`, 'success');
    await Promise.all([loadApiSources(), loadDashboardStats()]);
  }
}

async function toggleSourceAutoPush(id, checked) {
  await fetch(`/api/sources/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auto_push_vici: checked })
  });
  showToast(`Auto-push to VICIdial ${checked ? 'enabled' : 'disabled'} for this source.`, 'info');
  await loadApiSources();
}

async function deleteApiSource(id) {
  await fetch(`/api/sources/${id}`, { method: 'DELETE' });
  if (selectedSource && selectedSource.id === id) selectedSource = null;
  showToast('API Key removed', 'info');
  await Promise.all([loadApiSources(), loadDashboardStats()]);
}

function updateShareableDocs() {
  const baseUrl = window.location.origin;
  const endpoint = `${baseUrl}/api/v1/leads/intake`;
  const apiKey = selectedSource ? selectedSource.api_key : 'vcrm_live_YOUR_API_KEY';
  const listId = selectedSource ? selectedSource.default_list_id : '101';

  document.getElementById('docEndpointUrl').textContent = endpoint;
  document.getElementById('docSelectedKey').textContent = apiKey;

  const curlCode = `curl -X POST "${endpoint}" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${apiKey}" \\
  -d '{
    "first_name": "Jordan",
    "last_name": "Belfort",
    "phone_number": "2125550199",
    "email": "jordan@stratton.io",
    "company": "Stratton Oakmont",
    "city": "New York",
    "state": "NY",
    "list_id": "${listId}",
    "vendor_lead_code": "PARTNER-772",
    "notes": "Requested immediate callback"
  }'`;

  const getCode = `${endpoint}?api_key=${apiKey}&first_name=Jordan&last_name=Belfort&phone_number=2125550199&company=Stratton&list_id=${listId}`;

  document.getElementById('docCurlSnippet').textContent = curlCode;
  document.getElementById('docGetSnippet').textContent = getCode;
}

function copyShareableSpec() {
  const endpoint = document.getElementById('docEndpointUrl').textContent;
  const key = document.getElementById('docSelectedKey').textContent;
  const curl = document.getElementById('docCurlSnippet').textContent;
  const getUrl = document.getElementById('docGetSnippet').textContent;

  const specText = `=== LEAD INTAKE API SPECIFICATION ===
Endpoint URL: ${endpoint}
Method: POST (application/json or form-urlencoded) or GET
Authentication Header: X-API-Key: ${key} (or query param ?api_key=${key})

Required Field:
- phone_number (or phone)

Optional Fields:
- first_name, last_name (or full_name)
- email, company, city, state, postal_code
- vendor_lead_code, list_id, notes

Example cURL Request:
${curl}

Example GET Webhook URL:
${getUrl}
`;

  navigator.clipboard.writeText(specText);
  showToast('Complete Partner API Specification copied to clipboard!', 'success');
}

async function sendTestPartnerLead() {
  if (!selectedSource) {
    showToast('Create or select a Partner API Key first.', 'error');
    return;
  }

  const sampleNames = [
    ['Rachel', 'Zane', 'Pearson Specter', 'New York', 'NY'],
    ['Harvey', 'Specter', 'Specter Litt', 'New York', 'NY'],
    ['Kendall', 'Roy', 'Waystar Royco', 'Austin', 'TX'],
    ['Claire', 'Underwood', 'House Foundation', 'Washington', 'DC']
  ];
  const pick = sampleNames[Math.floor(Math.random() * sampleNames.length)];
  const randPhone = '312555' + Math.floor(1000 + Math.random() * 8999);

  const res = await fetch('/api/v1/leads/intake', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': selectedSource.api_key
    },
    body: JSON.stringify({
      first_name: pick[0],
      last_name: pick[1],
      phone_number: randPhone,
      company: pick[2],
      city: pick[3],
      state: pick[4],
      email: `${pick[0].toLowerCase()}@example.com`,
      vendor_lead_code: 'TEST-' + Math.floor(100 + Math.random() * 900),
      notes: `Live test lead received via ${selectedSource.name}`
    })
  });

  const data = await res.json();
  const box = document.getElementById('testApiResponseBox');
  box.classList.remove('hidden');
  box.textContent = JSON.stringify(data, null, 2);

  if (data.success) {
    showToast(`Test lead #${data.crm_lead_id} received via API!`, 'success');
    await Promise.all([loadLeads(), loadApiSources(), loadDashboardStats()]);
  } else {
    showToast(data.error || 'Intake failed', 'error');
  }
}

// ============================================================================
// TAB 3: VICIDIAL SETTINGS & CONNECTION TEST
// ============================================================================
async function loadViciSettings() {
  const res = await fetch('/api/settings');
  const { settings } = await res.json();
  if (!settings) return;

  document.getElementById('cfg_vici_simulation_mode').checked = settings.vici_simulation_mode === 'true';
  document.getElementById('cfg_vici_server_url').value = settings.vici_server_url || '';
  document.getElementById('cfg_vici_non_agent_path').value = settings.vici_non_agent_path || '/vicidial/non_agent_api.php';
  document.getElementById('cfg_vici_agent_path').value = settings.vici_agent_path || '/agc/api.php';
  document.getElementById('cfg_vici_api_user').value = settings.vici_api_user || '';
  document.getElementById('cfg_vici_api_pass').value = settings.vici_api_pass || '';
  document.getElementById('cfg_vici_default_list_id').value = settings.vici_default_list_id || '999';
  document.getElementById('cfg_vici_default_phone_code').value = settings.vici_default_phone_code || '1';
  document.getElementById('cfg_vici_duplicate_check').value = settings.vici_duplicate_check || 'DUPLIVE';
  document.getElementById('cfg_vici_source').value = settings.vici_source || 'ViciCRM';
}

async function saveViciSettings(e) {
  e.preventDefault();
  const payload = {
    vici_simulation_mode: document.getElementById('cfg_vici_simulation_mode').checked ? 'true' : 'false',
    vici_server_url: document.getElementById('cfg_vici_server_url').value.trim(),
    vici_non_agent_path: document.getElementById('cfg_vici_non_agent_path').value.trim(),
    vici_agent_path: document.getElementById('cfg_vici_agent_path').value.trim(),
    vici_api_user: document.getElementById('cfg_vici_api_user').value.trim(),
    vici_api_pass: document.getElementById('cfg_vici_api_pass').value.trim(),
    vici_default_list_id: document.getElementById('cfg_vici_default_list_id').value.trim(),
    vici_default_phone_code: document.getElementById('cfg_vici_default_phone_code').value.trim(),
    vici_duplicate_check: document.getElementById('cfg_vici_duplicate_check').value,
    vici_source: document.getElementById('cfg_vici_source').value.trim(),
    vici_default_agent_user: document.getElementById('activeAgentInput').value.trim()
  };

  await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  showToast('VICIdial configuration saved!', 'success');
  await loadDashboardStats();
}

async function testViciServerConnection() {
  const banner = document.getElementById('viciTestBanner');
  banner.classList.remove('hidden');
  banner.className = 'rounded-xl p-3.5 text-xs mono bg-slate-950 border border-slate-700 text-slate-300';
  banner.textContent = 'Testing connection to VICIdial Non-Agent API...';

  const res = await fetch('/api/vici/test', { method: 'POST' });
  const data = await res.json();

  if (data.success) {
    banner.className = 'rounded-xl p-3.5 text-xs mono bg-emerald-950/60 border border-emerald-500/40 text-emerald-300';
    banner.innerHTML = `<div class="font-bold mb-1">✓ CONNECTION SUCCESSFUL</div><div>Response: ${escapeHtml(data.response)}</div><div class="text-[11px] text-slate-400 mt-1">URL: ${escapeHtml(data.request_url)}</div>`;
  } else {
    banner.className = 'rounded-xl p-3.5 text-xs mono bg-rose-950/60 border border-rose-500/40 text-rose-300';
    banner.innerHTML = `<div class="font-bold mb-1">✗ CONNECTION FAILED</div><div>${escapeHtml(data.response)}</div><div class="text-[11px] text-slate-400 mt-1">URL: ${escapeHtml(data.request_url)}</div>`;
  }
}

// ============================================================================
// TAB 4: VICIDIAL API LOGS
// ============================================================================
async function loadViciLogs() {
  const res = await fetch('/api/vici/logs');
  const data = await res.json();
  const logs = data.logs || [];
  const tbody = document.getElementById('viciLogsBody');

  if (logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-8 text-center text-slate-500">No VICIdial API requests logged yet. Click "Dial in VICI" or "Push to VICI" on any lead to test.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map((l) => `
    <tr class="hover:bg-slate-800/30">
      <td class="py-3 px-4 text-slate-400 whitespace-nowrap mono">${escapeHtml(l.created_at)}</td>
      <td class="py-3 px-4">
        <span class="px-2 py-0.5 rounded text-[11px] font-semibold mono ${
          l.success ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'
        }">${escapeHtml(l.action_type)}</span>
      </td>
      <td class="py-3 px-4 text-slate-300 whitespace-nowrap">
        ${l.lead_id ? `#${l.lead_id} (${escapeHtml([l.first_name, l.last_name].filter(Boolean).join(' '))} - ${escapeHtml(l.phone_number || '')})` : '-'}
      </td>
      <td class="py-3 px-4 space-y-1">
        <div class="mono text-slate-200 font-medium">${escapeHtml(l.response_text)}</div>
        <div class="mono text-[11px] text-slate-500 break-all">${escapeHtml(l.request_url)}</div>
      </td>
    </tr>
  `).join('');
}
