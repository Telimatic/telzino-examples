/**
 * TELZINO OUTBOUND CALL AUTOMATION
 * ---------------------------------
 * 1. TRIGGER SIDE: when a new row in "Bookings" has the required fields filled
 *    in and hasn't been called yet, POSTs to Telzino's Trigger Outbound Call
 *    endpoint. The call is queued with this script's own Web App URL as the
 *    callback_url.
 * 2. RESULT SIDE: Telzino POSTs the terminal call result back to doPost(),
 *    which looks the row up by Booking ID (sent as metadata) and writes back
 *    Call Status, Disposition, Call Timestamp, Notes, Recording URL, and
 *    Transcript.
 *
 * ============================== ONE-TIME SETUP ==============================
 * 1. Create a new blank Google Sheet (go to sheets.new).
 * 2. Extensions > Apps Script on that sheet, delete the stub code, paste this
 *    whole file in, and Save.
 * 3. Run setupSheet() once (pick it in the function dropdown, click Run,
 *    approve the permissions prompt). This creates the "Bookings" tab with all
 *    14 columns.
 * 4. Project Settings > Script Properties — add:
 *      TELZINO_CLIENT_ID       your Auth0 client ID from the Telzino dashboard
 *      TELZINO_CLIENT_SECRET   your Auth0 client secret
 *      TELZINO_AGENT_ID        the UUID of the agent that should place calls
 *      CALLBACK_SECRET         any random string you make up (webhook auth)
 * 5. Deploy > New deployment > type "Web app".
 *      - Execute as: Me
 *      - Who has access: Anyone
 *    Copy the deployment URL (ends in /exec).
 * 6. Back in Script Properties add:
 *      WEB_APP_URL   the /exec URL from step 5, with ?secret=<CALLBACK_SECRET> appended
 *                    e.g. https://script.google.com/macros/s/AKfycb.../exec?secret=abc123
 * 7. Set your calling hours in CONFIG.CALLING_WINDOW below (timezone, start/end
 *    time, allowed weekdays). Rows created outside this window are held and
 *    dialed automatically when the window next opens.
 * 8. Run installTrigger() once. This installs both the onEdit trigger and the
 *    15-minute window sweep.
 * 9. (Optional) Run createBookingForm() once to generate a Google Form whose
 *    submissions auto-create Bookings rows and place calls. The shareable form
 *    link is printed to the execution log (View > Logs), or reprint it later
 *    with showFormLinks().
 * 10. Done. Rows added by hand OR via the form get called during the window
 *     (or held until it opens), and results populate back into the sheet.
 *
 * Re-run step 3 as "New deployment" (not "manage deployments > edit") any
 * time you change doPost's logic, and update WEB_APP_URL if the URL changes.
 * ==============================================================================
 */

