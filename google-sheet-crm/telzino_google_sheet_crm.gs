/**
 * Telzino Google Sheet CRM
 * Lets a Telzino voice agent read and update a Google Sheet during a live call.
 *
 * Actions (sent as ?action=... on the Web App URL):
 *   lookup         find a customer by caller ID, customer_id, job_number, or name
 *   create_ticket  open a support ticket on the customer's job
 *   reschedule     move a job's appointment to a new date and arrival window
 *   log_call       write an after-call summary to the Call Log tab
 *   ping           connection test
 *
 * Functions you run by hand from the editor:
 *   setupSheet       builds the Customers and Call Log tabs with the right columns
 *   loadSampleData   fills the Customers tab with fictional demo customers (optional)
 *   clearHighlights  removes the blue/yellow highlights after a demo
 *
 * Color key on the Customers tab:
 *   light blue row  = the agent just looked this customer up
 *   yellow cells    = the agent just changed these values
 *
 * Optional security: add a Script Property named CALLBACK_SECRET. When it is set,
 * every request must include ?secret=YOUR_SECRET in the URL or it is rejected.
 */

const CONFIG = {
  CUSTOMER_TAB: 'Customers',
  LOG_TAB: 'Call Log',
  DEBUG_TAB: 'Debug',
  TIMEZONE: 'America/New_York',   // match File > Settings and the Apps Script project time zone
  LOOKUP_COLOR: '#DCEBFF',
  UPDATE_COLOR: '#FFF2B3',
  HEADER_COLOR: '#1F3A5F',
  DEBUG: true,                    // keeps the last 50 raw requests on a Debug tab; set to false in production
  FIRST_TICKET_NUMBER: 5500
};

const HEADERS = [
  'Customer ID', 'First Name', 'Last Name', 'Phone', 'Email', 'Service Address', 'City', 'ZIP',
  'Preferred Contact', 'Job #', 'Service Type', 'Job Description', 'Job Status', 'Appointment Date',
  'Arrival Window', 'Assigned Tech', 'Quote Amount', 'Balance Due', 'Payment Status', 'Warranty Ends',
  'Last Ticket #', 'Ticket Date', 'Ticket Status', 'Ticket Summary', 'Notes', 'Last AI Activity'
];

/* ---------------- Menu and one-time setup ---------------- */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Telzino')
    .addItem('Set up sheet', 'setupSheet')
    .addItem('Load sample data', 'loadSampleData')
    .addItem('Clear highlights', 'clearHighlights')
    .addToUi();
}

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(CONFIG.TIMEZONE);

  let sh = ss.getSheetByName(CONFIG.CUSTOMER_TAB);
  if (!sh) {
    sh = ss.getSheets()[0];
    if (sh.getLastRow() > 0 && sh.getName() !== CONFIG.CUSTOMER_TAB) sh = ss.insertSheet(CONFIG.CUSTOMER_TAB, 0);
    else sh.setName(CONFIG.CUSTOMER_TAB);
  }
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  formatCustomerTab_(sh);

  let log = ss.getSheetByName(CONFIG.LOG_TAB);
  if (!log) {
    log = ss.insertSheet(CONFIG.LOG_TAB);
    log.appendRow(['Timestamp', 'Caller Number', 'Customer', 'Action', 'Details', 'Call ID', 'Duration (sec)']);
    log.setFrozenRows(1);
    log.getRange(1, 1, 1, 7).setBackground(CONFIG.HEADER_COLOR).setFontColor('#FFFFFF').setFontWeight('bold');
    log.setColumnWidth(1, 170);
    log.setColumnWidth(5, 520);
    log.getRange('E:E').setWrap(true);
  }
  ss.setActiveSheet(sh);
}

