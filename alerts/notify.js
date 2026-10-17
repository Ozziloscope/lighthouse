// Decides who should hear about what, and queues the alerts. Delivery itself happens in delivery.js.
//
// Ticket alerts:  new ticket in a group, any new/escalated P1, assignment, updates, SLA warning and breach,
//                 and replies / status changes for the person who raised the ticket.
// Project alerts: task assigned, task comment, task due tomorrow or overdue.
// Nobody is ever alerted about their own action.
const crypto = require("crypto");
const {
  OPEN_TICKET_STATUSES, FALLBACK_SLA_HOURS, SLA_WARNING_FRACTION_LEFT, HOUR_MS, DAY_MS,
  IGNORE_SLA_BREACHES_OLDER_THAN_MS, IGNORE_TASKS_OVERDUE_BY_MORE_THAN_DAYS, ALERT_EXCERPT_LENGTH, VERIFICATION_CODE_DIGITS,
  DELIVERY_CHECK_INTERVAL_MS, SCHEDULED_CHECK_INTERVAL_MS, FIRST_SCHEDULED_CHECK_DELAY_MS, HISTORY_CLEANUP_INTERVAL_MS,
} = require("../lib/constants");
const { can } = require("../lib/access");
const { ALERT_EVENTS, PRIORITY_RANK } = require("./events");
const { composeAlert, excerpt, formatDateTime, formatDueDate, describeDuration, PRIORITY_LABEL } = require("./messages");
const { createMailer } = require("./mailer");
const { createSmsSender, maskPhoneNumber } = require("./sms");
const { createDelivery } = require("./delivery");
const { verifiedEmailOf, verifiedPhoneOf } = require("./contacts");