// ===================== CONFIG =====================
const CONFIG = {
  SHEET_NAME: 'Bookings', // change to your actual tab name

  TELZINO_API_BASE: 'https://api.telzino.com',
  TELZINO_TOKEN_URL: 'https://api.telzino.com/oauth/token',
  TELZINO_AUDIENCE: 'https://api.telzino.com/',

  COLUMNS: {
    BOOKING_ID: 'A',
    CUSTOMER_NAME: 'B',
    PHONE_NUMBER: 'C',
    APPOINTMENT_DATE: 'D',
    APPOINTMENT_TIME: 'E',
    SERVICE_TYPE: 'F',
    LOCATION: 'G',
    CALL_STATUS: 'H',
    CALL_ID: 'I',
    DISPOSITION: 'J',
    CALL_TIMESTAMP: 'K',
    NOTES: 'L',
    RECORDING_URL: 'M',
    TRANSCRIPT: 'N',
  },

  REQUIRED_FIELDS: ['BOOKING_ID', 'CUSTOMER_NAME', 'PHONE_NUMBER', 'APPOINTMENT_DATE', 'APPOINTMENT_TIME'],

  // Status written to rows that are ready but outside the calling window.
  // The time-driven sweep picks these up once the window opens.
  STATUS_WAITING: 'Waiting for Window',

  // Status written to rows whose date/time cell is stored as ambiguous text.
  // The call is held until the cell is corrected.
  STATUS_NEEDS_REVIEW: 'Check Date/Time',

  // Call Status values that mean "not yet called" — safe to (re)evaluate.
  // STATUS_WAITING and STATUS_NEEDS_REVIEW are included so held rows get
  // re-checked by the sweep and, once corrected, dial automatically.
  STATUS_PENDING_VALUES: ['', 'Pending', 'Waiting for Window', 'Check Date/Time'],

  DEFAULT_COUNTRY_CODE: '1', // used when converting bare 10-digit US numbers to E.164

  // ---- CALLING WINDOW ----
  // Calls only go out inside this window. Anything ready outside it is held
  // as STATUS_WAITING and dialed automatically when the window next opens.
  CALLING_WINDOW: {
    TIMEZONE: 'America/New_York', // IANA tz the window hours are expressed in
    START: { hour: 9, minute: 0 },  // 9:00 AM — inclusive
    END: { hour: 20, minute: 0 },   // 8:00 PM — exclusive
    // ISO weekdays allowed: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat, 7=Sun
    ALLOWED_DAYS: [1, 2, 3, 4, 5],
  },

  // Safety cap so a big backlog opening at 9:00 AM doesn't blow past Apps
  // Script's ~6-min execution limit. Leftovers wait for the next sweep.
  MAX_CALLS_PER_SWEEP: 40,

  // Google Form question titles. These must stay in sync between the form
  // (created by createBookingForm) and the onFormSubmit reader.
  FORM_FIELDS: {
    BOOKING_ID: 'Booking ID (optional — leave blank to auto-generate)',
    CUSTOMER_NAME: 'Customer Name',
    PHONE_NUMBER: 'Phone Number',
    APPOINTMENT_DATE: 'Appointment Date',
    APPOINTMENT_TIME: 'Appointment Time',
    SERVICE_TYPE: 'Service Type',
    LOCATION: 'Location',
  },
};
// ====================================================

function colLetterToIndex(letter) {
  return letter.toUpperCase().charCodeAt(0) - 64;
}

function getProp(key) {
  const val = PropertiesService.getScriptProperties().getProperty(key);
  if (!val) throw new Error('Missing Script Property: ' + key + '. Set it under Project Settings > Script Properties.');
  return val;
}

// ------------------- SETUP -------------------

/**
 * Run this ONCE (before installTrigger) to create the "Bookings" tab with the
 * correct 14 headers. Safe to re-run — it won't duplicate an existing tab or
 * overwrite existing data rows, it only ensures the header row is present.
 */
function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    // If the default "Sheet1" is empty and unused, remove it for tidiness
    const def = ss.getSheetByName('Sheet1');
    if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
  }

  const headers = [
    'Booking ID', 'Customer Name', 'Phone Number', 'Appointment Date',
    'Appointment Time', 'Service Type', 'Location', 'Call Status', 'Call ID',
    'Disposition', 'Call Timestamp', 'Notes', 'Recording URL', 'Transcript',
  ];

  const headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, headers.length);

  Logger.log('Sheet "' + CONFIG.SHEET_NAME + '" is ready with ' + headers.length + ' columns.');
}

function installTrigger() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Clear existing triggers for both handlers to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    const fn = t.getHandlerFunction();
    if (fn === 'onRowEdit' || fn === 'windowSweep') ScriptApp.deleteTrigger(t);
  });

  // Fires on every edit — dials immediately if inside the window, else holds.
  ScriptApp.newTrigger('onRowEdit').forSpreadsheet(ss).onEdit().create();

  // Fires every 15 min — dials any held rows once the window is open.
  ScriptApp.newTrigger('windowSweep').timeBased().everyMinutes(15).create();

  Logger.log('Installed onEdit trigger + 15-minute window sweep.');
}

// ------------------- FORM INTAKE -------------------

/**
 * Run this ONCE to create the "Telzino Booking Intake" Google Form and wire
 * its submissions to this sheet. Each submission is written as a Bookings row
 * and then run through the normal validate/window/dial pipeline.
 *
 * Re-running is safe: if a form already exists (FORM_ID stored), it won't make
 * a second one — delete the FORM_ID script property first if you want a fresh
 * form. The form's shareable link is printed to the execution log (and you can
 * reprint it any time with showFormLinks()).
 */