function formatCustomerTab_(sh) {
  const lastCol = sh.getLastColumn();
  const lastRow = Math.max(sh.getLastRow(), 1);
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  sh.getRange(1, 1, lastRow, lastCol).setVerticalAlignment('middle');
  sh.getRange(1, 1, 1, lastCol).setBackground(CONFIG.HEADER_COLOR).setFontColor('#FFFFFF').setFontWeight('bold');
  sh.getRange('N:N').setNumberFormat('yyyy-mm-dd');
  sh.getRange('T:T').setNumberFormat('yyyy-mm-dd');
  sh.getRange('V:V').setNumberFormat('yyyy-mm-dd');
  sh.autoResizeColumns(1, lastCol);
  for (let c = 1; c <= lastCol; c++) {
    if (sh.getColumnWidth(c) > 300) {
      sh.setColumnWidth(c, 300);
      sh.getRange(1, c, lastRow, 1).setWrap(true);
    }
  }
}

function loadSampleData() {
  setupSheet();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CUSTOMER_TAB);
  if (sh.getLastRow() > 1) {
    SpreadsheetApp.getActiveSpreadsheet().toast('The Customers tab already has data. Sample data was not added.', 'Telzino', 8);
    return;
  }
  const d = n => isoDate_(new Date(Date.now() + n * 86400000));   // dates relative to today, so the demo never goes stale
  const rows = [
    ['C1001', 'Test', 'Caller', 'YOUR MOBILE NUMBER', 'you@example.com', '418 Bayshore Lane', 'Sarasota', '34231', 'Text',
      'J-2041', 'Carpentry', 'Rebuild back deck steps and replace two rotted deck boards', 'Scheduled', d(2), '9:00 AM - 11:00 AM',
      'Dave Russo', 1250, 250, 'Deposit Paid', '', 'T-5512', d(-6), 'Open',
      'Side gate latch has been sticking since the last visit; Dave will fix it during the deck appointment',
      'Friendly dog on property; use the side gate', ''],
    ['C1001', 'Test', 'Caller', 'YOUR MOBILE NUMBER', 'you@example.com', '418 Bayshore Lane', 'Sarasota', '34231', 'Text',
      'J-1987', 'Drywall', 'Patch and paint water-damaged ceiling in guest bathroom', 'Completed', d(-69), '',
      'Marcus Lee', 480, 0, 'Paid in Full', d(115), '', '', '', '', '', ''],
    ['C1002', 'Sarah', 'Mitchell', '555-555-0142', 'sarah.mitchell@example.com', '2207 Osprey Avenue', 'Sarasota', '34239', 'Call',
      'J-2045', 'Plumbing', 'Replace kitchen faucet and leaking shut-off valve', 'Scheduled', d(3), '1:00 PM - 3:00 PM',
      'Tony Alvarez', 385, 385, 'Due on Completion', '', '', '', '', '', 'Prefers afternoon appointments', ''],
    ['C1003', 'James', 'Carter', '555-555-0187', 'james.carter@example.com', '731 Palmetto Way', 'Sarasota', '34236', 'Email',
      'J-2038', 'Electrical', 'Install two customer-supplied ceiling fans in the bedrooms', 'In Progress', d(0), '8:00 AM - 10:00 AM',
      'Marcus Lee', 320, 320, 'Due on Completion', '', '', '', '', '', 'Tech is on site today', ''],
    ['C1004', 'Linda', 'Carter', '555-555-0163', 'linda.carter@example.com', '1904 Hibiscus Street', 'Bradenton', '34205', 'Call',
      'J-2049', 'Exterior', 'Pressure wash driveway, lanai and pool deck', 'Quoted', '', '',
      '', 425, 0, 'Awaiting Approval', '', '', '', '', '', 'Quote sent; waiting on customer approval', ''],
    ['C1005', 'Robert', 'Nguyen', '555-555-0119', 'robert.nguyen@example.com', '88 Coral Cove Drive', 'Venice', '34285', 'Text',
      'J-2033', 'Tile', 'Repair cracked shower tile and regrout the master bath', 'On Hold', '', '',
      'Tony Alvarez', 690, 345, 'Deposit Paid', '', 'T-5498', d(-11), 'Open',
      'Matching tile is backordered; supplier ETA is ' + speakDate_(d(10)), 'Call the customer as soon as the tile arrives', ''],
    ['C1006', 'Patricia', 'Gomez', '555-555-0174', 'patricia.gomez@example.com', '602 Magnolia Avenue', 'Sarasota', '34234', 'Call',
      'J-1962', 'Fencing', 'Replace 24 feet of storm-damaged privacy fence', 'Completed', d(-46), '',
      'Dave Russo', 1480, 480, 'Overdue (45 days)', d(319), '', '', '', '', 'Balance reminder emailed', ''],
    ['C1007', 'Thomas', 'Reed', '555-555-0158', 'thomas.reed@example.com', '1215 Bay Point Drive', 'Sarasota', '34233', 'Email',
      'J-1975', 'Doors', 'Install new pre-hung front entry door', 'Completed', d(-32), '',
      'Marcus Lee', 1150, 0, 'Paid in Full', d(333), 'T-5507', d(-8), 'Open - High Priority',
      'Front door sticks at the top and is hard to lock; customer is frustrated', 'Under warranty so the fix is no charge', ''],
    ['C1008', 'Kevin', 'Patel', '555-555-0196', 'kevin.patel@example.com', '2500 Fruitville Road (6 rental units)', 'Sarasota', '34237', 'Email',
      'J-2047', 'Maintenance', 'Quarterly gutter cleaning and smoke detector checks for all six units', 'Scheduled', d(1), '8:00 AM - 12:00 PM',
      'Dave Russo', 750, 750, 'Net 15 Invoice', '', '', '', '', '', 'VIP property manager; always offer the earliest slot', '']
  ];
  sh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
  formatCustomerTab_(sh);
  SpreadsheetApp.getActiveSpreadsheet().toast('Sample data loaded. Put your own mobile number in the two "Test Caller" rows.', 'Telzino', 10);
}

