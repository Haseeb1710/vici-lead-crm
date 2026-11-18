# ViciLead CRM — Partner Lead Intake API & VICIdial Bridge

A full-stack Node.js + SQLite CRM built to accept incoming leads from external partners/vendors via API Keys and dial or push those leads directly into **VICIdial**.

## Quick Start

```powershell
cd e:\vici-crm
npm start
```

Open **http://localhost:3456** in your browser.

---

## Key Features

1. **Shareable Partner Lead Intake API (`/api/v1/leads/intake`)**
   - Generate unique API keys (`vcrm_live_...`) per vendor, traffic source, or landing page.
   - Assign each API key a default **VICIdial List ID** and toggle **Auto-Push to VICIdial on Intake**.
   - Supports both `POST` (JSON or form-urlencoded) and `GET` query-string webhooks.
   - Built-in **Shareable Partner Specification Generator** with one-click copyable `cURL` & webhook URLs, plus a live test button.

2. **VICIdial Non-Agent API Integration (`add_lead`)**
   - Automatically or manually push leads into VICIdial lists (`/vicidial/non_agent_api.php?function=add_lead`).
   - Supports duplicate checking (`DUPLIVE`, `DUPLIST`, `DUPCAMP`, `DUPSYS`) and instant hopper injection (`add_to_hopper=Y`).
   - Captures and stores the returned `vici_lead_id` and raw VICIdial response.

3. **VICIdial Agent Click-to-Dial (`external_dial`) & Call Controls**
   - Enter your logged-in VICIdial Agent ID in the top bar and click **Dial in VICI** on any lead to trigger an immediate call on your VICIdial agent screen (`/agc/api.php?function=external_dial`).
   - Top bar includes quick Agent controls for **Ready (Resume)**, **Pause**, and **Hangup** (`external_pause`, `external_hangup`).

4. **2-Way VICIdial Disposition Webhook (`/api/v1/vici/webhook`)**
   - Paste the provided Dispo Call URL into your VICIdial Campaign settings to automatically sync call outcomes (`SALE`, `CALLBACK`, `DNC`, etc.) back to the CRM.