const twoDigits = (n) => String(n).padStart(2, "0");
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`; };
const isOpen = (status) => OPEN_TICKET_STATUSES.includes(status);

function createNotifier({ db, one, all, run, audit, config, deskSettings, getUserById, activeUsersWith }) {
  // The mail and text senders are rebuilt whenever an admin saves new settings in Settings > Alert setup.
  let mailer, smsSender;
  function reconfigure() {
    mailer = createMailer(deskSettings.emailSettings());
    smsSender = createSmsSender(deskSettings.smsSettings());
  }
  reconfigure();
  const options = () => deskSettings.alertOptions();
  const delivery = createDelivery({ db, one, all, run, audit, senders: () => ({ mailer, smsSender }), limits: options });
  const linkTo = (hash) => (config.publicUrl ? `${config.publicUrl}/#${hash}` : null);
  const compose = (parts) => composeAlert(parts, { includeDetailsInTexts: options().includeDetailsInTexts });
  // SLA targets are edited in the app (Settings > SLA targets), so read them fresh each time.
  const slaWindowMs = (priority) => (deskSettings.slaHours()[priority] || FALLBACK_SLA_HOURS) * HOUR_MS;

  // ---------- preferences ----------
  const personMaySee = (person, eventKey) => ALERT_EVENTS[eventKey].requiresAnyOf.some((permission) => can(person, permission));

  function preferencesFor(person) {
    let saved = {};
    try { saved = JSON.parse(person.alert_prefs || "{}"); } catch { saved = {}; }
    const preferences = {};
    for (const [key, event] of Object.entries(ALERT_EVENTS)) preferences[key] = { ...event.defaults, ...(saved[key] || {}) };
    return preferences;
  }
  // Keeps only known alerts and channels from what the browser sent.
  function cleanPreferences(input) {
    const cleaned = {};
    for (const [key, event] of Object.entries(ALERT_EVENTS)) {
      const wanted = input && typeof input[key] === "object" ? input[key] : null;
      if (!wanted) continue;
      cleaned[key] = { email: !!wanted.email, sms: !!wanted.sms };
      if (event.hasPriorityFilter) cleaned[key].minPriority = PRIORITY_RANK[wanted.minPriority] ? wanted.minPriority : event.defaults.minPriority;
    }
    return cleaned;
  }
  const alertEmailOf = verifiedEmailOf;

  // ---------- queueing ----------
  // Queues one alert for one person on each channel they turned on. Returns true if anything was queued.
  // options.dedupeKey  makes it a one-time alert (SLA, due dates)
  // options.priority   checked against the person's "P1 and P2"-style filter
  function alertPerson(userId, eventKey, message, options = {}) {
    const person = getUserById(userId);
    if (!person || !person.active || person.alerts_paused || !personMaySee(person, eventKey)) return false;
    const wants = preferencesFor(person)[eventKey];
    if (ALERT_EVENTS[eventKey].hasPriorityFilter && options.priority && PRIORITY_RANK[options.priority] > PRIORITY_RANK[wants.minPriority]) return false;

    let queuedSomething = false;
    const email = alertEmailOf(person);
    if (wants.email && mailer.configured && email) {
      queuedSomething = delivery.queue({ userId: person.id, channel: "email", target: email, event: eventKey, subject: message.subject, body: message.text, html: message.html,
        dedupeKey: options.dedupeKey ? `${options.dedupeKey}:${person.id}:email` : null }) || queuedSomething;
    }
    const phone = verifiedPhoneOf(person);
    if (wants.sms && smsSender.configured && phone) {
      queuedSomething = delivery.queue({ userId: person.id, channel: "sms", target: phone, event: eventKey, body: message.sms,
        dedupeKey: options.dedupeKey ? `${options.dedupeKey}:${person.id}:sms` : null }) || queuedSomething;
    }
    if (queuedSomething) setImmediate(delivery.sendQueuedAlerts);
    return queuedSomething;
  }

  // ---------- reading tickets and tasks for messages ----------
  function ticketForMessage(id) {
    const t = one(`SELECT t.*, g.name AS group_name, a.name AS assignee_name, r.name AS requester_name FROM tickets t
      LEFT JOIN groups g ON g.id = t.group_id LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users r ON r.id = t.requester_id WHERE t.id = ?`, id);
    if (!t) return null;
    const dueAt = t.created_at + slaWindowMs(t.priority), now = Date.now();
    t.ref = `TKT-${t.id}`;
    t.url = linkTo(`ticket-${t.id}`);
    const slaLine = isOpen(t.status) ? `SLA due ${formatDateTime(dueAt)} (${dueAt > now ? "in " + describeDuration(dueAt - now) : describeDuration(now - dueAt) + " ago"})` : null;
    t.deskFacts = [`${PRIORITY_LABEL[t.priority]} · ${t.status}${t.group_name ? " · " + t.group_name : ""}`, t.asset ? `Asset: ${t.asset}` : null, slaLine];
    return t;
  }
  // People who can't see the whole desk (e.g. requesters) get only the status, not internal routing details.
  const factsFor = (recipientId, ticket) => (can(getUserById(recipientId), "tickets.view_all") ? ticket.deskFacts : [`Status: ${ticket.status}`]);
  const nameOf = (userId) => (userId ? one("SELECT name FROM users WHERE id = ?", userId)?.name || "Someone" : "Lighthouse");
  const activeGroupMemberIds = (groupId) => (groupId ? all("SELECT u.id FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND u.active = 1", groupId).map((r) => r.id) : []);

  // ---------- ticket alerts ----------
  function ticketCreated(ticketId, actorId) {
    const t = ticketForMessage(ticketId); if (!t) return;
    const alreadyTold = new Set([actorId]);
    for (const userId of activeGroupMemberIds(t.group_id)) {
      if (alreadyTold.has(userId)) continue;
      const queued = alertPerson(userId, "ticket_new_group", compose({
        headline: `New ${t.priority} ticket ${t.ref} in ${t.group_name}`, title: t.title,
        facts: [...t.deskFacts, `Raised by ${t.requester_name || "someone"}`], quote: excerpt(t.description, ALERT_EXCERPT_LENGTH.description) || null,
        url: t.url, eventKey: "ticket_new_group",
        sms: { full: `New ${t.priority} ${t.ref} in ${t.group_name}: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `New ${t.priority} ticket ${t.ref} in your group.` },
      }), { priority: t.priority });
      if (queued) alreadyTold.add(userId);
    }
    if (t.priority === "P1") alertEveryoneAboutP1(t, alreadyTold, `New P1 ticket ${t.ref}`);
  }

  function alertEveryoneAboutP1(t, alreadyTold, headline) {
    for (const person of activeUsersWith("tickets.view_all")) {
      if (alreadyTold.has(person.id)) continue;
      alertPerson(person.id, "ticket_new_p1_any", compose({
        headline, title: t.title, facts: t.deskFacts, url: t.url, eventKey: "ticket_new_p1_any",
        sms: { full: `${headline}: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${headline}.` },
      }), { dedupeKey: `p1:${t.id}` });
    }
  }

  // `before` is the ticket row as it was before the change.
  function ticketChanged(before, ticketId, actorId) {
    const t = ticketForMessage(ticketId); if (!t) return;
    const actorName = nameOf(actorId);

    const newlyAssignedToSomeoneElse = t.assignee_id && t.assignee_id !== before.assignee_id && t.assignee_id !== actorId;
    if (newlyAssignedToSomeoneElse) {
      alertPerson(t.assignee_id, "ticket_assigned", compose({
        headline: `${t.ref} was assigned to you by ${actorName}`, title: t.title, facts: t.deskFacts,
        quote: excerpt(t.description, ALERT_EXCERPT_LENGTH.description) || null, url: t.url, eventKey: "ticket_assigned",
        sms: { full: `${t.ref} ${t.priority} assigned to you: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${t.ref} (${t.priority}) assigned to you.` },
      }));
    }

    const routedToNewGroupWithNoOwner = t.group_id && t.group_id !== before.group_id && !t.assignee_id && isOpen(t.status);
    if (routedToNewGroupWithNoOwner) {
      for (const userId of activeGroupMemberIds(t.group_id)) {
        if (userId === actorId) continue;
        alertPerson(userId, "ticket_new_group", compose({
          headline: `${t.ref} was routed to ${t.group_name} by ${actorName}`, title: t.title, facts: t.deskFacts, url: t.url, eventKey: "ticket_new_group",
          sms: { full: `${t.ref} ${t.priority} routed to ${t.group_name}: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${t.ref} (${t.priority}) routed to your group.` },
        }), { priority: t.priority });
      }
    }

    const escalatedToP1 = t.priority === "P1" && before.priority !== "P1" && isOpen(t.status);
    if (escalatedToP1) alertEveryoneAboutP1(t, new Set([actorId]), `${t.ref} escalated to P1 by ${actorName}`);

    const statusTheRequesterCaresAbout = ["Pending", "Resolved", "Closed"].includes(t.status) && t.status !== before.status;
    if (t.requester_id && t.requester_id !== actorId && statusTheRequesterCaresAbout) {
      const waitingOnRequester = t.status === "Pending";
      const statusWord = t.status.toLowerCase();
      alertPerson(t.requester_id, "ticket_requester_update", compose({
        headline: waitingOnRequester ? `The desk needs information from you on ${t.ref}` : `${t.ref} has been ${statusWord}`,
        title: t.title, facts: factsFor(t.requester_id, t),
        quote: t.status === "Resolved" && t.resolution ? "Resolution: " + excerpt(t.resolution, ALERT_EXCERPT_LENGTH.resolution) : null,
        url: t.url, eventKey: "ticket_requester_update",
        sms: waitingOnRequester
          ? { full: `${t.ref} is waiting on you: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${t.ref} is waiting on your reply.` }
          : { full: `${t.ref} ${statusWord}: ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${t.ref} was ${statusWord}.` },
      }));
    }
  }

  function ticketComment(ticketId, actorId, text, isInternal) {
    const t = ticketForMessage(ticketId); if (!t) return;
    const actorName = nameOf(actorId);
    if (t.assignee_id && t.assignee_id !== actorId) {
      alertPerson(t.assignee_id, "ticket_comment", compose({
        headline: `${actorName} posted ${isInternal ? "an internal note" : "an update"} on ${t.ref}`, title: t.title, facts: t.deskFacts,
        quote: excerpt(text, ALERT_EXCERPT_LENGTH.comment), url: t.url, eventKey: "ticket_comment",
        sms: { full: `${actorName} on ${t.ref}: ${excerpt(text, ALERT_EXCERPT_LENGTH.smsComment)}`, short: `New update on ${t.ref}.` },
      }));
    }
    // The person who raised the ticket only ever hears about public updates.
    const requesterShouldHear = !isInternal && t.requester_id && t.requester_id !== actorId && t.requester_id !== t.assignee_id;
    if (requesterShouldHear) {
      alertPerson(t.requester_id, "ticket_requester_update", compose({
        headline: `${actorName} replied on ${t.ref}`, title: t.title, facts: factsFor(t.requester_id, t),
        quote: excerpt(text, ALERT_EXCERPT_LENGTH.comment), url: t.url, eventKey: "ticket_requester_update",
        sms: { full: `Reply on ${t.ref}: ${excerpt(text, ALERT_EXCERPT_LENGTH.smsComment)}`, short: `The desk replied on ${t.ref}.` },
      }));
    }
  }

  // ---------- task alerts ----------
  function taskForMessage(id) {
    const k = one("SELECT k.*, p.name AS project_name FROM tasks k JOIN projects p ON p.id = k.project_id WHERE k.id = ?", id);
    if (!k) return null;
    k.url = linkTo(`task-${k.id}`);
    k.facts = [`Project: ${k.project_name}`, k.due_date ? `Due ${formatDueDate(k.due_date)}` : null, k.priority ? `Priority: ${k.priority}` : null];
    return k;
  }

  function taskAssigned(taskId, actorId) {
    const k = taskForMessage(taskId);
    if (!k || !k.assignee_id || k.assignee_id === actorId || k.completed) return;
    alertPerson(k.assignee_id, "task_assigned", compose({
      headline: `${nameOf(actorId)} assigned you a task`, title: k.title, facts: k.facts,
      quote: excerpt(k.description, ALERT_EXCERPT_LENGTH.description) || null, url: k.url, eventKey: "task_assigned",
      sms: { full: `Task assigned to you in ${k.project_name}: ${excerpt(k.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: "A project task was assigned to you." },
    }));
  }

  function taskComment(taskId, actorId, text) {
    const k = taskForMessage(taskId); if (!k) return;
    const actorName = nameOf(actorId);
    for (const userId of new Set([k.assignee_id, k.created_by])) {
      if (!userId || userId === actorId) continue;
      alertPerson(userId, "task_comment", compose({
        headline: `${actorName} commented on a task`, title: k.title, facts: k.facts, quote: excerpt(text, ALERT_EXCERPT_LENGTH.comment), url: k.url, eventKey: "task_comment",
        sms: { full: `${actorName} on "${excerpt(k.title, ALERT_EXCERPT_LENGTH.smsComment / 2)}": ${excerpt(text, ALERT_EXCERPT_LENGTH.smsComment)}`, short: "New comment on your task." },
      }));
    }
  }

  // ---------- scheduled checks (run every minute) ----------
  // Who hears about an SLA: the assignee; if unassigned, everyone in the ticket's group;
  // if it has no group either, the people who can assign tickets.
  function slaRecipients(ticket) {
    if (ticket.assignee_id) return [ticket.assignee_id];
    const groupMembers = activeGroupMemberIds(ticket.group_id);
    return groupMembers.length ? groupMembers : activeUsersWith("tickets.assign").map((u) => u.id);
  }

  function checkSlas(now) {
    const openTickets = all(`SELECT id, priority, created_at, assignee_id, group_id FROM tickets WHERE status IN (${OPEN_TICKET_STATUSES.map(() => "?").join(",")})`, ...OPEN_TICKET_STATUSES);
    for (const ticket of openTickets) {
      const windowMs = slaWindowMs(ticket.priority);
      const timeLeftMs = ticket.created_at + windowMs - now;
      const isFreshBreach = timeLeftMs <= 0 && -timeLeftMs < IGNORE_SLA_BREACHES_OLDER_THAN_MS;
      const isRunningOut = timeLeftMs > 0 && timeLeftMs <= windowMs * SLA_WARNING_FRACTION_LEFT;
      if (!isFreshBreach && !isRunningOut) continue;

      const t = ticketForMessage(ticket.id);
      const eventKey = isFreshBreach ? "ticket_sla_breached" : "ticket_sla_warning";
      const headline = isFreshBreach ? `SLA breached on ${t.ref}` : `SLA on ${t.ref} runs out in ${describeDuration(timeLeftMs)}`;
      for (const userId of slaRecipients(ticket)) {
        alertPerson(userId, eventKey, compose({
          headline, title: t.title, facts: [...t.deskFacts, t.assignee_name ? `Assigned to ${t.assignee_name}` : "Unassigned"], url: t.url, eventKey,
          sms: { full: `${headline} (${ticket.priority}): ${excerpt(t.title, ALERT_EXCERPT_LENGTH.smsTitle)}`, short: `${headline} (${ticket.priority}).` },
        }), { dedupeKey: `${isFreshBreach ? "sla-breach" : "sla-warning"}:${ticket.id}:${ticket.priority}` });
      }
    }
  }

  // Task reminders go out once a day, from the daily reminder hour (Settings > Alert setup) in the server's time zone.
  function checkTaskDueDates(now) {
    if (new Date(now).getHours() < options().dailyReminderHour) return;
    const today = localDate(now), tomorrow = localDate(now + DAY_MS), oldestOverdueToMention = localDate(now - IGNORE_TASKS_OVERDUE_BY_MORE_THAN_DAYS * DAY_MS);
    const dueTasks = all(`SELECT k.id, k.assignee_id, k.due_date FROM tasks k JOIN projects p ON p.id = k.project_id
      WHERE k.completed = 0 AND k.assignee_id IS NOT NULL AND p.archived = 0 AND (k.due_date = ? OR (k.due_date < ? AND k.due_date >= ?))`, tomorrow, today, oldestOverdueToMention);
    for (const due of dueTasks) {
      const k = taskForMessage(due.id), isDueTomorrow = due.due_date === tomorrow;
      const headline = isDueTomorrow ? "A task of yours is due tomorrow" : `A task of yours is overdue (was due ${formatDueDate(due.due_date)})`;
      alertPerson(due.assignee_id, "task_due", compose({
        headline, title: k.title, facts: k.facts, url: k.url, eventKey: "task_due",
        sms: { full: `${isDueTomorrow ? "Due tomorrow" : "Overdue"}: ${excerpt(k.title, ALERT_EXCERPT_LENGTH.smsTitle)} (${k.project_name})`, short: isDueTomorrow ? "A task is due tomorrow." : "A task is overdue." },
      }), { dedupeKey: `${isDueTomorrow ? "due-tomorrow" : "overdue"}:${due.id}:${due.due_date}` });
    }
  }

  function runScheduledChecks() {
    const now = Date.now();
    try { checkSlas(now); checkTaskDueDates(now); }
    catch (error) { console.error("Scheduled alert check failed:", error); }
  }

  function start() {
    setInterval(delivery.sendQueuedAlerts, DELIVERY_CHECK_INTERVAL_MS).unref();
    setInterval(runScheduledChecks, SCHEDULED_CHECK_INTERVAL_MS).unref();
    setInterval(delivery.deleteOldHistory, HISTORY_CLEANUP_INTERVAL_MS).unref();
    setTimeout(runScheduledChecks, FIRST_SCHEDULED_CHECK_DELAY_MS).unref();
    delivery.deleteOldHistory();
    const email = mailer.describe(), sms = smsSender.describe();
    console.log(`Alerts: email ${email.configured ? "on via " + email.server : "off"}, texts ${sms.configured ? "on via " + sms.provider : "off"}`);
  }

  const newVerificationCode = () => String(crypto.randomInt(0, 10 ** VERIFICATION_CODE_DIGITS)).padStart(VERIFICATION_CODE_DIGITS, "0");

  return {
    personMaySee, preferencesFor, cleanPreferences, alertEmailOf, maskPhoneNumber, newVerificationCode,
    channels: () => ({ email: mailer.configured, sms: smsSender.configured }),
    describe: () => ({
      email: mailer.describe(), sms: smsSender.describe(), publicUrl: config.publicUrl,
      ...options(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
    reconfigure,
    // Sends a test message with settings that haven't been saved yet, so an admin can check them first.
    sendTestWithSettings: ({ channel, settings, ...message }) => delivery.sendNow({
      ...message, channel, via: channel === "email" ? { mailer: createMailer(settings) } : { smsSender: createSmsSender(settings) },
    }),
    ticketCreated, ticketChanged, ticketComment, taskAssigned, taskComment,
    sendNow: delivery.sendNow, retryFailed: delivery.retryFailed, sendQueuedAlerts: delivery.sendQueuedAlerts, runScheduledChecks, start,
  };
}

module.exports = { createNotifier, ALERT_EVENTS };
