/**
 * devinstein.me/schedule — Apps Script backend
 *
 * Handles two endpoints exposed by the deployed Web App URL:
 *   GET  ?action=availability&date=YYYY-MM-DD&days=N&tz=...
 *   POST  body: action=book&name=...&email=...&purpose=...&start=...&end=...
 *               &visitor_tz=...&turnstile_token=...
 *
 * See brain/reference/schedule_spec.md for full contract.
 *
 * SETUP (one-time, in script.google.com):
 *   1. Paste this file as "backend.gs" in a new project.
 *   2. Resources → Advanced Google Services → enable "Calendar API".
 *   3. Project Settings → Script Properties → add:
 *        TURNSTILE_SECRET = <your Cloudflare Turnstile secret key>
 *        ALLOWED_ORIGIN   = https://devinstein.me  (optional; "*" if omitted)
 *   4. File → Project Properties → set timezone to America/Denver.
 *   5. Deploy → New deployment → Web App
 *        Execute as: Me   |   Who has access: Anyone
 *      Copy the /exec URL into schedule.html SCHEDULER_ENDPOINT constant.
 */

// ─── CONFIG ─────────────────────────────────────────────────────────
const CONFIG = {
  CALENDAR_ID: 'primary',
  NOTIFICATION_EMAIL: 'devin.stein@colostate.edu',  // CSU
  WORK_DAYS: [1, 2, 3, 4, 5],            // Mon..Fri (0=Sun, 6=Sat)
  WORK_HOURS_MT: [8, 17],                // [start, end_exclusive] in MT
  WORK_TZ: 'America/Denver',
  SLOT_MIN: 30,
  BUFFER_MIN: 15,
  HORIZON_DAYS: 28,
  MIN_LEAD_HOURS: 4,
  // Active Web App /exec URL — used to build self-service cancel links in emails.
  // Stays constant across "New version" redeploys of the same deployment.
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbwb3Sq3wgiCI_u5Of6lHH_zAtyJszipDh0iA3YU_-Cpi93uQLXEP-ospVvKBoKmzAVxBA/exec',
  MEETING_TITLE: name => `Office Hours: ${name} ↔ Devin Stein`,
};

// ─── ENTRY POINTS ───────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'availability') return jsonResponse(handleAvailability(e.parameter));
    if (action === 'cancel') return handleCancel(e.parameter);  // returns an HTML page, not JSON
    return jsonResponse({ok: false, error: 'unknown_action'});
  } catch (err) {
    console.error('doGet error:', err);
    return jsonResponse({ok: false, error: 'internal'});
  }
}

