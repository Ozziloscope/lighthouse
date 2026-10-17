// Settings tab: a list of pages down the left, grouped under "Me" and "Admin".
//
// Each page is a small object added with LH.addSettingsPages({...}):
//   key, label, section ("Me" or "Admin")
//   isVisible()                  whether this person's access level shows the page
//   load()                       fetch what the page needs
//   html()                       the page itself
//   holdsForm()                  true while a form is on screen, so the 15-second refresh doesn't wipe it
//   onClick(element, data) / onChange(element) / onSubmit(form) / onInput(element) / onKeydown(event, element)
//                                return true when handled
//   reset()                      forget half-finished edits when the person leaves the page
//
// This file holds the "Me" pages: My profile, My alerts, Appearance and Password.
// The admin pages are in settings-admin.js.
(() => {
"use strict";
const { S, $, esc, toast, api, act, can, avatar } = LH;

// ---------- the page registry ----------
const PAGES = [];
LH.addSettingsPages = (...pages) => PAGES.push(...pages);
const visiblePages = () => PAGES.filter((page) => !page.isVisible || page.isVisible());
const pageFor = (key) => visiblePages().find((page) => page.key === key) || visiblePages()[0];
const currentPage = () => pageFor(LH.currentView());
// Redraws the page from scratch (used after saving, when the form should show the saved values).
LH.rebuildSettingsPage = () => { $("#main").innerHTML = ""; LH.render(); };

// ---------- settings ----------
const VERIFICATION_CODE_DIGITS = 6;            // matches the server
const VERIFICATION_CODE_LIFETIME_MINUTES = 10; // matches the server
const PRIORITY_FILTER_CHOICES = [["P1", "P1 only"], ["P2", "P1 and P2"], ["P3", "P1 to P3"], ["P4", "All priorities"]];
const THEME_CHOICES = [
  { value: "system", label: "Match my device", hint: "Follows your computer or phone's light/dark setting." },
  { value: "light", label: "Light", hint: "Always light." },
  { value: "dark", label: "Dark", hint: "Always dark. Easier on the eyes on a dim data-center floor." },
];
const CHANNEL_WORDS = {
  email: { name: "Email", thing: "address", alerts: "Email alerts", test: "email" },
  sms: { name: "Text messages", thing: "mobile number", alerts: "Text alerts", test: "text" },
};

// Page-level state for the "Me" pages.
const M = {
  myAlerts: null,     // GET /api/alerts/me
  contactSteps: {},   // per channel: { editing: true } while changing, { codeSent: true } while waiting for a code
};

// ---------- My profile ----------
const profilePage = {
  key: "profile", label: "My profile", section: "Me",
  html() {
    const me = S.me, hasPhoto = !!me.photoVersion;
    return `<div class="topbar"><h1>My profile</h1></div>
      <section class="settings-card"><h2>Photo</h2>
        <div class="photo-editor">${avatar(me.id, "xxl")}
          <div><p class="note">Your photo appears next to your name across Lighthouse, including on tickets you work, so the people who raised them can see who's helping.</p>
            <div class="btns"><label class="btn primary file-btn">${hasPhoto ? "Change photo" : "Upload a photo"}<input type="file" id="my_photo" accept="image/*"></label>
              ${hasPhoto ? '<button class="btn danger" data-removemyphoto>Remove photo</button>' : ""}</div>
            <p class="note">Any picture works: it's cropped to a square and shrunk to ${S.C.PHOTO_SIZE_PX}×${S.C.PHOTO_SIZE_PX} before it's uploaded.</p></div></div></section>
      <section class="settings-card"><h2>Account</h2>
        <dl class="kv"><dt>Name</dt><dd>${esc(me.name)}</dd><dt>Username</dt><dd class="mono">${esc(me.username)}</dd>
          <dt>Access level</dt><dd>${esc(me.accessLevelName)}</dd><dt>Account email</dt><dd>${me.email ? esc(me.email) : '<span class="none">None</span>'}</dd></dl>
        <p class="note">An account manager changes your name, username and access level. Where your alerts go is under <button class="linkbtn" data-view="alerts">My alerts</button>.</p></section>`;
  },
  async onChange(element) {
    if (element.id !== "my_photo") return false;
    const file = element.files[0];
    if (!file) return true;
    try {
      const image = await LH.preparePhotoUpload(file);
      const result = await act(() => api("PUT", "/api/me/photo", { image }), "Photo saved");
      S.me.photoVersion = result.photoVersion;
      await LH.loadBootstrap();
    } catch (error) { toast(error.message, true); }
    LH.rebuildSettingsPage();
    return true;
  },
  async onClick(element, data) {
    if (data.removemyphoto === undefined) return false;
    await act(() => api("DELETE", "/api/me/photo"), "Photo removed");
    await LH.loadBootstrap();
    LH.rebuildSettingsPage();
    return true;
  },
};

// ---------- My alerts ----------
// What a contact card shows depends on where the address or number is in its life:
//   nothing saved -> type it in;  saved but not confirmed -> confirm with a code (once the channel is on);
//   code sent -> type the code;   confirmed -> alerts go there, with a test button.
function contactState(channel) {
  const { contact, channels } = M.myAlerts;
  const isEmail = channel === "email";
  const saved = isEmail ? contact.alertEmail : contact.phone;
  const confirmed = isEmail ? contact.alertEmailVerified : contact.phoneVerified;
  const step = M.contactSteps[channel] || {};
  return {
    isEmail, saved, confirmed, step,
    channelOn: !!channels[channel],
    pendingTarget: contact.pending[channel],
    accountEmail: isEmail ? contact.accountEmail : null,
    deliversTo: isEmail ? contact.emailTo : (confirmed ? saved : null),
  };
}
function contactInputHTML(channel, state) {
  const input = state.isEmail
    ? `<input id="target_email" type="email" placeholder="you@example.com" autocomplete="email" aria-label="Email address for alerts" value="${esc(state.step.editing ? "" : state.saved || "")}">`
    : `<input id="target_sms" type="tel" placeholder="+1 317 555 0100" autocomplete="tel" aria-label="Mobile number">`;
  const buttonLabel = state.channelOn ? "Send code" : "Save";
  const note = state.channelOn
    ? `We ${state.isEmail ? "email" : "text"} a ${VERIFICATION_CODE_DIGITS}-digit code to confirm it's yours.${state.isEmail ? "" : " Standard message rates may apply."}`
    : `${CHANNEL_WORDS[channel].alerts} aren't turned on for this desk yet. Save your ${CHANNEL_WORDS[channel].thing} now; you'll confirm it with a code once they are.`;
  return `<div class="addrow">${input}<button class="btn sm primary" data-sendcode="${channel}">${buttonLabel}</button>${state.step.editing ? `<button class="btn sm" data-canceledit="${channel}">Cancel</button>` : ""}</div><p class="note">${note}</p>`;
}
function codeEntryHTML(channel, state) {
  return `<div class="verify"><p class="note">We sent a ${VERIFICATION_CODE_DIGITS}-digit code to <b>${esc(state.pendingTarget)}</b>. It expires in ${VERIFICATION_CODE_LIFETIME_MINUTES} minutes.</p>
    <div class="addrow"><input id="code_${channel}" inputmode="numeric" autocomplete="one-time-code" maxlength="${VERIFICATION_CODE_DIGITS}" placeholder="123456" class="mono code" aria-label="Verification code">
      <button class="btn sm primary" data-confirmcode="${channel}">Confirm</button><button class="btn sm" data-editcontact="${channel}">Use a different ${CHANNEL_WORDS[channel].thing}</button></div></div>`;
}
function contactCardHTML(channel) {
  const state = contactState(channel), words = CHANNEL_WORDS[channel];
  const nothingSaved = !state.saved && !state.accountEmail;
  const waitingForCode = state.channelOn && state.pendingTarget && state.step.codeSent !== false && !state.step.editing;
  let body, pill;

  if (waitingForCode) {
    body = codeEntryHTML(channel, state);
    pill = '<span class="pill">Waiting for code</span>';
  } else if (state.step.editing || nothingSaved) {
    body = contactInputHTML(channel, state);
    pill = `<span class="pill">No ${words.thing} yet</span>`;
  } else if (state.saved && !state.confirmed) {
    const shown = state.isEmail ? esc(state.saved) : `<span class="mono">${esc(state.saved)}</span>`;
    const next = state.channelOn
      ? `<button class="btn sm primary" data-sendsaved="${channel}">Send confirmation code</button>`
      : `<span class="note">You'll confirm it with a code once ${words.alerts.toLowerCase()} are turned on${can("alerts.configure") ? ' (under <button class="linkbtn" data-view="alertSetup">Alert setup</button>)' : " by an admin"}.</span>`;
    body = `<p>Saved: <b>${shown}</b></p><div class="btns">${next}<button class="btn sm" data-editcontact="${channel}">Change</button><button class="btn sm danger" data-removecontact="${channel}">Remove</button></div>`;
    pill = '<span class="pill warn">Not confirmed</span>';
  } else {
    const usingAccountEmail = state.isEmail && !state.saved;
    const shown = state.isEmail ? esc(state.deliversTo) : `<span class="mono">${esc(state.deliversTo)}</span>`;
    const testButton = state.channelOn
      ? `<button class="btn sm" data-testalert="${channel}">Send a test ${words.test}</button>`
      : `<span class="note">${words.alerts} aren't turned on for this desk yet, so there's nothing to test.</span>`;
    body = `<p>Alerts go to <b>${shown}</b> ${usingAccountEmail ? '<span class="sub">(your account email)</span>' : ""}</p>
      <div class="btns"><button class="btn sm" data-editcontact="${channel}">${usingAccountEmail ? "Use a different address" : "Change"}</button>
        ${usingAccountEmail ? "" : `<button class="btn sm danger" data-removecontact="${channel}">Remove</button>`}${testButton}</div>`;
    pill = state.channelOn ? '<span class="pill ok">On</span>' : '<span class="pill off">Saved · alerts off for the desk</span>';
  }
  return `<div class="contact"><div class="contact-h"><h3>${words.name}</h3>${pill}</div>${body}</div>`;
}
function priorityFilterHTML(event) {
  return `<select id="minp_${event.key}" data-minp="${event.key}" aria-label="Which priorities">
    ${PRIORITY_FILTER_CHOICES.map(([value, label]) => `<option value="${value}" ${event.minPriority === value ? "selected" : ""}>${label}</option>`).join("")}</select>`;
}
function deliveryNotesHTML() {
  const { channels, contact } = M.myAlerts, notes = [];
  if (!channels.email && !channels.sms) notes.push(`Email and text alerts aren't turned on for this desk yet. You can choose your alerts now; they start once ${can("alerts.configure") ? 'you set up delivery under <button class="linkbtn" data-view="alertSetup">Alert setup</button>' : "an admin sets up delivery"}.`);
  else {
    if (channels.email && !contact.emailTo) notes.push("Add an email address above to start getting email alerts.");
    if (channels.sms && !contact.phoneVerified) notes.push("Add and confirm a mobile number above to start getting text alerts.");
  }
  return notes.map((note) => `<p class="note">${note}</p>`).join("");
}
function myAlertsHTML() {
  const alerts = M.myAlerts;
  if (!alerts) return `<div class="topbar"><h1>My alerts</h1></div><div class="tablewrap"><div class="empty">Loading…</div></div>`;
  const groupNames = [...new Set(alerts.events.map((e) => e.group))];
  const eventRow = (event) => `<tr>
    <td><div>${esc(event.label)}</div>${event.hint ? `<div class="sub">${esc(event.hint)}</div>` : ""}${event.hasPriorityFilter ? `<div class="mt">${priorityFilterHTML(event)}</div>` : ""}</td>
    <td class="c"><input type="checkbox" id="pe_${event.key}" data-pref="${event.key}" data-channel="email" ${event.email ? "checked" : ""} aria-label="Email: ${esc(event.label)}"></td>
    <td class="c"><input type="checkbox" id="ps_${event.key}" data-pref="${event.key}" data-channel="sms" ${event.sms ? "checked" : ""} aria-label="Text: ${esc(event.label)}"></td></tr>`;
  const groupRows = (group) => `<tbody><tr class="grp"><th colspan="3">${esc(group)}</th></tr>${alerts.events.filter((e) => e.group === group).map(eventRow).join("")}</tbody>`;
  return `<div class="topbar"><h1>My alerts</h1></div>
    <p class="note lead">Choose what Lighthouse tells you about, and whether it emails you, texts you, or both. Texts are best kept for things that need you right away.</p>
    <section class="settings-card"><h2>Where alerts go</h2><div class="contacts">${contactCardHTML("email")}${contactCardHTML("sms")}</div></section>
    <section class="settings-card"><div class="row-actions"><div><h2>Pause all alerts</h2><p class="note">Stops every email and text until you turn alerts back on. Good for leave or days off.</p></div>
      <label class="switch"><input type="checkbox" id="al_paused" ${alerts.paused ? "checked" : ""}><span class="slider" aria-hidden="true"></span><span class="sr">Pause all alerts</span></label></div>
      ${alerts.paused ? '<div class="banner warn">Alerts are paused. You will not get any email or texts from Lighthouse.</div>' : ""}</section>
    <section class="settings-card"><h2>What to alert me about</h2>
      ${deliveryNotesHTML()}
      <div class="tablewrap flat"><table class="prefs"><thead><tr><th>Alert</th><th class="c">Email</th><th class="c">Text</th></tr></thead>
      ${groupNames.map(groupRows).join("")}</table></div>
      <p class="note">You never get alerts about your own changes. Task due-date reminders go out once a day in the morning.</p></section>`;
}
async function saveAlertPreference(eventKey, changes) {
  const event = M.myAlerts.events.find((e) => e.key === eventKey);
  const preference = { email: event.email, sms: event.sms, minPriority: event.minPriority, ...changes };
  M.myAlerts = await act(() => api("PUT", "/api/alerts/me/prefs", { prefs: { [eventKey]: preference } }), "Saved");
}
async function startConfirmation(button, channel, target) {
  if (!target) { $("#target_" + channel)?.focus(); return; }
  button.disabled = true;
  try {
    const result = await act(() => api("POST", "/api/alerts/me/verify/start", { channel, target }));
    M.myAlerts = result;
    if (result.verified) { M.contactSteps[channel] = {}; toast("Alerts will go to your account email"); }
    else if (result.saved) { M.contactSteps[channel] = {}; toast(`Saved. You'll confirm it once ${CHANNEL_WORDS[channel].alerts.toLowerCase()} are on.`); }
    else { M.contactSteps[channel] = { codeSent: true }; toast("Code sent"); }
    LH.render();
    $("#code_" + channel)?.focus();
  } catch {
    button.disabled = false;
  }
}
const myAlertsPage = {
  key: "alerts", label: "My alerts", section: "Me",
  load: async () => { M.myAlerts = await api("GET", "/api/alerts/me"); },
  html: myAlertsHTML,
  reset: () => { M.contactSteps = {}; },
  async onClick(element, data) {
    if (data.sendcode !== undefined) { await startConfirmation(element, data.sendcode, $("#target_" + data.sendcode).value.trim()); return true; }
    if (data.sendsaved !== undefined) { await startConfirmation(element, data.sendsaved, contactState(data.sendsaved).saved); return true; }
    if (data.confirmcode !== undefined) {
      const channel = data.confirmcode;
      M.myAlerts = await act(() => api("POST", "/api/alerts/me/verify/confirm", { channel, code: $("#code_" + channel).value }), channel === "sms" ? "Mobile number confirmed" : "Email address confirmed");
      M.contactSteps[channel] = {}; LH.render(); return true;
    }
    if (data.editcontact !== undefined) { M.contactSteps[data.editcontact] = { editing: true }; LH.render(); $("#target_" + data.editcontact)?.focus(); return true; }
    if (data.canceledit !== undefined) { M.contactSteps[data.canceledit] = {}; LH.render(); return true; }
    if (data.removecontact !== undefined) {
      M.myAlerts = await act(() => api("DELETE", "/api/alerts/me/contact/" + data.removecontact), data.removecontact === "sms" ? "Mobile number removed" : "Alert email removed");
      LH.render(); return true;
    }
    if (data.testalert !== undefined) {
      element.disabled = true;
      try {
        const result = await act(() => api("POST", "/api/alerts/me/test", { channel: data.testalert }));
        toast(`Test ${CHANNEL_WORDS[data.testalert].test} sent to ${result.to}`);
      } finally { element.disabled = false; }
      return true;
    }
    return false;
  },
  async onChange(element) {
    if (element.id === "al_paused") {
      M.myAlerts = await act(() => api("PUT", "/api/alerts/me/paused", { paused: element.checked }), element.checked ? "Alerts paused" : "Alerts back on");
      LH.render(); return true;
    }
    if (element.dataset.pref) {
      try { await saveAlertPreference(element.dataset.pref, { [element.dataset.channel]: element.checked }); }
      catch { element.checked = !element.checked; }
      LH.render(); return true;
    }
    if (element.dataset.minp) { await saveAlertPreference(element.dataset.minp, { minPriority: element.value }); LH.render(); return true; }
    return false;
  },
  onKeydown(event, element) {
    if (event.key !== "Enter") return false;
    const match = /^(target|code)_(email|sms)$/.exec(element.id || "");
    if (!match) return false;
    const [, step, channel] = match;
    event.preventDefault();
    document.querySelector(step === "target" ? `[data-sendcode="${channel}"]` : `[data-confirmcode="${channel}"]`)?.click();
    return true;
  },
};

// ---------- Appearance ----------
const appearancePage = {
  key: "appearance", label: "Appearance", section: "Me",
  html() {
    const current = S.me.theme || "system";
    const choice = (option) => `<label class="theme-choice theme-${option.value}">
      <input type="radio" name="theme" value="${option.value}" ${current === option.value ? "checked" : ""}>
      <span class="theme-preview" aria-hidden="true"><span class="tp-bar"></span><span class="tp-line"></span><span class="tp-line short"></span></span>
      <span class="theme-label"><b>${option.label}</b><span class="sub">${option.hint}</span></span></label>`;
    return `<div class="topbar"><h1>Appearance</h1></div>
      <section class="settings-card"><h2>Theme</h2>
        <div class="theme-choices" role="radiogroup" aria-label="Theme">${THEME_CHOICES.map(choice).join("")}</div>
        <p class="note">Saved to your account, so it follows you to other browsers and devices.</p></section>`;
  },
  async onChange(element) {
    if (element.name !== "theme") return false;
    LH.applyTheme(element.value); // show it straight away
    await act(() => api("PUT", "/api/me/theme", { theme: element.value }), "Theme saved");
    S.me.theme = element.value;
    return true;
  },
};

// ---------- Password ----------
const passwordPage = {
  key: "password", label: "Password", section: "Me",
  html: () => `<div class="topbar"><h1>Password</h1></div>${LH.passwordFormHTML(false)}<p class="note">Changing your password signs you out on every other device.</p>`,
  holdsForm: () => !!$("#pwForm"),
};

LH.addSettingsPages(profilePage, myAlertsPage, appearancePage, passwordPage);

// ---------- the tab ----------
function railHTML(view) {
  const current = pageFor(view);
  const link = (page) => `<button data-view="${page.key}" aria-current="${page === current}"><span>${page.label}</span><span class="count"></span></button>`;
  const section = (name) => {
    const pages = visiblePages().filter((page) => page.section === name);
    return pages.length ? `<div><div class="navlabel">${name}</div><nav class="nav">${pages.map(link).join("")}</nav></div>` : "";
  };
  return section("Me") + section("Admin");
}
// Passes an event to the current page's handler of that name.
const toCurrentPage = (handlerName, ...args) => (S.tab === "settings" && currentPage()[handlerName] ? currentPage()[handlerName](...args) : false);

LH.register({
  tab: "settings", label: "Settings",
  defaultView: () => "profile",
  load: () => currentPage().load?.(),
  railHTML,
  mainHTML: () => currentPage().html(),
  keepMain: () => !!currentPage().holdsForm?.(),
  onViewClick: () => PAGES.forEach((page) => page.reset?.()),
  onSubmit: (event, form) => toCurrentPage("onSubmit", form),
  onClick: (event, element) => toCurrentPage("onClick", element, element.dataset),
  onChange: (event, element) => toCurrentPage("onChange", element),
  onInput: (event, element) => toCurrentPage("onInput", element),
  onKeydown: (event, element) => toCurrentPage("onKeydown", event, element),
});
})();