function createBookingForm() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('FORM_ID')) {
    Logger.log('A form already exists. Run showFormLinks() to see its links, ' +
      'or delete the FORM_ID script property to create a new one.');
    return showFormLinks();
  }

  const F = CONFIG.FORM_FIELDS;
  const form = FormApp.create('Telzino Booking Intake');
  form.setDescription('Submit a booking to schedule an automated confirmation call.');
  form.setCollectEmail(false);

  form.addTextItem().setTitle(F.BOOKING_ID);
  form.addTextItem().setTitle(F.CUSTOMER_NAME).setRequired(true);
  form.addTextItem().setTitle(F.PHONE_NUMBER).setRequired(true)
    .setHelpText('Include area code, e.g. 727-555-1234');
  form.addDateItem().setTitle(F.APPOINTMENT_DATE).setIncludesYear(true).setRequired(true);
  form.addTimeItem().setTitle(F.APPOINTMENT_TIME).setRequired(true)
    .setHelpText('Use the time picker so AM/PM is unambiguous.');
  form.addTextItem().setTitle(F.SERVICE_TYPE);
  form.addTextItem().setTitle(F.LOCATION);

  // Clear any prior form-submit triggers, then wire this form to onFormSubmit.
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();

  props.setProperty('FORM_ID', form.getId());

  Logger.log('Form created.\n\nShare this link to collect bookings:\n' +
    form.getPublishedUrl() + '\n\nEdit the form here:\n' + form.getEditUrl());
}

/** Reprints the form links to the execution log. */
function showFormLinks() {
  const formId = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!formId) {
    Logger.log('No form yet. Run createBookingForm() first.');
    return;
  }
  const form = FormApp.openById(formId);
  Logger.log('Share link (collect bookings):\n' + form.getPublishedUrl() +
    '\n\nEdit link:\n' + form.getEditUrl());
}

/**
 * Fires on every form submission. Maps the response into a Bookings row, then
 * hands off to the same pipeline a manually typed row goes through.
 */
function onFormSubmit(e) {
  try {
    const F = CONFIG.FORM_FIELDS;
    const answers = readFormAnswers(e);

    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
    const lock = LockService.getScriptLock();
    lock.waitLock(30000); // serialize appends so concurrent submits don't collide

    let newRow;
    try {
      newRow = sheet.getLastRow() + 1;

      let bookingId = String(answers[F.BOOKING_ID] || '').trim();
      if (!bookingId) bookingId = nextBookingId();
      writeCell(sheet, newRow, 'BOOKING_ID', bookingId);
      writeCell(sheet, newRow, 'CUSTOMER_NAME', answers[F.CUSTOMER_NAME] || '');
      writeCell(sheet, newRow, 'PHONE_NUMBER', answers[F.PHONE_NUMBER] || '');

      // Write date and time as real date/time values so downstream formatting
      // and validation treat them as trusted (not ambiguous text).
      const dateVal = parseFormDate(answers[F.APPOINTMENT_DATE]);
      const dateCell = sheet.getRange(newRow, colLetterToIndex(CONFIG.COLUMNS.APPOINTMENT_DATE));
      if (dateVal) dateCell.setValue(dateVal).setNumberFormat('yyyy-mm-dd');
      else dateCell.setValue(answers[F.APPOINTMENT_DATE] || '');

      const timeVal = parseFormTime(answers[F.APPOINTMENT_TIME]);
      const timeCell = sheet.getRange(newRow, colLetterToIndex(CONFIG.COLUMNS.APPOINTMENT_TIME));
      if (timeVal) timeCell.setValue(timeVal).setNumberFormat('h:mm am/pm');
      else timeCell.setValue(answers[F.APPOINTMENT_TIME] || '');

      writeCell(sheet, newRow, 'SERVICE_TYPE', answers[F.SERVICE_TYPE] || '');
      writeCell(sheet, newRow, 'LOCATION', answers[F.LOCATION] || '');
      SpreadsheetApp.flush();
    } finally {
      lock.releaseLock();
    }

    // Same path as a hand-typed row: validate, honor the window, dial or hold.
    processRowIfReady(sheet, newRow);
  } catch (err) {
    Logger.log('onFormSubmit error: ' + err);
  }
}