function clearHighlights() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CUSTOMER_TAB);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).setBackground(null);
  }
}

/* ---------------- Web app entry points ---------------- */

function doGet(e) { return respond_(handle_(e)); }
function doPost(e) { return respond_(handle_(e)); }

function handle_(e) {
  const p = collectParams_(e);
  const secret = PropertiesService.getScriptProperties().getProperty('CALLBACK_SECRET');
  const sent = e && e.parameter ? e.parameter.secret : '';
  if (secret && sent !== secret) return { ok: false, error: 'Unauthorized' };
  delete p.secret;
  return route_(p);
}

function collectParams_(e) {
  const p = {};
  if (e && e.parameter) Object.keys(e.parameter).forEach(k => { p[k] = e.parameter[k]; });
  const raw = (e && e.postData && e.postData.contents) || '';
  if (raw) {
    let body = null;
    try { body = JSON.parse(raw); } catch (err) { body = null; }
    if (body !== null) {
      mergeAny_(p, body);
    } else if (raw.indexOf('=') > -1) {
      raw.split('&').forEach(pair => {
        const i = pair.indexOf('=');
        if (i > 0) p[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      });
    }
  }
  // Ignore empty values and unfilled template placeholders such as {{caller_number}}
  Object.keys(p).forEach(k => {
    const v = p[k];
    if (v === null || v === undefined || (typeof v === 'string' && (v.trim() === '' || /^\{\{.*\}\}$/.test(v.trim())))) delete p[k];
  });
  if (CONFIG.DEBUG) debug_(e, raw, p);
  return p;
}

// Accepts {k:v}, [{key,value}], [{name,value}], and nested parameters/arguments/args/data/body
function mergeAny_(p, src) {
  if (src === null || src === undefined) return;
  if (typeof src === 'string') {
    try { mergeAny_(p, JSON.parse(src)); } catch (err) { /* plain string, ignore */ }
    return;
  }
  if (Array.isArray(src)) {
    src.forEach(item => {
      if (item && typeof item === 'object') {
        const k = item.key || item.name;
        if (k !== undefined && 'value' in item) p[k] = item.value;
        else mergeAny_(p, item);
      }
    });
    return;
  }
  if (typeof src === 'object') {
    const nested = ['parameters', 'arguments', 'args', 'data', 'body', 'input', 'params'];
    Object.keys(src).forEach(k => {
      const v = src[k];
      if (nested.indexOf(k) > -1 && v && (typeof v === 'object' || typeof v === 'string')) {
        mergeAny_(p, v);
      } else if (v === null || typeof v !== 'object') {
        if (k !== 'action' || !('action' in p)) p[k] = v;   // the URL's ?action= always wins
      }
    });
  }
}

function debug_(e, raw, parsed) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(CONFIG.DEBUG_TAB);
    if (!sh) {
      sh = ss.insertSheet(CONFIG.DEBUG_TAB);
      sh.appendRow(['Timestamp', 'Query String', 'Raw Body', 'Parsed Params']);
      sh.setFrozenRows(1);
    }
    const qs = String((e && e.queryString) || '').replace(/secret=[^&]*/g, 'secret=***');
    sh.appendRow([new Date(), qs, String(raw).slice(0, 5000), JSON.stringify(parsed).slice(0, 5000)]);
    const extra = sh.getLastRow() - 51;
    if (extra > 0) sh.deleteRows(2, extra);
  } catch (err) { /* never let logging break a call */ }
}