function doPost(e) {
  try {
    const params = e && e.parameter ? e.parameter : {};
    const action = params.action || '';
    if (action === 'book') return jsonResponse(handleBook(params));
    return jsonResponse({ok: false, error: 'unknown_action'});
  } catch (err) {
    console.error('doPost error:', err);
    return jsonResponse({ok: false, error: 'internal'});
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── AVAILABILITY ───────────────────────────────────────────────────
function handleAvailability(params) {
  const date = params.date;
  const days = Math.max(1, Math.min(7, parseInt(params.days || '1', 10)));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return {ok: false, error: 'validation_error'};

  const allSlots = [];
  for (let i = 0; i < days; i++) {
    const d = addDaysMt(date, i);
    if (!isWorkday(d)) continue;
    const canonical = generateCanonicalSlots(d);
    const free = canonical.filter(s => isSlotBookable(s));
    free.forEach(s => allSlots.push({start: s.start.toISOString(), end: s.end.toISOString()}));
  }
  return {ok: true, slots: allSlots, generated_at: new Date().toISOString()};
}

// ─── BOOKING ────────────────────────────────────────────────────────
function handleBook(params) {
  // 1. Verify Turnstile token first — cheapest gate.
  const turnstileOk = verifyTurnstile(params.turnstile_token, params);
  if (!turnstileOk) return {ok: false, error: 'spam_check_failed'};

  // 2. Validate inputs.
  const {name, email, purpose, start, end, visitor_tz} = params;
  if (!name || !email || !start || !end) return {ok: false, error: 'validation_error'};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {ok: false, error: 'validation_error'};

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return {ok: false, error: 'validation_error'};

  // 3. Check the slot is canonical (not arbitrary times) and within bounds.
  if (!isCanonicalSlot(startDate, endDate)) return {ok: false, error: 'validation_error'};
  if (!isSlotBookable({start: startDate, end: endDate})) return {ok: false, error: 'slot_taken'};

  // 4. Create the event with auto Meet link via the Advanced Calendar Service.
  let event;
  try {
    event = createCalendarEvent({name, email, purpose, startDate, endDate, visitor_tz});
  } catch (err) {
    console.error('createCalendarEvent failed:', err);
    return {ok: false, error: 'internal'};
  }
  const meetUrl = extractMeetUrl(event);

  // 5. Send confirmation emails.
  try {
    sendVisitorConfirmation({name, email, startDate, endDate, visitor_tz, meetUrl, eventId: event.id});
    sendDevinNotification({name, email, purpose, startDate, endDate, visitor_tz, meetUrl, eventId: event.id});
  } catch (err) {
    console.error('email send failed (event still created):', err);
    // Don't fail the booking — event exists, emails can be re-triggered manually.
  }

  return {ok: true, event_id: event.id, meet_url: meetUrl || '', cancel_url: cancelUrl(event.id)};
}

// ─── SLOT LOGIC ─────────────────────────────────────────────────────
function generateCanonicalSlots(ymdMt) {
  // Returns 12 canonical slot {start, end} pairs in UTC for the MT-local date ymdMt.
  // Slot N starts at 08:00 + (N-1) × 45min in WORK_TZ; ends 30min later.
  const [Y, M, D] = ymdMt.split('-').map(Number);
  const slots = [];
  for (let i = 0; i < 12; i++) {
    const startMin = (CONFIG.WORK_HOURS_MT[0] * 60) + i * (CONFIG.SLOT_MIN + CONFIG.BUFFER_MIN);
    const endMin = startMin + CONFIG.SLOT_MIN;
    if (endMin > CONFIG.WORK_HOURS_MT[1] * 60) break;
    const startH = Math.floor(startMin / 60), startM = startMin % 60;
    const endH = Math.floor(endMin / 60), endM = endMin % 60;
    slots.push({
      start: dateInMt(Y, M, D, startH, startM),
      end: dateInMt(Y, M, D, endH, endM),
    });
  }
  return slots;
}

function dateInMt(Y, M, D, h, m) {
  // Build a Date that equals h:m on Y-M-D in WORK_TZ (handles DST).
  // Strategy: format an ISO-like string interpreted in WORK_TZ via Utilities.parseDate.
  const isoLocal = Utilities.formatString('%04d-%02d-%02dT%02d:%02d:00', Y, M, D, h, m);
  return Utilities.parseDate(isoLocal, CONFIG.WORK_TZ, "yyyy-MM-dd'T'HH:mm:ss");
}

function isWorkday(ymdMt) {
  const [Y, M, D] = ymdMt.split('-').map(Number);
  // Use a noon-MT anchor to dodge DST edge cases.
  const anchor = dateInMt(Y, M, D, 12, 0);
  const dayName = Utilities.formatDate(anchor, CONFIG.WORK_TZ, 'EEE');
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(dayName);
  return CONFIG.WORK_DAYS.includes(dow);
}

function addDaysMt(ymdMt, n) {
  const [Y, M, D] = ymdMt.split('-').map(Number);
  const anchor = dateInMt(Y, M, D, 12, 0);
  anchor.setDate(anchor.getDate() + n);
  return Utilities.formatDate(anchor, CONFIG.WORK_TZ, 'yyyy-MM-dd');
}

function isSlotBookable(slot) {
  // Filter: future enough (lead time), within horizon, no busy-marked conflicts.
  const now = new Date();
  const leadCutoff = new Date(now.getTime() + CONFIG.MIN_LEAD_HOURS * 3600 * 1000);
  if (slot.start < leadCutoff) return false;
  const horizonEnd = new Date(now.getTime() + CONFIG.HORIZON_DAYS * 86400 * 1000);
  if (slot.start > horizonEnd) return false;
  // Freebusy API respects each event's "Show me as" setting:
  // events marked Free (default for all-day events, holidays) do NOT block;
  // only events marked Busy (default for timed meetings) block.
  const calId = CONFIG.CALENDAR_ID;
  const result = Calendar.Freebusy.query({
    timeMin: slot.start.toISOString(),
    timeMax: slot.end.toISOString(),
    items: [{id: calId}],
  });
  const busy = ((result.calendars || {})[calId] || {}).busy || [];
  return busy.length === 0;
}

function isCanonicalSlot(startDate, endDate) {
  // Verify start matches one of the 12 canonical slots for that day's MT date.
  const ymd = Utilities.formatDate(startDate, CONFIG.WORK_TZ, 'yyyy-MM-dd');
  if (!isWorkday(ymd)) return false;
  const canonical = generateCanonicalSlots(ymd);
  const match = canonical.find(s =>
    Math.abs(s.start.getTime() - startDate.getTime()) < 1000 &&
    Math.abs(s.end.getTime() - endDate.getTime()) < 1000
  );
  return !!match;
}

// ─── CALENDAR EVENT (Advanced Calendar Service) ────────────────────
function createCalendarEvent({name, email, purpose, startDate, endDate, visitor_tz}) {
  const requestId = Utilities.getUuid();
  const event = {
    summary: CONFIG.MEETING_TITLE(name),
    description: [
      'Booked via devinstein.me/schedule',
      '',
      `Visitor: ${name} <${email}>`,
      `Visitor TZ: ${visitor_tz || 'unknown'}`,
      '',
      'Purpose:',
      purpose ? purpose : '(none provided)',
    ].join('\n'),
    start: {dateTime: startDate.toISOString(), timeZone: 'UTC'},
    end: {dateTime: endDate.toISOString(), timeZone: 'UTC'},
    attendees: [{email}],
    conferenceData: {
      createRequest: {
        requestId: requestId,
        conferenceSolutionKey: {type: 'hangoutsMeet'},
      },
    },
  };
  const calId = CONFIG.CALENDAR_ID === 'primary' ? 'primary' : CONFIG.CALENDAR_ID;
  // sendUpdates=all → calendar invite to attendee
  return Calendar.Events.insert(event, calId, {
    conferenceDataVersion: 1,
    sendUpdates: 'all',
  });
}

function extractMeetUrl(event) {
  if (!event || !event.conferenceData || !event.conferenceData.entryPoints) return '';
  const video = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
  return video ? video.uri : '';
}

// ─── EMAIL ──────────────────────────────────────────────────────────
function sendVisitorConfirmation({name, email, startDate, endDate, visitor_tz, meetUrl, eventId}) {
  const visitorTime = Utilities.formatDate(startDate, visitor_tz || 'UTC', "EEEE, MMMM d 'at' h:mm a z");
  const mtTime = Utilities.formatDate(startDate, CONFIG.WORK_TZ, "h:mm a z");
  const subject = `Office hours confirmed — ${Utilities.formatDate(startDate, visitor_tz || 'UTC', "MMM d, h:mm a")}`;
  const body = [
    `Hi ${name.split(' ')[0]},`,
    '',
    `You're booked for office hours with Devin Stein on ${visitorTime} (${mtTime}, Mountain Time).`,
    '',
    meetUrl ? `Google Meet: ${meetUrl}` : 'Meeting details are in the calendar invite.',
    '',
    'A calendar invite is in your inbox.',
    '',
    `Need to cancel? ${cancelUrl(eventId)}`,
    'To reschedule, cancel and book a new time — or just reply to this email.',
    '',
    '— devinstein.me/schedule',
  ].join('\n');
  GmailApp.sendEmail(email, subject, body, {
    name: 'Devin Stein',
    replyTo: CONFIG.NOTIFICATION_EMAIL,
  });
}

function sendDevinNotification({name, email, purpose, startDate, endDate, visitor_tz, meetUrl, eventId}) {
  const mtTime = Utilities.formatDate(startDate, CONFIG.WORK_TZ, "EEE MMM d 'at' h:mm a z");
  const subject = `New booking — ${name} on ${Utilities.formatDate(startDate, CONFIG.WORK_TZ, "MMM d, h:mm a")}`;
  const body = [
    `${name} <${email}>`,
    `${mtTime}  (30 min)`,
    `Visitor TZ: ${visitor_tz || 'unknown'}`,
    '',
    'Purpose:',
    purpose ? purpose : '(none provided)',
    '',
    meetUrl ? `Meet: ${meetUrl}` : '',
    `Event ID: ${eventId}`,
  ].join('\n');
  GmailApp.sendEmail(CONFIG.NOTIFICATION_EMAIL, subject, body);
}

// ─── TURNSTILE ──────────────────────────────────────────────────────
function verifyTurnstile(token, params) {
  if (!token) {
    console.warn('Turnstile: empty token submitted');
    return false;
  }
  const secret = PropertiesService.getScriptProperties().getProperty('TURNSTILE_SECRET');
  if (!secret) {
    console.warn('TURNSTILE_SECRET not set in Script Properties — refusing booking.');
    return false;
  }
  try {
    const response = UrlFetchApp.fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'post',
        payload: {secret: secret, response: token},
        muteHttpExceptions: true,
      }
    );
    const result = JSON.parse(response.getContentText());
    if (!result.success) {
      // Cloudflare returns an `error-codes` array on failure. Common values:
      //   invalid-input-secret      — TURNSTILE_SECRET wrong
      //   invalid-input-response    — token expired / replayed / from mismatched widget
      //   timeout-or-duplicate      — token already used (single-use) or expired
      //   bad-request               — malformed siteverify request
      // Also useful: result.hostname (where the token was issued).
      console.warn('Turnstile rejected. Full response:', JSON.stringify(result));
    }
    return !!result.success;
  } catch (err) {
    console.error('Turnstile verify error:', err);
    return false;
  }
}