/** Normalizes a submit event into a {questionTitle: answer} object. */
function readFormAnswers(e) {
  const answers = {};
  if (e && e.response && e.response.getItemResponses) {
    // Form-bound trigger (what createBookingForm sets up)
    e.response.getItemResponses().forEach(ir => {
      answers[ir.getItem().getTitle()] = ir.getResponse();
    });
  } else if (e && e.namedValues) {
    // Fallback for a spreadsheet-bound form-submit trigger
    Object.keys(e.namedValues).forEach(k => { answers[k] = e.namedValues[k][0]; });
  }
  return answers;
}

/** Sequential APT-#### id, persisted in Script Properties. */
function nextBookingId() {
  const props = PropertiesService.getScriptProperties();
  const n = parseInt(props.getProperty('BOOKING_COUNTER') || '4000', 10) + 1;
  props.setProperty('BOOKING_COUNTER', String(n));
  return 'APT-' + n;
}

/** Parses a form Date answer ("yyyy-MM-dd", or M/D/Y) into a Date, or null. */
function parseFormDate(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  const s = String(value).trim();
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** Parses a form Time answer ("HH:mm" or "h:mm AM/PM") into a Date, or null. */
function parseFormTime(value) {
  if (!value) return null;
  if (Object.prototype.toString.call(value) === '[object Date]') return value;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?\s?m\.?)?$/i);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const mer = m[3] ? m[3].toLowerCase() : null;
  if (mer) {
    if (mer.charAt(0) === 'p' && hh < 12) hh += 12;
    if (mer.charAt(0) === 'a' && hh === 12) hh = 0;
  }
  return new Date(1970, 0, 1, hh, mm);
}

// ------------------- TRIGGER SIDE -------------------

function onRowEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== CONFIG.SHEET_NAME) return;
    const row = e.range.getRow();
    if (row === 1) return;
    processRowIfReady(sheet, row);
  } catch (err) {
    Logger.log('onRowEdit error: ' + err);
  }
}

// Optional: run manually or on a time-driven trigger to catch bulk pastes
// (onEdit only fires once per paste action regardless of how many rows it touched).
function sweepAllRows() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  for (let row = 2; row <= lastRow; row++) {
    processRowIfReady(sheet, row);
  }
}

/**
 * Returns true if the current moment falls inside CONFIG.CALLING_WINDOW,
 * evaluated in the window's own timezone.
 */
function isWithinCallingWindow() {
  const w = CONFIG.CALLING_WINDOW;
  const now = new Date();

  const isoDay = parseInt(Utilities.formatDate(now, w.TIMEZONE, 'u'), 10); // 1=Mon..7=Sun
  if (w.ALLOWED_DAYS.indexOf(isoDay) === -1) return false;

  const hour = parseInt(Utilities.formatDate(now, w.TIMEZONE, 'H'), 10);
  const minute = parseInt(Utilities.formatDate(now, w.TIMEZONE, 'm'), 10);
  const minutesNow = hour * 60 + minute;

  const startMinutes = w.START.hour * 60 + w.START.minute;
  const endMinutes = w.END.hour * 60 + w.END.minute;

  return minutesNow >= startMinutes && minutesNow < endMinutes;
}

/**
 * Time-driven trigger. When the window is open, dials any rows that are
 * ready and waiting (held from off-hours, or missed by onEdit on bulk paste).
 * Capped at MAX_CALLS_PER_SWEEP per run so a large backlog can't exceed the
 * Apps Script execution limit — leftovers are picked up on the next sweep.
 */
function windowSweep() {
  if (!isWithinCallingWindow()) return;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  let callsMade = 0;

  for (let row = 2; row <= lastRow; row++) {
    if (callsMade >= CONFIG.MAX_CALLS_PER_SWEEP) break;
    const before = sheet.getRange(row, colLetterToIndex(CONFIG.COLUMNS.CALL_STATUS)).getValue();
    processRowIfReady(sheet, row);
    const after = sheet.getRange(row, colLetterToIndex(CONFIG.COLUMNS.CALL_STATUS)).getValue();
    // Count only rows that actually transitioned into a dialed state
    if (before !== after && String(after) === 'queued') callsMade++;
  }

  if (callsMade > 0) Logger.log('windowSweep dialed ' + callsMade + ' held row(s).');
}

