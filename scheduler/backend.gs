/**
 * devinstein.me/schedule — Apps Script backend
 *
 * Booking is approval-gated: a POST creates a PENDING hold on the calendar
 * (no attendee, no Meet link yet) and emails Devin an Approve/Decline link.
 * Nothing is confirmed to the visitor until Devin approves.
 *
 * Endpoints exposed by the deployed Web App URL:
 *   GET  ?action=availability&date=YYYY-MM-DD&days=N&tz=...     → JSON
 *   GET  ?action=cancel&id=...&t=...                            → HTML page (visitor self-cancel)
 *   GET  ?action=approve&id=...&t=...                           → HTML page (Devin approves a request)
 *   GET  ?action=decline&id=...&t=...                           → HTML page (Devin declines a request)
 *   POST  body: action=book&name=...&email=...&purpose=...&start=...&end=...
 *               &visitor_tz=...&turnstile_token=...             → JSON {ok, status:'pending'}
 *
 * See brain/reference/schedule_spec.md for full contract.
 *
 * SETUP (one-time, in script.google.com):
 *   1. Paste this file as "backend.gs" in a new project.
 *   2. Resources → Advanced Google Services → enable "Calendar API".
 *   3. Project Settings → Script Properties → add:
 *        TURNSTILE_SECRET = <your Cloudflare Turnstile secret key>
 *        (CANCEL_SECRET is auto-provisioned on first use — signs cancel/approve/decline links.)
 *   4. File → Project Properties → set timezone to America/Denver.
 *   5. Deploy → New deployment → Web App
 *        Execute as: Me   |   Who has access: Anyone
 *      Copy the /exec URL into schedule.html SCHEDULER_ENDPOINT and CONFIG.WEB_APP_URL below.
 *   6. Run installPendingSweepTrigger() ONCE from the editor to schedule the hourly
 *      cleanup that expires unanswered pending holds (authorize when prompted).
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
  PENDING_TTL_HOURS: 48,                 // unanswered requests auto-expire after this
  // Active Web App /exec URL — used to build cancel/approve/decline links in emails.
  // Stays constant across "New version" redeploys of the same deployment.
  WEB_APP_URL: 'https://script.google.com/macros/s/AKfycbwb3Sq3wgiCI_u5Of6lHH_zAtyJszipDh0iA3YU_-Cpi93uQLXEP-ospVvKBoKmzAVxBA/exec',
  MEETING_TITLE: name => `Office Hours: ${name} ↔ Devin Stein`,
  PENDING_TITLE: name => `⏳ PENDING — Office Hours: ${name}`,
};

// ─── ENTRY POINTS ───────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'availability') return jsonResponse(handleAvailability(e.parameter));
    if (action === 'cancel') return handleCancel(e.parameter);    // returns an HTML page, not JSON
    if (action === 'approve') return confirmActionPage('approve', e.parameter);  // read-only confirm screen
    if (action === 'decline') return confirmActionPage('decline', e.parameter);  // read-only confirm screen
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
    // Mutating actions arrive via POST from the confirm screen (scanners don't POST).
    if (action === 'approve_confirm') return handleApprove(params);  // performs the action, returns HTML
    if (action === 'decline_confirm') return handleDecline(params);  // performs the action, returns HTML
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

// ─── BOOKING (creates a PENDING hold, not a confirmed event) ────────
function handleBook(params) {
  // 1. Verify Turnstile token first — cheapest gate.
  const turnstileOk = verifyTurnstile(params.turnstile_token, params);
  if (!turnstileOk) return {ok: false, error: 'spam_check_failed'};

  // 2. Validate inputs. Purpose is required — it's the context Devin uses to approve/decline.
  const {name, email, purpose, start, end, visitor_tz} = params;
  if (!name || !email || !purpose || !start || !end) return {ok: false, error: 'validation_error'};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return {ok: false, error: 'validation_error'};

  const startDate = new Date(start);
  const endDate = new Date(end);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return {ok: false, error: 'validation_error'};

  // 3. Check the slot is canonical (not arbitrary times) and within bounds.
  if (!isCanonicalSlot(startDate, endDate)) return {ok: false, error: 'validation_error'};

  // 4. Serialize the bookability re-check + hold insert so two simultaneous
  //    requests can't both pass the Freebusy check and grab the same slot.
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    return {ok: false, error: 'busy'};
  }
  let event;
  try {
    if (!isSlotBookable({start: startDate, end: endDate})) return {ok: false, error: 'slot_taken'};
    event = createPendingHold({name, email, purpose, startDate, endDate, visitor_tz});
  } catch (err) {
    console.error('createPendingHold failed:', err);
    return {ok: false, error: 'internal'};
  } finally {
    lock.releaseLock();
  }

  // 5. Notify the visitor (request received) and Devin (approve/decline).
  try {
    sendVisitorPending({name, email, startDate, endDate, visitor_tz});
    sendDevinApprovalRequest({name, email, purpose, startDate, endDate, visitor_tz, eventId: event.id});
  } catch (err) {
    console.error('email send failed (hold still created):', err);
    // Don't fail the request — the hold exists and shows on Devin's calendar.
  }

  return {ok: true, status: 'pending', event_id: event.id};
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
  // Pending holds are created opaque, so they count as busy and reserve the slot.
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
function createPendingHold({name, email, purpose, startDate, endDate, visitor_tz}) {
  // A pending hold: blocks the slot (opaque → counts as busy) but has NO attendee
  // and NO Meet link yet. Those are added on approval, so the visitor is never
  // invited to a meeting Devin hasn't confirmed. Visitor details live in
  // extendedProperties so approve/decline can act on them statelessly.
  const event = {
    summary: CONFIG.PENDING_TITLE(name),
    description: [
      'Office-hours REQUEST via devinstein.me/schedule — awaiting your approval.',
      '',
      `Visitor: ${name} <${email}>`,
      `Visitor TZ: ${visitor_tz || 'unknown'}`,
      '',
      'Purpose:',
      purpose ? purpose : '(none provided)',
      '',
      'Approve or decline using the buttons in the notification email.',
    ].join('\n'),
    start: {dateTime: startDate.toISOString(), timeZone: 'UTC'},
    end: {dateTime: endDate.toISOString(), timeZone: 'UTC'},
    transparency: 'opaque',  // reserve the slot while pending
    colorId: '5',            // Banana — visually flags pending holds on the calendar
    extendedProperties: {
      private: {
        bookingState: 'pending',
        vName: name,
        vEmail: email,
        vTz: visitor_tz || '',
        vPurpose: (purpose || '').substring(0, 900),
      },
    },
  };
  return Calendar.Events.insert(event, CONFIG.CALENDAR_ID);
}

function extractMeetUrl(event) {
  if (!event || !event.conferenceData || !event.conferenceData.entryPoints) return '';
  const video = event.conferenceData.entryPoints.find(ep => ep.entryPointType === 'video');
  return video ? video.uri : '';
}

// ─── EMAIL ──────────────────────────────────────────────────────────
function sendVisitorPending({name, email, startDate, endDate, visitor_tz}) {
  const visitorTime = Utilities.formatDate(startDate, visitor_tz || 'UTC', "EEEE, MMMM d 'at' h:mm a z");
  const mtTime = Utilities.formatDate(startDate, CONFIG.WORK_TZ, "h:mm a z");
  const subject = `Office-hours request received — ${Utilities.formatDate(startDate, visitor_tz || 'UTC', "MMM d, h:mm a")}`;
  const body = [
    `Hi ${name.split(' ')[0]},`,
    '',
    `Thanks for the request. I've held ${visitorTime} (${mtTime}, Mountain Time) for office hours.`,
    '',
    "I review each request personally — you'll get a confirmation with the Google Meet link once I approve it, usually within a day. If that time stops working, just reply to this email.",
    '',
    '— Devin',
    'devinstein.me/schedule',
  ].join('\n');
  GmailApp.sendEmail(email, subject, body, {
    name: 'Devin Stein',
    replyTo: CONFIG.NOTIFICATION_EMAIL,
  });
}

function sendDevinApprovalRequest({name, email, purpose, startDate, endDate, visitor_tz, eventId}) {
  const mtTime = Utilities.formatDate(startDate, CONFIG.WORK_TZ, "EEE MMM d 'at' h:mm a z");
  const aUrl = approveUrl(eventId);
  const dUrl = declineUrl(eventId);
  const subject = `Approve? ${name} — ${Utilities.formatDate(startDate, CONFIG.WORK_TZ, "MMM d, h:mm a")}`;
  const text = [
    `${name} <${email}> requested office hours.`,
    `${mtTime}  (30 min)`,
    `Visitor TZ: ${visitor_tz || 'unknown'}`,
    '',
    'Purpose:',
    purpose ? purpose : '(none provided)',
    '',
    `Approve:  ${aUrl}`,
    `Decline:  ${dUrl}`,
    '',
    'Each link opens a quick confirm screen — nothing changes until you press the button there.',
    `Held on your calendar as "PENDING" until you decide; unanswered requests auto-expire after ${CONFIG.PENDING_TTL_HOURS}h.`,
    `Event ID: ${eventId}`,
  ].join('\n');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:520px;color:#2c2a26">',
    `<p style="margin:0 0 .3rem"><strong>${esc(name)}</strong> &lt;${esc(email)}&gt; requested office hours.</p>`,
    `<p style="margin:0 0 .2rem;font-size:1.05rem"><strong>${esc(mtTime)}</strong> &nbsp;(30 min)</p>`,
    `<p style="margin:0 0 1rem;color:#8a857c;font-size:.9rem">Visitor TZ: ${esc(visitor_tz || 'unknown')}</p>`,
    '<p style="margin:0 0 .2rem;color:#8a857c;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em">Purpose</p>',
    `<p style="margin:0 0 1.4rem;line-height:1.55;white-space:pre-wrap">${esc(purpose || '(none provided)')}</p>`,
    `<a href="${aUrl}" style="display:inline-block;background:#1a6b5a;color:#fff;text-decoration:none;padding:.6rem 1.5rem;border-radius:8px;font-weight:600;margin-right:.6rem">Approve</a>`,
    `<a href="${dUrl}" style="display:inline-block;background:#b5704f;color:#fff;text-decoration:none;padding:.6rem 1.5rem;border-radius:8px;font-weight:600">Decline</a>`,
    `<p style="margin:1.4rem 0 0;color:#8a857c;font-size:.82rem">Each button opens a quick confirm screen — nothing changes until you press the button there. Held on your calendar as "&#9203; PENDING" until you decide; unanswered requests auto-expire after ${CONFIG.PENDING_TTL_HOURS}h.</p>`,
    '</div>',
  ].join('');
  GmailApp.sendEmail(CONFIG.NOTIFICATION_EMAIL, subject, text, {htmlBody: html});
}

function sendVisitorConfirmation({name, email, startDate, endDate, visitor_tz, meetUrl, eventId}) {
  const visitorTime = Utilities.formatDate(startDate, visitor_tz || 'UTC', "EEEE, MMMM d 'at' h:mm a z");
  const mtTime = Utilities.formatDate(startDate, CONFIG.WORK_TZ, "h:mm a z");
  const subject = `Office hours confirmed — ${Utilities.formatDate(startDate, visitor_tz || 'UTC', "MMM d, h:mm a")}`;
  const body = [
    `Hi ${name.split(' ')[0]},`,
    '',
    `You're confirmed for office hours with Devin Stein on ${visitorTime} (${mtTime}, Mountain Time).`,
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

function sendVisitorDecline({name, email, startDate, visitor_tz}) {
  const visitorTime = Utilities.formatDate(startDate, visitor_tz || 'UTC', "EEEE, MMMM d 'at' h:mm a");
  const subject = `Office hours — couldn't confirm ${Utilities.formatDate(startDate, visitor_tz || 'UTC', "MMM d")}`;
  const body = [
    `Hi ${name.split(' ')[0]},`,
    '',
    `Thanks for reaching out. I'm not able to confirm office hours for ${visitorTime}, so I've released that hold.`,
    '',
    "If you'd like to find another time, you're welcome to pick a new slot at devinstein.me/schedule — or just reply here and we'll sort something out.",
    '',
    '— Devin',
  ].join('\n');
  GmailApp.sendEmail(email, subject, body, {
    name: 'Devin Stein',
    replyTo: CONFIG.NOTIFICATION_EMAIL,
  });
}

function sendVisitorExpired(priv, startDate) {
  const email = priv.vEmail;
  if (!email) return;
  const first = String(priv.vName || 'there').split(' ')[0];
  const visitorTime = Utilities.formatDate(startDate, priv.vTz || 'UTC', "EEEE, MMMM d 'at' h:mm a");
  const subject = 'Office hours — your requested time has been released';
  const body = [
    `Hi ${first},`,
    '',
    `I wasn't able to confirm your office-hours request for ${visitorTime} in time, so I've released that hold.`,
    '',
    'Please feel free to grab another time at devinstein.me/schedule.',
    '',
    '— Devin',
  ].join('\n');
  GmailApp.sendEmail(email, subject, body, {
    name: 'Devin Stein',
    replyTo: CONFIG.NOTIFICATION_EMAIL,
  });
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

// ─── SIGNED CAPABILITY TOKENS (cancel / approve / decline) ──────────
function getCancelSecret() {
  // Lazily provision a signing secret on first use — no manual setup needed.
  // Signs all stateless action tokens (cancel, approve, decline).
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

function actionToken(action, eventId) {
  // Action-scoped token so an approve link can't decline (and vice versa),
  // and neither matches the visitor's cancel token.
  const sig = Utilities.computeHmacSha256Signature(action + ':' + eventId, getCancelSecret());
  return Utilities.base64EncodeWebSafe(sig).replace(/=+$/, '');
}

function approveUrl(eventId) {
  return CONFIG.WEB_APP_URL +
    '?action=approve&id=' + encodeURIComponent(eventId) +
    '&t=' + encodeURIComponent(actionToken('approve', eventId));
}

function declineUrl(eventId) {
  return CONFIG.WEB_APP_URL +
    '?action=decline&id=' + encodeURIComponent(eventId) +
    '&t=' + encodeURIComponent(actionToken('decline', eventId));
}

function constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── CANCELLATION (visitor self-service magic link) ─────────────────
function handleCancel(params) {
  const eventId = params.id || '';
  const token = params.t || '';
  if (!eventId || !token) {
    return resultPage('Invalid link',
      'This cancellation link is incomplete. To cancel, email ' + CONFIG.NOTIFICATION_EMAIL + '.', false);
  }
  // Verify the signed token before touching the calendar.
  if (!constantTimeEquals(token, cancelToken(eventId))) {
    return resultPage('Invalid link',
      "This cancellation link isn't valid. To cancel, email " + CONFIG.NOTIFICATION_EMAIL + '.', false);
  }
  // Look up the event; if it's gone or already cancelled, say so gracefully.
  let event;
  try {
    event = Calendar.Events.get(CONFIG.CALENDAR_ID, eventId);
  } catch (err) {
    return resultPage('Already cancelled',
      'This meeting is no longer on the calendar — it looks like it was already cancelled.', true);
  }
  if (!event || event.status === 'cancelled') {
    return resultPage('Already cancelled', 'This meeting has already been cancelled.', true);
  }
  const whenMt = (event.start && event.start.dateTime)
    ? Utilities.formatDate(new Date(event.start.dateTime), CONFIG.WORK_TZ, "EEEE, MMMM d 'at' h:mm a z")
    : 'your scheduled time';
  // Remove it; sendUpdates:'all' emails the attendee AND notifies the organizer.
  try {
    Calendar.Events.remove(CONFIG.CALENDAR_ID, eventId, {sendUpdates: 'all'});
  } catch (err) {
    console.error('cancel remove failed:', err);
    return resultPage('Something went wrong',
      'We could not cancel automatically. Please email ' + CONFIG.NOTIFICATION_EMAIL + ' and we will take care of it.', false);
  }
  try { sendCancellationNotice(event, whenMt); } catch (err) { console.error('cancel notice failed:', err); }
  return resultPage('Meeting cancelled',
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

// ─── APPROVE / DECLINE (Devin's magic links) ────────────────────────
// Email link scanners and inbox prefetchers issue GET requests to every URL in
// a message — which would auto-fire approve/decline if those GETs mutated state
// (and could fire BOTH at once). So GET only renders a read-only CONFIRM screen;
// the action happens on the POST that the confirm button submits. Scanners issue
// GETs but never submit forms, so nothing changes until a human clicks.

function confirmActionPage(action, params) {
  const eventId = params.id || '';
  const token = params.t || '';
  if (!eventId || !token) return resultPage('Invalid link', 'This link is incomplete.', false);
  if (!constantTimeEquals(token, actionToken(action, eventId))) {
    return resultPage('Invalid link', "This link isn't valid.", false);
  }
  let event;
  try {
    event = Calendar.Events.get(CONFIG.CALENDAR_ID, eventId);
  } catch (err) {
    return resultPage('Request not found',
      'This request is no longer on the calendar — it may have been handled already or it expired.', false);
  }
  if (!event || event.status === 'cancelled') {
    return resultPage('Request not found',
      'This request is no longer on the calendar — it may have been handled already or it expired.', false);
  }
  const priv = (event.extendedProperties && event.extendedProperties.private) || {};
  const whenMt = (event.start && event.start.dateTime)
    ? Utilities.formatDate(new Date(event.start.dateTime), CONFIG.WORK_TZ, "EEEE, MMMM d 'at' h:mm a z")
    : 'the scheduled time';
  if (priv.bookingState === 'confirmed') {
    return action === 'approve'
      ? resultPage('Already confirmed', 'You already approved this meeting (' + whenMt + '). It is on your calendar.', true)
      : resultPage('Already confirmed', "You already approved this meeting, so it can't be declined here. To call it off, cancel it from your calendar (the visitor will be notified).", false);
  }
  const isApprove = action === 'approve';
  const name = priv.vName || 'the visitor';
  const first = String(name).split(/\s+/)[0];
  const purpose = priv.vPurpose || '';
  const accent = isApprove ? '#1a6b5a' : '#b5704f';
  const verb = isApprove ? 'Approve & send invite' : 'Decline request';
  const heading = isApprove ? 'Approve this request?' : 'Decline this request?';
  const lead = isApprove
    ? 'Confirm office hours with <strong>' + escapeHtml(name) + '</strong> and send ' + escapeHtml(first) + ' the calendar invite and Google Meet link.'
    : 'Turn down this request from <strong>' + escapeHtml(name) + '</strong>. ' + escapeHtml(first) + ' will get a brief note that you could not fit it in, and the slot reopens.';
  const postAction = isApprove ? 'approve_confirm' : 'decline_confirm';
  const detail =
    '<p style="margin:.2rem 0 .2rem;font-size:1.05rem;color:#1f1d1a"><strong>' + escapeHtml(whenMt) + '</strong></p>' +
    (purpose
      ? '<p style="margin:.2rem 0 1.2rem;color:#6a665e;line-height:1.5;white-space:pre-wrap">&ldquo;' + escapeHtml(purpose) + '&rdquo;</p>'
      : '<div style="height:.6rem"></div>');
  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + heading + ' — devinstein.me</title>' +
    '<style>' +
    'body{margin:0;background:#f4f2ec;color:#2c2a26;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;min-height:100vh;padding:1.5rem;box-sizing:border-box}' +
    '.card{background:#fff;max-width:460px;width:100%;padding:2.2rem 2rem;border-radius:14px;' +
    'box-shadow:0 10px 40px rgba(0,0,0,.08);border-left:3px solid ' + accent + '}' +
    'h1{font-family:Georgia,"Times New Roman",serif;font-size:1.5rem;font-weight:500;margin:0 0 .8rem;color:#1f1d1a}' +
    'p{font-size:.97rem;line-height:1.6;margin:0 0 1rem;color:#4a4742}' +
    'button{background:' + accent + ';color:#fff;border:0;padding:.7rem 1.6rem;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}' +
    '.foot{font-size:.8rem;color:#8a857c;margin-top:1.4rem;margin-bottom:0}' +
    '</style></head><body><div class="card">' +
    '<h1>' + heading + '</h1>' +
    '<p>' + lead + '</p>' +
    detail +
    '<form method="post" action="' + CONFIG.WEB_APP_URL + '" target="_top" style="margin:0">' +
    '<input type="hidden" name="action" value="' + postAction + '">' +
    '<input type="hidden" name="id" value="' + escapeAttr(eventId) + '">' +
    '<input type="hidden" name="t" value="' + escapeAttr(token) + '">' +
    '<button type="submit">' + verb + '</button>' +
    '</form>' +
    '<p class="foot">Opened this by mistake? Just close the tab — nothing changes until you press the button.</p>' +
    '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setTitle(heading + ' — devinstein.me');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function handleApprove(params) {
  const eventId = params.id || '';
  const token = params.t || '';
  if (!eventId || !token) return resultPage('Invalid link', 'This approval link is incomplete.', false);
  if (!constantTimeEquals(token, actionToken('approve', eventId))) {
    return resultPage('Invalid link', "This approval link isn't valid.", false);
  }
  // Serialize the read-check-mutate so a double-submit can't approve twice.
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { return resultPage('One moment', 'The scheduler is briefly busy — go back and press Approve once more.', false); }
  try {
    let event;
    try {
      event = Calendar.Events.get(CONFIG.CALENDAR_ID, eventId);
    } catch (err) {
      return resultPage('Request not found',
        'This request is no longer on the calendar — it may have been declined or it expired.', false);
    }
    if (!event || event.status === 'cancelled') {
      return resultPage('Request not found',
        'This request is no longer on the calendar — it may have been declined or it expired.', false);
    }
    const priv = (event.extendedProperties && event.extendedProperties.private) || {};
    const whenMt = (event.start && event.start.dateTime)
      ? Utilities.formatDate(new Date(event.start.dateTime), CONFIG.WORK_TZ, "EEEE, MMMM d 'at' h:mm a z")
      : 'the scheduled time';
    if (priv.bookingState === 'confirmed') {
      return resultPage('Already confirmed',
        'You already approved this meeting (' + whenMt + '). It is on your calendar.', true);
    }
    const name = priv.vName || 'Visitor';
    const email = priv.vEmail || '';
    const visitor_tz = priv.vTz || 'UTC';
    if (!email) {
      return resultPage('Missing details',
        "This request is missing the visitor's email, so it can't be auto-approved. Please handle it on your calendar manually.", false);
    }
    const startDate = new Date(event.start.dateTime);
    const endDate = new Date(event.end.dateTime);
    // Promote the hold: add the attendee + a Meet link, flip state, retitle, and
    // notify the attendee (sendUpdates:'all' → calendar invite goes out now).
    let updated;
    try {
      updated = Calendar.Events.patch({
        summary: CONFIG.MEETING_TITLE(name),
        attendees: [{email: email}],
        colorId: '10',  // Basil (green) — confirmed
        extendedProperties: {private: {bookingState: 'confirmed'}},
        conferenceData: {
          createRequest: {
            requestId: Utilities.getUuid(),
            conferenceSolutionKey: {type: 'hangoutsMeet'},
          },
        },
      }, CONFIG.CALENDAR_ID, eventId, {conferenceDataVersion: 1, sendUpdates: 'all'});
    } catch (err) {
      console.error('approve patch failed:', err);
      return resultPage('Something went wrong',
        'Could not confirm automatically. Open the event on your calendar to approve it manually.', false);
    }
    let meetUrl = extractMeetUrl(updated);
    if (!meetUrl) {
      try { meetUrl = extractMeetUrl(Calendar.Events.get(CONFIG.CALENDAR_ID, eventId)); } catch (e) {}
    }
    try {
      sendVisitorConfirmation({name, email, startDate, endDate, visitor_tz, meetUrl, eventId});
    } catch (err) {
      console.error('approve confirmation email failed:', err);
    }
    return resultPage('Meeting confirmed',
      name + ' is booked for ' + whenMt + ', and a confirmation with the Google Meet link is on its way to them.', true);
  } finally {
    lock.releaseLock();
  }
}

function handleDecline(params) {
  const eventId = params.id || '';
  const token = params.t || '';
  if (!eventId || !token) return resultPage('Invalid link', 'This decline link is incomplete.', false);
  if (!constantTimeEquals(token, actionToken('decline', eventId))) {
    return resultPage('Invalid link', "This decline link isn't valid.", false);
  }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (e) { return resultPage('One moment', 'The scheduler is briefly busy — go back and press Decline once more.', false); }
  try {
    let event;
    try {
      event = Calendar.Events.get(CONFIG.CALENDAR_ID, eventId);
    } catch (err) {
      return resultPage('Already handled', 'This request is no longer on the calendar.', true);
    }
    if (!event || event.status === 'cancelled') {
      return resultPage('Already handled', 'This request is no longer on the calendar.', true);
    }
    const priv = (event.extendedProperties && event.extendedProperties.private) || {};
    if (priv.bookingState === 'confirmed') {
      return resultPage('Already confirmed',
        'You already approved this meeting, so it was not declined. To call it off, cancel it from your calendar (the visitor will be notified).', false);
    }
    const name = priv.vName || 'the visitor';
    const email = priv.vEmail || '';
    const startDate = (event.start && event.start.dateTime) ? new Date(event.start.dateTime) : null;
    // No attendee on a pending hold, so sendUpdates:'none' — we send our own note.
    try {
      Calendar.Events.remove(CONFIG.CALENDAR_ID, eventId, {sendUpdates: 'none'});
    } catch (err) {
      console.error('decline remove failed:', err);
      return resultPage('Something went wrong',
        'Could not remove the request automatically. Please delete it from your calendar.', false);
    }
    if (email && startDate) {
      try { sendVisitorDecline({name, email, startDate, visitor_tz: priv.vTz || 'UTC'}); }
      catch (err) { console.error('decline email failed:', err); }
    }
    return resultPage('Request declined',
      'The request has been removed and the time is open again' +
      (email ? ', and ' + name + ' has been sent a brief note' : '') + '.', true);
  } finally {
    lock.releaseLock();
  }
}

// ─── RESULT PAGE (shared by cancel / approve / decline) ─────────────
function resultPage(heading, message, ok) {
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

// ─── PENDING-HOLD CLEANUP (hourly time-driven trigger) ──────────────
function sweepStalePending() {
  // Deletes pending holds that have gone unanswered past PENDING_TTL_HOURS,
  // or whose slot time has already passed — freeing the slot. Notifies the
  // visitor that their requested time was released.
  const calId = CONFIG.CALENDAR_ID;
  const now = new Date();
  const ttlMs = CONFIG.PENDING_TTL_HOURS * 3600 * 1000;
  let pageToken;
  let swept = 0;
  do {
    const resp = Calendar.Events.list(calId, {
      privateExtendedProperty: 'bookingState=pending',
      showDeleted: false,
      maxResults: 100,
      pageToken: pageToken,
      timeMin: new Date(now.getTime() - 7 * 86400 * 1000).toISOString(),
      timeMax: new Date(now.getTime() + (CONFIG.HORIZON_DAYS + 1) * 86400 * 1000).toISOString(),
    });
    (resp.items || []).forEach(ev => {
      const created = ev.created ? new Date(ev.created) : null;
      const start = (ev.start && ev.start.dateTime) ? new Date(ev.start.dateTime) : null;
      const tooOld = created ? (now.getTime() - created.getTime() > ttlMs) : false;
      const slotPassed = start ? (start < now) : false;
      if (!tooOld && !slotPassed) return;
      try {
        Calendar.Events.remove(calId, ev.id, {sendUpdates: 'none'});
        swept++;
      } catch (err) {
        console.error('sweep remove failed for', ev.id, err);
        return;
      }
      const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
      if (priv.vEmail && start) {
        try { sendVisitorExpired(priv, start); } catch (err) { console.error('sweep notify failed:', err); }
      }
    });
    pageToken = resp.nextPageToken;
  } while (pageToken);
  console.log('sweepStalePending: removed', swept, 'stale pending hold(s).');
}

function installPendingSweepTrigger() {
  // Run ONCE from the editor. Idempotent — clears any prior copies first.
  const existing = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sweepStalePending');
  existing.forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sweepStalePending').timeBased().everyHours(1).create();
  console.log('Installed hourly sweepStalePending trigger. Removed', existing.length, 'duplicate(s).');
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
  console.log('PENDING_TTL_HOURS:', CONFIG.PENDING_TTL_HOURS);
  console.log('Effective user:', Session.getEffectiveUser().getEmail());

  console.log('=== TRIGGERS ===');
  const sweepTriggers = ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'sweepStalePending');
  console.log('sweepStalePending triggers installed:', sweepTriggers.length,
    '(expected 1 — run installPendingSweepTrigger() if 0)');

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