function route_(p) {
  const action = String(p.action || 'lookup').toLowerCase();
  try {
    switch (action) {
      case 'ping': return { ok: true, message: 'Connected to the customer sheet.', today: today_() };
      case 'lookup': return withLock_(() => lookup_(p));
      case 'create_ticket': return withLock_(() => createTicket_(p));
      case 'reschedule': return withLock_(() => reschedule_(p));
      case 'log_call': return withLock_(() => logCall_(p));
      default: return { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- Actions ---------------- */

function lookup_(p) {
  const t = table_();
  const found = findCustomerRows_(t, p);
  const groups = groupByCustomer_(found.hits);
  const ids = Object.keys(groups);

  if (!ids.length) {
    return { ok: true, found: false, today: today_(),
      message: 'No matching customer. Ask for the name on the account or the job number, then look up again.' };
  }
  if (ids.length > 1) {
    return { ok: true, found: true, multiple_matches: true, today: today_(),
      message: 'More than one customer matches. Ask which one (use first name and city), then look up again with customer_id.',
      candidates: ids.map(id => {
        const r = groups[id][0];
        return { customer_id: id, name: r['First Name'] + ' ' + r['Last Name'], city: r['City'] };
      }) };
  }

  const rows = groups[ids[0]];
  rows.forEach(r => paintRow_(t, r, CONFIG.LOOKUP_COLOR));
  stamp_(t, rows, 'Looked up (' + found.how + ')');
  log_(callerOf_(p) || rows[0]['Phone'], fullName_(rows[0]), 'Customer lookup',
    'Matched by ' + found.how.replace('_', ' '), p.call_id, '');
  return Object.assign({ ok: true, found: true, matched_by: found.how, today: today_() }, profile_(rows));
}

function createTicket_(p) {
  const summary = String(p.summary || p.issue || p.description || '').trim();
  if (!summary) return { ok: false, error: 'summary is required' };

  const t = table_();
  const rows = singleCustomer_(t, p);
  if (rows.error) return { ok: false, error: rows.error };

  const job = digits_(p.job_number || p.jobNumber || '');
  const target = (job && rows.find(r => digits_(r['Job #']) === job))
    || rows.find(r => /scheduled|in progress|on hold/i.test(String(r['Job Status'])))
    || rows[0];

  const ticketNo = nextTicket_(t);
  const status = /high|urgent/i.test(String(p.priority || '')) ? 'Open - High Priority' : 'Open';
  const changes = {
    'Last Ticket #': ticketNo,
    'Ticket Date': todayIso_(),
    'Ticket Status': status,
    'Ticket Summary': summary
  };
  setCells_(t, target, changes);
  paintRow_(t, target, CONFIG.LOOKUP_COLOR);
  paintCells_(t, target, Object.keys(changes), CONFIG.UPDATE_COLOR);
  stamp_(t, [target], 'Ticket ' + ticketNo + ' created');
  log_(callerOf_(p) || target['Phone'], fullName_(target), 'Ticket created',
    ticketNo + ' on job ' + target['Job #'] + ': ' + summary, p.call_id, '');

  return { ok: true, ticket_number: ticketNo, job_number: target['Job #'], status: status,
    message: 'Ticket ' + ticketNo + ' is open on job ' + target['Job #'] + '. The office will follow up.' };
}

function reschedule_(p) {
  const newDate = isoDate_(p.new_date || p.date);
  if (!newDate) return { ok: false, error: 'new_date is required, formatted YYYY-MM-DD' };

  const t = table_();
  const rows = singleCustomer_(t, p);
  if (rows.error) return { ok: false, error: rows.error };

  const job = digits_(p.job_number || p.jobNumber || '');
  let target = job ? rows.find(r => digits_(r['Job #']) === job) : null;
  if (!target) {
    const open = rows.filter(r => /scheduled|on hold|quoted/i.test(String(r['Job Status'])));
    if (open.length !== 1) {
      return { ok: false,
        error: open.length ? 'Customer has more than one open job; pass job_number.' : 'No open job to reschedule.',
        open_jobs: open.map(r => ({ job_number: r['Job #'], description: r['Job Description'] })) };
    }
    target = open[0];
  }

  const oldDate = speakDate_(target['Appointment Date']);
  const windowText = String(p.arrival_window || p.window || target['Arrival Window'] || '').trim();
  const priorNotes = String(target['Notes'] || '').trim();
  const note = 'Rescheduled by AI agent on ' + shortToday_() + (oldDate ? ' (was ' + oldDate + ')' : '') + '.'
    + (priorNotes ? ' ' + priorNotes : '');
  const changes = {
    'Appointment Date': newDate,
    'Arrival Window': windowText,
    'Job Status': 'Scheduled',
    'Notes': note
  };
  setCells_(t, target, changes);
  paintRow_(t, target, CONFIG.LOOKUP_COLOR);
  paintCells_(t, target, Object.keys(changes), CONFIG.UPDATE_COLOR);
  stamp_(t, [target], 'Job ' + target['Job #'] + ' rescheduled');
  log_(callerOf_(p) || target['Phone'], fullName_(target), 'Appointment rescheduled',
    'Job ' + target['Job #'] + ' moved' + (oldDate ? ' from ' + oldDate : '') + ' to ' + speakDate_(newDate)
      + (windowText ? ', ' + windowText : ''), p.call_id, '');

  return { ok: true, job_number: target['Job #'], new_appointment: speakDate_(newDate),
    arrival_window: windowText, technician: target['Assigned Tech'] || '',
    message: 'Job ' + target['Job #'] + ' is now scheduled for ' + speakDate_(newDate)
      + (windowText ? ', arrival window ' + windowText : '') + '.' };
}

function logCall_(p) {
  const caller = String(callerOf_(p) || '');
  const t = table_();
  const key = phone10_(caller);
  const rows = key ? t.rows.filter(r => phone10_(r['Phone']) === key) : [];
  const name = rows.length ? fullName_(rows[0]) : 'Unknown caller';
  if (rows.length) stamp_(t, rows, 'Call completed');
  log_(caller, name, 'Call summary', p.call_summary || p.summary_text || p.summary || '',
    p.call_id, p.call_duration || p.duration || '');
  return { ok: true };
}

/* ---------------- Sheet helpers ---------------- */

function table_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CUSTOMER_TAB);
  if (!sh) throw new Error('Missing tab: ' + CONFIG.CUSTOMER_TAB + '. Run setupSheet.');
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(h => String(h).trim());
  const rows = values.slice(1).map((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, c) => { o[h] = r[c]; });
    return o;
  }).filter(o => String(o['Customer ID']).trim() !== '');
  return { sh: sh, headers: headers, rows: rows };
}