function processRowIfReady(sheet, row) {
  const rowData = readRow(sheet, row);
  if (!isRowReadyToCall(rowData)) return;

  // Catch date/time cells stored as ambiguous text before a call goes out.
  const issues = validateAppointment(rowData);
  if (issues.length) {
    if (String(rowData.CALL_STATUS || '') !== CONFIG.STATUS_NEEDS_REVIEW) {
      writeCell(sheet, row, 'CALL_STATUS', CONFIG.STATUS_NEEDS_REVIEW);
      writeCell(sheet, row, 'NOTES', issues.join(' '));
    }
    return;
  }

  let toNumber;
  try {
    toNumber = toE164(rowData.PHONE_NUMBER);
  } catch (err) {
    writeCell(sheet, row, 'CALL_STATUS', 'Invalid Number');
    writeCell(sheet, row, 'NOTES', err.message);
    return;
  }

  // Outside the calling window: hold the row and let the sweep dial it later.
  if (!isWithinCallingWindow()) {
    if (String(rowData.CALL_STATUS || '') !== CONFIG.STATUS_WAITING) {
      writeCell(sheet, row, 'CALL_STATUS', CONFIG.STATUS_WAITING);
    }
    return;
  }

  // Mark in-progress immediately to prevent double-firing on rapid edits
  writeCell(sheet, row, 'CALL_STATUS', 'queued');

  try {
    const result = triggerOutboundCall({
      toNumber: toNumber,
      bookingId: String(rowData.BOOKING_ID),
      customerName: rowData.CUSTOMER_NAME,
      appointmentDate: rowData.APPOINTMENT_DATE,
      appointmentTime: rowData.APPOINTMENT_TIME,
      serviceType: rowData.SERVICE_TYPE,
      location: rowData.LOCATION,
    });

    writeCell(sheet, row, 'CALL_ID', result.id || '');
    writeCell(sheet, row, 'CALL_STATUS', result.status || 'queued');
  } catch (err) {
    writeCell(sheet, row, 'CALL_STATUS', 'Trigger Failed');
    writeCell(sheet, row, 'NOTES', 'Error: ' + err.message);
    Logger.log('Call trigger failed for row ' + row + ': ' + err);
  }
}

function readRow(sheet, row) {
  const data = {};
  Object.keys(CONFIG.COLUMNS).forEach(key => {
    data[key] = sheet.getRange(row, colLetterToIndex(CONFIG.COLUMNS[key])).getValue();
  });
  return data;
}

function writeCell(sheet, row, columnKey, value) {
  sheet.getRange(row, colLetterToIndex(CONFIG.COLUMNS[columnKey])).setValue(value);
}

function isRowReadyToCall(rowData) {
  const requiredFilled = CONFIG.REQUIRED_FIELDS.every(key => {
    const val = rowData[key];
    return val !== '' && val !== null && val !== undefined;
  });
  if (!requiredFilled) return false;
  return CONFIG.STATUS_PENDING_VALUES.includes(String(rowData.CALL_STATUS || ''));
}

/**
 * Converts common US phone formats to E.164. Extend this if you're calling
 * outside the US — Telzino rejects anything not already in E.164 with a 400.
 */
function toE164(rawNumber) {
  const digits = String(rawNumber).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.length === 10) return '+' + CONFIG.DEFAULT_COUNTRY_CODE + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  throw new Error('Could not convert "' + rawNumber + '" to E.164 format.');
}

// ------------------- TELZINO API CLIENT -------------------