// ─── CANCELLATION (self-service magic link) ─────────────────────────
function getCancelSecret() {
  // Lazily provision a signing secret on first use — no manual setup needed.
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('CANCEL_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('CANCEL_SECRET', secret);
  }
  return secret;
}

function cancelToken(eventId) {
  // HMAC-SHA256(eventId) → web-safe base64, unpadded. Stateless capability token.
  const sig = Utilities.computeHmacSha256Signature(eventId, getCancelSecret());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function cancelUrl(eventId) {
  return CONFIG.WEB_APP_URL +
    '?action=cancel&id=' + encodeURIComponent(eventId) +
    '&t=' + encodeURIComponent(cancelToken(eventId));
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function handleCancel(params) {
  const eventId = params.id || '';
  const token = params.t || '';
  if (!eventId || !token) {
    return cancelPage('Invalid link',
      'This cancellation link is incomplete. To cancel, email ' + CONFIG.NOTIFICATION_EMAIL + '.', false);
  }
  // Verify the signed token before touching the calendar.
  if (!constantTimeEquals(token, cancelToken(eventId))) {
    return cancelPage('Invalid link',
      "This cancellation link isn't valid. To cancel, email " + CONFIG.NOTIFICATION_EMAIL + '.', false);
  }
  // Look up the event; if it's gone or already cancelled, say so gracefully.
  let event;
  try {
    event = Calendar.Events.get(CONFIG.CALENDAR_ID, eventId);
  } catch (err) {
    return cancelPage('Already cancelled',
      'This meeting is no longer on the calendar — it looks like it was already cancelled.', true);
  }
  if (!event || event.status === 'cancelled') {
    return cancelPage('Already cancelled', 'This meeting has already been cancelled.', true);
  }
  const whenMt = (event.start && event.start.dateTime)
    ? Utilities.formatDate(new Date(event.start.dateTime), CONFIG.WORK_TZ, "EEEE, MMMM d 'at' h:mm a z")
    : 'your scheduled time';
  // Remove it; sendUpdates:'all' emails the attendee AND notifies the organizer.
  try {
    Calendar.Events.remove(CONFIG.CALENDAR_ID, eventId, {sendUpdates: 'all'});
  } catch (err) {
    console.error('cancel remove failed:', err);
    return cancelPage('Something went wrong',
      'We could not cancel automatically. Please email ' + CONFIG.NOTIFICATION_EMAIL + ' and we will take care of it.', false);
  }
  try { sendCancellationNotice(event, whenMt); } catch (err) { console.error('cancel notice failed:', err); }
  return cancelPage('Meeting cancelled',
    'Your office-hours meeting on ' + whenMt + ' has been cancelled, and the time is open again. ' +
    'Need a different time? Book at devinstein.me/schedule.', true);
}

function sendCancellationNotice(event, whenMt) {
  const attendee = (event.attendees && event.attendees[0]) ? event.attendees[0].email : '(unknown)';
  const who = (event.summary || '').replace(/^Office Hours:\s*/, '').replace(/\s*↔.*$/, '') || attendee;
  const subject = `Cancelled — ${who} on ${whenMt}`;
  const body = [
    `${who} <${attendee}> cancelled their office-hours meeting.`,
    '',
    `Was: ${whenMt}`,
    '',
    'The slot is open again. (Cancelled via the link in their confirmation email.)',
  ].join('\n');
  GmailApp.sendEmail(CONFIG.NOTIFICATION_EMAIL, subject, body);
}

function cancelPage(heading, message, ok) {
  const accent = ok ? '#1a6b5a' : '#b5704f';
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<title>' + heading + ' — devinstein.me</title>' +
    '<style>' +
    'body{margin:0;background:#f4f2ec;color:#2c2a26;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem;box-sizing:border-box}' +
    '.card{background:#fff;max-width:440px;width:100%;padding:2.2rem 2rem;border-radius:14px;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.08);border-left:3px solid ' + accent + '}' +
    'h1{font-family:Georgia,"Times New Roman",serif;font-size:1.5rem;font-weight:500;margin:0 0 .8rem;color:#1f1d1a}' +
    'p{font-size:.97rem;line-height:1.6;margin:0 0 1rem;color:#4a4742}' +
    'a{color:' + accent + ';text-decoration:none;border-bottom:1px solid rgba(26,107,90,.35)}' +
    '.foot{font-size:.8rem;color:#8a857c;margin-top:1.4rem;margin-bottom:0}' +
    '</style></head><body><div class="card">' +
    '<h1>' + heading + '</h1>' +
    '<p>' + message + '</p>' +
    '<p class="foot"><a href="https://devinstein.me/schedule.html">&larr; Back to scheduling</a></p>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle(heading + ' — devinstein.me');
}

// ─── CONFIG CHECK (run from editor to debug deployment state) ───────
function checkConfig() {
  console.log('=== SCRIPT PROPERTIES ===');
  const props = PropertiesService.getScriptProperties().getProperties();
  console.log('Keys present:', Object.keys(props));
  const secret = props.TURNSTILE_SECRET || '';
  console.log('TURNSTILE_SECRET present:', !!secret);
  console.log('TURNSTILE_SECRET length:', secret.length);
  if (secret) {
    console.log('TURNSTILE_SECRET fingerprint:',
      secret.substring(0, 4) + '...' + secret.substring(secret.length - 4));
  }

  console.log('=== CONFIG CONSTANTS ===');
  console.log('CALENDAR_ID:', CONFIG.CALENDAR_ID);
  console.log('NOTIFICATION_EMAIL:', CONFIG.NOTIFICATION_EMAIL);
  console.log('MIN_LEAD_HOURS:', CONFIG.MIN_LEAD_HOURS);
  console.log('Effective user:', Session.getEffectiveUser().getEmail());

  console.log('=== TURNSTILE TEST (deliberately-invalid token) ===');
  console.log('Expecting: "Turnstile rejected. Full response: {...error-codes...}"');
  const result = verifyTurnstile('test_invalid_token_to_force_a_clear_cloudflare_response');
  console.log('verifyTurnstile returned:', result, '(expected: false)');
}

// ─── SMOKE TEST (run from editor to sanity-check setup) ─────────────
function smokeTest() {
  // Test 2 days out so MIN_LEAD_HOURS doesn't filter every slot,
  // and so we hit a likely workday (skip today even if it's a weekend).
  let test = new Date();
  test.setDate(test.getDate() + 2);
  let ymd = Utilities.formatDate(test, CONFIG.WORK_TZ, 'yyyy-MM-dd');
  while (!isWorkday(ymd)) {
    test.setDate(test.getDate() + 1);
    ymd = Utilities.formatDate(test, CONFIG.WORK_TZ, 'yyyy-MM-dd');
  }
  console.log('Test date (MT):', ymd);
  console.log('Is workday:', isWorkday(ymd));
  const slots = generateCanonicalSlots(ymd);
  console.log('Generated', slots.length, 'canonical slots:');
  slots.forEach(s => console.log('  ',
    Utilities.formatDate(s.start, CONFIG.WORK_TZ, 'HH:mm'), '–',
    Utilities.formatDate(s.end, CONFIG.WORK_TZ, 'HH:mm'), 'MT'
  ));
  const free = slots.filter(s => isSlotBookable(s));
  console.log(free.length, 'slots are currently free on', ymd + '.');
}