function colIndex_(t, name) {
  const i = t.headers.indexOf(name);
  if (i < 0) throw new Error('Missing column: ' + name);
  return i + 1;
}

function setCells_(t, row, changes) {
  Object.keys(changes).forEach(k => {
    t.sh.getRange(row._row, colIndex_(t, k)).setValue(changes[k]);
    row[k] = changes[k];
  });
}

function paintRow_(t, row, color) {
  t.sh.getRange(row._row, 1, 1, t.headers.length).setBackground(color);
}

function paintCells_(t, row, cols, color) {
  cols.forEach(c => t.sh.getRange(row._row, colIndex_(t, c)).setBackground(color));
}

function stamp_(t, rows, text) {
  if (t.headers.indexOf('Last AI Activity') < 0) return;
  const c = colIndex_(t, 'Last AI Activity');
  const ts = Utilities.formatDate(new Date(), sheetTz_(), 'MMM d, h:mm a');
  rows.forEach(r => t.sh.getRange(r._row, c).setValue(ts + ': ' + text));
}

function log_(caller, name, action, details, callId, duration) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let log = ss.getSheetByName(CONFIG.LOG_TAB);
  if (!log) { setupSheet(); log = ss.getSheetByName(CONFIG.LOG_TAB); }
  log.appendRow([new Date(), String(caller || ''), name, action, String(details || ''), String(callId || ''), duration]);
  const r = log.getLastRow();
  log.getRange(r, 1, 1, 7).setBackground(CONFIG.UPDATE_COLOR);
  log.getRange(r, 1).setNumberFormat('MMM d, yyyy h:mm am/pm');
}