function getAccessToken() {
  const props = PropertiesService.getScriptProperties();
  const cachedToken = props.getProperty('TELZINO_ACCESS_TOKEN');
  const cachedExpiry = props.getProperty('TELZINO_TOKEN_EXPIRY');

  if (cachedToken && cachedExpiry && Number(cachedExpiry) > Date.now() + 60000) {
    return cachedToken;
  }

  const response = UrlFetchApp.fetch(CONFIG.TELZINO_TOKEN_URL, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      client_id: getProp('TELZINO_CLIENT_ID'),
      client_secret: getProp('TELZINO_CLIENT_SECRET'),
      audience: CONFIG.TELZINO_AUDIENCE,
      grant_type: 'client_credentials',
    }),
    muteHttpExceptions: true,
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('Telzino auth failed: ' + response.getContentText());
  }

  const body = JSON.parse(response.getContentText());
  props.setProperty('TELZINO_ACCESS_TOKEN', body.access_token);
  props.setProperty('TELZINO_TOKEN_EXPIRY', String(Date.now() + body.expires_in * 1000));
  return body.access_token;
}

function telzinoAuthedFetch(path, options) {
  options = options || {};
  options.headers = options.headers || {};
  options.headers['Authorization'] = 'Bearer ' + getAccessToken();
  options.muteHttpExceptions = true;
  return UrlFetchApp.fetch(CONFIG.TELZINO_API_BASE + path, options);
}

function triggerOutboundCall(call) {
  const agentId = getProp('TELZINO_AGENT_ID');
  const webAppUrl = getProp('WEB_APP_URL');

  const callContext =
    'You are calling ' + call.customerName + ' to confirm their ' +
    (call.serviceType ? call.serviceType + ' ' : '') + 'appointment on ' +
    formatDateForSpeech(call.appointmentDate) + ' at ' + formatTimeForSpeech(call.appointmentTime) +
    (call.location ? ' at ' + call.location : '') + '.';

  const payload = {
    to_number: call.toNumber,
    call_context: callContext,
    metadata: { booking_id: call.bookingId },
    callback_url: webAppUrl,
  };

  const response = telzinoAuthedFetch('/v1/agents/' + agentId + '/outbound-calls', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  });

  const code = response.getResponseCode();
  if (code !== 202) {
    throw new Error('Telzino returned ' + code + ': ' + response.getContentText());
  }
  return JSON.parse(response.getContentText());
}

/**
 * Returns an array of human-readable problems with the appointment date/time.
 * Empty array means the row is safe to dial.
 *
 * A properly formatted date or time cell reads as a JS Date object — that's
 * the trusted case. Anything that comes back as a string or number was stored
 * as plain text, which is where ambiguity creeps in (e.g. a bare "5:00" that
 * could be AM or PM). Text is allowed ONLY when it's unambiguous on its own:
 * a time that explicitly states AM/PM, or a clearly date-shaped string.
 */
function validateAppointment(rowData) {
  const issues = [];

  const t = rowData.APPOINTMENT_TIME;
  if (Object.prototype.toString.call(t) !== '[object Date]') {
    const ts = String(t).trim();
    const hasMeridiem = /\b[ap]\.?\s?m\.?\b/i.test(ts);
    if (!hasMeridiem) {
      issues.push('Appointment Time "' + ts + '" is stored as text without AM/PM — ' +
        'enter it as a real time (e.g. 17:00) or add AM/PM (e.g. 5:00 PM).');
    }
  }

  const d = rowData.APPOINTMENT_DATE;
  if (Object.prototype.toString.call(d) !== '[object Date]') {
    const ds = String(d).trim();
    const numericDate = /\d{1,4}[\/\-.]\d{1,2}([\/\-.]\d{1,4})?/.test(ds);
    const namedMonth = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(ds);
    if (!numericDate && !namedMonth) {
      issues.push('Appointment Date "' + ds + '" is stored as text and is not a recognizable date — ' +
        'enter it as a real date (e.g. 2026-08-14).');
    }
  }

  return issues;
}

function formatDateForSpeech(value) {
  // A date-only cell reads as a JS Date at midnight in the sheet's timezone.
  // Format it in that same timezone so it doesn't shift a day.
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(value, tz, "EEEE, MMMM d, yyyy");
  }
  return String(value);
}

function formatTimeForSpeech(value) {
  // A time-only cell reads as a JS Date anchored to 1899-12-30. We render ONLY
  // the time portion so that phantom date never gets spoken.
  if (Object.prototype.toString.call(value) === '[object Date]') {
    const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    return Utilities.formatDate(value, tz, "h:mm a");
  }
  return String(value);
}

/**
 * Pages through List Call Logs to find the entry matching a transcript_id,
 * so we can pull recording_url and full transcript_text (not included in
 * the result webhook itself).
 */
function fetchCallLog(transcriptId, maxPages) {
  const agentId = getProp('TELZINO_AGENT_ID');
  maxPages = maxPages || 5;

  for (let page = 1; page <= maxPages; page++) {
    const response = telzinoAuthedFetch(
      '/v1/agents/' + agentId + '/call-logs?page=' + page + '&limit=100',
      { method: 'get' }
    );
    if (response.getResponseCode() !== 200) break;

    const body = JSON.parse(response.getContentText());
    const match = body.data.find(log => log.id === transcriptId);
    if (match) return match;
    if (!body.pagination.hasNext) break;
  }
  return null;
}

// ------------------- RESULT SIDE (WEBHOOK RECEIVER) -------------------

/**
 * Handles the Telzino result webhook. Deploy this project as a Web App
 * (Anyone can access) and set that /exec URL — with ?secret=... appended —
 * as WEB_APP_URL in Script Properties; triggerOutboundCall() passes it as
 * callback_url on every call.
 */
function doPost(e) {
  try {
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('CALLBACK_SECRET');
    const providedSecret = e.parameter.secret;
    if (expectedSecret && providedSecret !== expectedSecret) {
      return ContentService.createTextOutput('Forbidden').setMimeType(ContentService.MimeType.TEXT);
    }

    const result = JSON.parse(e.postData.contents);
    handleCallResult(result);

    return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
  } catch (err) {
    Logger.log('doPost error: ' + err);
    // Still return 200 so Telzino doesn't consider the delivery failed for
    // reasons on our end; the call record remains the source of truth.
    return ContentService.createTextOutput('Error logged').setMimeType(ContentService.MimeType.TEXT);
  }
}

function handleCallResult(result) {
  const bookingId = result.metadata && result.metadata.booking_id;
  if (!bookingId) {
    Logger.log('Webhook missing metadata.booking_id, cannot match a row: ' + JSON.stringify(result));
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEET_NAME);
  const row = findRowByBookingId(sheet, bookingId);
  if (!row) {
    Logger.log('No row found for booking_id ' + bookingId);
    return;
  }

  writeCell(sheet, row, 'CALL_STATUS', result.status);
  writeCell(sheet, row, 'CALL_TIMESTAMP', result.ended_at ? new Date(result.ended_at) : new Date());

  if (result.status === 'completed') {
    writeCell(sheet, row, 'DISPOSITION', extractSentiment(result.summary_text) || 'Completed');
    writeCell(sheet, row, 'NOTES', result.summary_text || '');

    if (result.transcript_id) {
      const log = fetchCallLog(result.transcript_id);
      if (log) {
        writeCell(sheet, row, 'RECORDING_URL', log.recording_url || '');
        writeCell(sheet, row, 'TRANSCRIPT', log.transcript_text || '');
      } else {
        // Log lookup can lag slightly behind the webhook; store the id so
        // you can still retrieve it later via the Call Logs API.
        writeCell(sheet, row, 'TRANSCRIPT', 'transcript_id: ' + result.transcript_id);
      }
    }
  } else {
    // no_answer / busy / failed
    const reason = result.error || (result.sip_status_code ? 'SIP ' + result.sip_status_code : result.status);
    writeCell(sheet, row, 'DISPOSITION', reason);
    writeCell(sheet, row, 'NOTES', result.error || '');
  }
}

function findRowByBookingId(sheet, bookingId) {
  const colIndex = colLetterToIndex(CONFIG.COLUMNS.BOOKING_ID);
  const lastRow = sheet.getLastRow();
  const values = sheet.getRange(2, colIndex, lastRow - 1, 1).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(bookingId)) return i + 2;
  }
  return null;
}

function extractSentiment(summaryText) {
  if (!summaryText) return null;
  const match = summaryText.match(/\*\*Sentiment:\*\*\s*(Positive|Neutral|Negative)/i);
  return match ? match[1] : null;
}