function nextTicket_(t) {
  let max = CONFIG.FIRST_TICKET_NUMBER;
  t.rows.forEach(r => {
    const n = parseInt(digits_(r['Last Ticket #']), 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return 'T-' + (max + 1);
}

/* ---------------- Matching ---------------- */

function callerOf_(p) {
  return p.caller_number || p.caller_phone || p.callerNumber || p.phone || '';
}

function findCustomerRows_(t, p) {
  const phone = phone10_(callerOf_(p));
  const cid = String(p.customer_id || p.customerId || '').trim().toUpperCase();
  const job = digits_(p.job_number || p.jobNumber || '');
  const name = String(p.name || p.customer_name || '').trim().toLowerCase();
  let first = String(p.first_name || '').trim().toLowerCase();
  let last = String(p.last_name || '').trim().toLowerCase();

  if (cid) {
    const hits = t.rows.filter(r => String(r['Customer ID']).toUpperCase() === cid);
    if (hits.length) return { hits: hits, how: 'customer_id' };
  }
  if (job) {
    const jobRows = t.rows.filter(r => digits_(r['Job #']) === job);
    if (jobRows.length) {
      const id = jobRows[0]['Customer ID'];
      return { hits: t.rows.filter(r => r['Customer ID'] === id), how: 'job_number' };
    }
  }
  if (phone) {
    const hits = t.rows.filter(r => phone10_(r['Phone']) === phone);
    if (hits.length) return { hits: hits, how: 'caller_id' };
  }
  if (name || first || last) {
    if (name && !last) {
      const parts = name.split(/\s+/);
      last = parts[parts.length - 1];
      if (!first && parts.length > 1) first = parts[0];
    }
    let hits = t.rows.filter(r => {
      const rf = String(r['First Name']).toLowerCase();
      const rl = String(r['Last Name']).toLowerCase();
      return (!last || rl === last) && (!first || rf === first);
    });
    if (!hits.length && name && name.split(/\s+/).length === 1) {
      hits = t.rows.filter(r => String(r['First Name']).toLowerCase() === name);
    }
    if (hits.length) return { hits: hits, how: 'name' };
  }
  return { hits: [], how: '' };
}

function singleCustomer_(t, p) {
  const groups = groupByCustomer_(findCustomerRows_(t, p).hits);
  const ids = Object.keys(groups);
  if (!ids.length) return { error: 'Customer not found. Look the customer up first.' };
  if (ids.length > 1) return { error: 'More than one customer matches; pass customer_id.' };
  return groups[ids[0]];
}

function groupByCustomer_(rows) {
  const map = {};
  rows.forEach(r => {
    const id = String(r['Customer ID']);
    (map[id] = map[id] || []).push(r);
  });
  return map;
}

function profile_(rows) {
  const r0 = rows[0];
  const jobs = rows.map(r => ({
    job_number: r['Job #'],
    service_type: r['Service Type'],
    description: r['Job Description'],
    status: r['Job Status'],
    appointment_date: speakDate_(r['Appointment Date']),
    arrival_window: r['Arrival Window'] || '',
    technician: r['Assigned Tech'] || '',
    quote: money_(r['Quote Amount']),
    balance_due: money_(r['Balance Due']),
    payment_status: r['Payment Status'] || '',
    warranty_ends: speakDate_(r['Warranty Ends']),
    notes: r['Notes'] || ''
  }));
  const tickets = rows
    .filter(r => String(r['Last Ticket #']).trim() !== '')
    .map(r => ({
      ticket_number: r['Last Ticket #'],
      job_number: r['Job #'],
      opened: speakDate_(r['Ticket Date']),
      status: r['Ticket Status'] || '',
      summary: r['Ticket Summary'] || '',
      sortKey: parseInt(digits_(r['Last Ticket #']), 10) || 0
    }))
    .sort((a, b) => b.sortKey - a.sortKey)
    .map(tk => { delete tk.sortKey; return tk; });
  const totalBalance = rows.reduce((s, r) => s + num_(r['Balance Due']), 0);

  return {
    customer: {
      customer_id: r0['Customer ID'],
      first_name: r0['First Name'],
      last_name: r0['Last Name'],
      phone: String(r0['Phone'] || ''),
      email: r0['Email'] || '',
      service_address: [r0['Service Address'], r0['City']].filter(String).join(', '),
      zip_for_verification: String(r0['ZIP'] || ''),
      preferred_contact: r0['Preferred Contact'] || ''
    },
    jobs: jobs,
    open_tickets: tickets.filter(tk => !/closed|resolved/i.test(String(tk.status))),
    total_balance_due: money_(totalBalance)
  };
}

/* ---------------- Formatting ---------------- */

function sheetTz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || CONFIG.TIMEZONE;
}

function today_() { return Utilities.formatDate(new Date(), sheetTz_(), 'EEEE, MMMM d, yyyy'); }
function todayIso_() { return Utilities.formatDate(new Date(), sheetTz_(), 'yyyy-MM-dd'); }
function shortToday_() { return Utilities.formatDate(new Date(), sheetTz_(), 'MMM d'); }

function toDate_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  d.setHours(12);
  return d;
}

function speakDate_(v) {
  const d = toDate_(v);
  return d ? Utilities.formatDate(d, sheetTz_(), 'EEEE, MMMM d, yyyy') : (v ? String(v) : '');
}

function isoDate_(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  const d = toDate_(v);
  return d ? Utilities.formatDate(d, sheetTz_(), 'yyyy-MM-dd') : '';
}

function digits_(v) { return String(v === null || v === undefined ? '' : v).replace(/\D/g, ''); }

function phone10_(v) {
  const d = digits_(v);
  return d.length >= 10 ? d.slice(-10) : '';
}

function num_(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function money_(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = num_(v);
  const s = n.toFixed(2).replace(/\.00$/, '');
  const parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + parts.join('.');
}

function fullName_(r) { return (r['First Name'] + ' ' + r['Last Name']).trim(); }
