// Lighthouse web app — the shared core.
//
// The app is split into "tabs" (Tickets, Projects, Settings). Each tab is a module in its own file that
// registers itself with LH.register({...}) and supplies:
//   tab, label           identity shown in the tab bar
//   isVisible()          whether this person's access level shows the tab at all
//   defaultView()        which page of the tab opens first
//   load(view)           fetch the data that page needs
//   railHTML(view)       the left-hand menu
//   mainHTML(view)       the page itself
//   keepMain(view)       return true while a half-filled form is on screen, so a refresh doesn't wipe it
//   panelType, panelHTML(panel), loadPanel(panel)   the slide-in detail panel (a ticket, a task)
//   onClick / onChange / onInput / onSubmit / onKeydown(event, element)   return true when handled
//
// This file holds what every tab shares: the signed-in person, API calls, the shell, the theme, and events.
(() => {
"use strict";

// ---------- settings ----------
const REFRESH_EVERY_MS = 15000;          // how often open pages refresh their data
const TOAST_VISIBLE_MS = 2600;
const ERROR_TOAST_VISIBLE_MS = 5000;
const THEME_STORAGE_KEY = "lh.theme";    // remembered in the browser too, so the right theme shows before sign-in finishes
const MINUTES_PER_HOUR = 60, HOURS_BEFORE_SHOWING_DAYS = 48, HOURS_PER_DAY = 24, MS_PER_MINUTE = 60000, MS_PER_DAY = 86400000;
const DAYS_SHOWN_AS_WEEKDAY = 7;
// Account rules used by the sign-in screens, which show before the server's constants have loaded.
// They match lib/constants.js; the server checks them again either way.
const ACCOUNT_RULES = { maxNameLength: 80, minUsernameLength: 3, maxUsernameLength: 32, minPasswordLength: 10 };

// ---------- shared state ----------
const S = {
  me: null,                 // the signed-in person, including me.permissions
  users: new Map(),         // people this person may see, by id
  groups: new Map(),        // resolver groups, by id
  C: null,                  // fixed lists from the server (priorities, statuses, limits...)
  alertChannels: {},        // which alert channels the server has set up
  tickets: new Map(),
  ticketsLoaded: false,
  tab: "tickets",
  views: {},                // the current page of each tab
  panel: null,              // the open detail panel: { type: "ticket" | "task", id }
};
const modules = [];

// ---------- small helpers ----------
const $ = (selector, root = document) => root.querySelector(selector);
const escapeHtml = (text) => String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const esc = escapeHtml;
const twoDigits = (n) => String(n).padStart(2, "0");
const isoDay = (date = new Date()) => `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
const formatDateTime = (ms) => (ms ? new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");

// 35 min -> "35m", 5 hours -> "5h", 3 days -> "3d"
function shortDuration(ms) {
  const minutes = Math.round(Math.abs(ms) / MS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) return minutes + "m";
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_BEFORE_SHOWING_DAYS) return hours + "h";
  return Math.round(hours / HOURS_PER_DAY) + "d";
}

// How a task due date reads: "Today", "Tomorrow", "Wed", or "Oct 30"; with a CSS class for overdue / today / soon.
function dueDateLabel(isoDate) {
  if (!isoDate) return { text: "", cssClass: "" };
  const today = isoDay(), tomorrow = isoDay(new Date(Date.now() + MS_PER_DAY));
  const date = new Date(isoDate + "T12:00:00");
  if (isoDate < today) return { text: date.toLocaleDateString([], { month: "short", day: "numeric" }), cssClass: "overdue" };
  if (isoDate === today) return { text: "Today", cssClass: "today" };
  if (isoDate === tomorrow) return { text: "Tomorrow", cssClass: "soon" };
  const daysAway = Math.round((date - new Date(today + "T12:00:00")) / MS_PER_DAY);
  const text = daysAway < DAYS_SHOWN_AS_WEEKDAY ? date.toLocaleDateString([], { weekday: "short" }) : date.toLocaleDateString([], { month: "short", day: "numeric" });
  return { text, cssClass: "" };
}

let toastTimer;
function toast(message, isError = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = "toast" + (isError ? " err" : "");
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), isError ? ERROR_TOAST_VISIBLE_MS : TOAST_VISIBLE_MS);
}

// ---------- talking to the server ----------
const HTTP_UNAUTHORIZED = 401;
async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    // The custom header is part of the server's cross-site request protection.
    headers: { "Content-Type": "application/json", "X-Lighthouse": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  const signedOut = response.status === HTTP_UNAUTHORIZED && !url.startsWith("/api/login") && !url.startsWith("/api/me/password");
  if (signedOut) { stopRefreshing(); showSignIn(); throw new Error(data.error || "Signed out"); }
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
// Runs an API call, shows a toast on success (if given) or the server's error message on failure.
async function act(apiCall, successMessage) {
  try {
    const result = await apiCall();
    if (successMessage) toast(successMessage);
    return result;
  } catch (error) {
    toast(error.message, true);
    throw error;
  }
}

// ---------- the signed-in person and other people ----------
const can = (permissionKey) => !!S.me && S.me.permissions.includes(permissionKey);
const isAdministrator = () => !!S.me?.isAdministrator;
const userName = (id) => (id ? S.users.get(id)?.name || "Former user" : "");
const initials = (name) => (name || "?").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("");
// A person's photo address, or null. The version in the address changes whenever the photo does.
function photoUrl(id) {
  const version = S.users.get(id)?.photoVersion ?? (id === S.me?.id ? S.me.photoVersion : null);
  return version ? `/api/users/${id}/photo?v=${version}` : null;
}
// A small round picture of a person: their photo if they have one, otherwise their initials.
function avatar(id, extraClass = "") {
  const url = photoUrl(id);
  if (url) return `<img class="av photo ${extraClass}" src="${url}" alt="" title="${esc(userName(id))}" loading="lazy">`;
  return `<span class="av ${extraClass}" title="${esc(userName(id))}" aria-hidden="true">${esc(initials(userName(id)))}</span>`;
}
function personHTML(id, whenEmpty = "Unassigned") {
  if (!id) return `<span class="none">${esc(whenEmpty)}</span>`;
  const you = id === S.me.id ? ' <span class="sub">(you)</span>' : "";
  return `<span class="person">${avatar(id)}<span>${esc(userName(id))}${you}</span></span>`;
}
const byName = (a, b) => a.name.localeCompare(b.name);
const peopleWhoCanTakeTickets = () => [...S.users.values()].filter((u) => u.canBeAssigned).sort(byName);
const peopleWhoUseProjects = () => [...S.users.values()].filter((u) => u.usesProjects).sort(byName);
function personOptions(people, selectedId, emptyLabel = "Unassigned") {
  const options = people.map((u) => `<option value="${u.id}" ${Number(selectedId) === u.id ? "selected" : ""}>${esc(u.name)}${u.id === S.me.id ? " (you)" : ""}</option>`);
  return `<option value="">${esc(emptyLabel)}</option>` + options.join("");
}

// ---------- photo uploads ----------
// Shrinks a photo the person picked to a centred square JPEG before upload. This keeps uploads small,
// and redrawing the picture also drops any hidden details in the file, such as where it was taken.
const PHOTO_JPEG_QUALITY_STEPS = [0.88, 0.8, 0.7, 0.6, 0.5];
const BASE64_BYTES_PER_CHARACTER = 3 / 4;
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("That file couldn't be read."));
    reader.readAsDataURL(file);
  });
}
function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("That file isn't a picture this browser can open. Try a JPEG or PNG."));
    image.src = dataUrl;
  });
}
async function preparePhotoUpload(file) {
  if (!file || !file.type.startsWith("image/")) throw new Error("Choose a picture file (JPEG, PNG, HEIC...).");
  const image = await loadImage(await readFileAsDataUrl(file));
  const size = S.C.PHOTO_SIZE_PX;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const shortestSide = Math.min(image.naturalWidth, image.naturalHeight);
  const cropX = (image.naturalWidth - shortestSide) / 2, cropY = (image.naturalHeight - shortestSide) / 2;
  canvas.getContext("2d").drawImage(image, cropX, cropY, shortestSide, shortestSide, 0, 0, size, size);
  for (const quality of PHOTO_JPEG_QUALITY_STEPS) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    const approximateBytes = (dataUrl.length - dataUrl.indexOf(",") - 1) * BASE64_BYTES_PER_CHARACTER;
    if (approximateBytes <= S.C.MAX_PHOTO_BYTES) return dataUrl;
  }
  throw new Error("That photo couldn't be made small enough. Try a different one.");
}

// ---------- theme ----------
// "system" follows the device's light/dark setting; "light" and "dark" override it.
function applyTheme(theme) {
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_STORAGE_KEY, theme || "system"); } catch { /* storage may be blocked; the server copy still applies */ }
}
try { applyTheme(localStorage.getItem(THEME_STORAGE_KEY) || "system"); } catch { /* ignore */ }

// ---------- shared data ----------
async function loadBootstrap() {
  const data = await api("GET", "/api/bootstrap");
  S.me = data.me;
  S.C = data.constants;
  S.alertChannels = data.alertChannels || {};
  S.users = new Map(data.users.map((u) => [u.id, u]));
  S.groups = new Map(data.groups.map((g) => [g.id, g]));
  applyTheme(S.me.theme);
}
async function loadTickets() {
  const data = await api("GET", "/api/tickets");
  S.tickets = new Map(data.tickets.map((t) => [t.id, t]));
  S.ticketsLoaded = true;
}

// ---------- modules and navigation ----------
function register(module) { modules.push(module); }
const moduleFor = (tab = S.tab) => modules.find((m) => m.tab === tab);
const visibleModules = () => modules.filter((m) => !m.isVisible || m.isVisible());
const currentView = () => S.views[S.tab] ?? (S.views[S.tab] = moduleFor().defaultView());
const panelOwner = () => S.panel && modules.find((m) => m.panelType === S.panel.type);

async function loadCurrentPage() {
  const module = moduleFor();
  await Promise.all([module.load ? module.load(currentView()) : null, S.panel ? loadPanel() : null]);
}
async function loadPanel() {
  const owner = panelOwner();
  if (!owner?.loadPanel) return;
  const found = await owner.loadPanel(S.panel).catch(() => false);
  if (found === false) S.panel = null;
}

// Opens a tab (and optionally one of its pages). The page is rebuilt from scratch.
async function go(tab, view, { keepPanel = false } = {}) {
  if (!visibleModules().some((m) => m.tab === tab)) tab = visibleModules()[0].tab;
  S.tab = tab;
  if (view !== undefined) S.views[tab] = view;
  if (!keepPanel) closePanel(false);
  const main = $("#main");
  if (main) main.innerHTML = "";
  render();
  try { await loadCurrentPage(); } catch (error) { toast(error.message, true); }
  render();
  window.scrollTo(0, 0);
}

async function openPanel(type, id) {
  S.panel = { type, id };
  const owner = panelOwner();
  // Opening a task from the Tickets tab (or a ticket from Projects) switches to the tab it belongs to.
  if (owner && owner.tab !== S.tab) {
    S.tab = owner.tab;
    const main = $("#main");
    if (main) main.innerHTML = "";
    try { await owner.load?.(currentView()); } catch { /* the panel still opens */ }
  }
  await loadPanel();
  render();
  $(".panel [data-close].btn")?.focus();
}
function closePanel(redraw = true) {
  const wasOpen = S.panel;
  S.panel = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
  if (redraw && wasOpen) {
    render();
    document.querySelector(`[data-open="${wasOpen.id}"],[data-task="${wasOpen.id}"]`)?.focus();
  }
}

// ---------- sign-in screens ----------
const LOGO_SVG = `<svg class="logo" width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><path class="beam" d="M12.6 5.2 19 3v5.4l-6.4-1.6zM7.4 5.2 1 3v5.4l6.4-1.6z"/><path d="M7.6 6.8h4.8M7.9 6.8 7 18h6l-.9-11.2M8 4.6 10 3l2 1.6v2.2H8zM7.4 11.2h5.2M5.5 18h9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
const brandHTML = () => `<div class="brand">${LOGO_SVG}Lighthouse</div>`;

function showSignIn(message = "") {
  $("#overlay").innerHTML = "";
  $("#root").innerHTML = `<div class="auth"><form id="loginForm">${brandHTML()}<h1>Sign in</h1>
    <label class="f">Username<input id="l_username" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <label class="f">Password<input id="l_pw" type="password" autocomplete="current-password" required></label>
    <p class="err" id="l_err">${esc(message)}</p>
    <button class="btn primary" type="submit">Sign in</button>
    <p class="note"><button type="button" class="linkbtn" data-forgot>Forgot your password?</button> · No account? Ask a desk admin to create one for you.</p></form></div>`;
  $("#l_username").focus();
}
// "Forgot password?": emails a one-time passphrase to the address on the account (see lib/password-reset.js).
function showForgotPassword() {
  $("#root").innerHTML = `<div class="auth"><form id="forgotForm">${brandHTML()}<h1>Reset your password</h1>
    <p class="note">Enter your username or the email address on your account. If the account has an email address on file, we'll send it a temporary passphrase to sign in with.</p>
    <label class="f">Username or email<input id="f_identifier" autocomplete="username" autocapitalize="none" spellcheck="false" required></label>
    <p class="err" id="f_err"></p><div class="banner" id="f_done" hidden></div>
    <button class="btn primary" type="submit" id="f_submit">Email me a passphrase</button>
    <p class="note"><button type="button" class="linkbtn" data-backtosignin>Back to sign in</button> · No email on your account? Ask a desk admin to reset your password.</p></form></div>`;
  $("#f_identifier").focus();
}
async function submitForgotPassword() {
  const button = $("#f_submit");
  button.disabled = true;
  try {
    const result = await api("POST", "/api/password-reset", { identifier: $("#f_identifier").value });
    $("#f_err").textContent = "";
    $("#f_done").textContent = result.message;
    $("#f_done").hidden = false;
    button.textContent = "Sent";
  } catch (error) {
    $("#f_err").textContent = error.message;
    button.disabled = false;
  }
}
function showFirstRunSetup() {
  $("#root").innerHTML = `<div class="auth"><form id="setupForm">${brandHTML()}<h1>Set up your desk</h1>
    <p class="note">Create the first Administrator account. You can add people, access levels and resolver groups after this.</p>
    <label class="f">Setup code<input id="s_code" required autocomplete="off" spellcheck="false" class="mono"><span class="note">Printed in the server log when Lighthouse starts, or the value of SETUP_TOKEN.</span></label>
    <label class="f">Your name<input id="s_name" required maxlength="${ACCOUNT_RULES.maxNameLength}" autocomplete="name"></label>
    <label class="f">Username<input id="s_username" required autocomplete="username" autocapitalize="none" spellcheck="false" pattern="[A-Za-z0-9._\\-]{${ACCOUNT_RULES.minUsernameLength},${ACCOUNT_RULES.maxUsernameLength}}"><span class="note">${ACCOUNT_RULES.minUsernameLength}–${ACCOUNT_RULES.maxUsernameLength} letters, numbers, dots, dashes or underscores. This is what you sign in with.</span></label>
    <label class="f">Email (optional)<input id="s_email" type="email" autocomplete="email"><span class="note">Only used for email alerts.</span></label>
    <label class="f">Password (${ACCOUNT_RULES.minPasswordLength}+ characters)<input id="s_pw" type="password" required minlength="${ACCOUNT_RULES.minPasswordLength}" autocomplete="new-password"></label>
    <p class="err" id="s_err"></p>
    <button class="btn primary" type="submit">Create Administrator account</button></form></div>`;
  $("#s_code").focus();
}
function passwordFormHTML(isForced) {
  const heading = isForced
    ? `${brandHTML()}<h1>Choose a new password</h1><p class="note">You signed in with a temporary password or passphrase. Pick your own before continuing. Under "Current password", enter the one you just signed in with.</p>`
    : "<h2>Change password</h2>";
  return `<form id="pwForm" class="${isForced ? "" : "formcard"}">${heading}
    <label class="f">Current password<input id="p_cur" type="password" required autocomplete="current-password"></label>
    <label class="f">New password (${ACCOUNT_RULES.minPasswordLength}+ characters)<input id="p_new" type="password" required minlength="${ACCOUNT_RULES.minPasswordLength}" autocomplete="new-password"></label>
    <label class="f">Repeat new password<input id="p_new2" type="password" required minlength="${ACCOUNT_RULES.minPasswordLength}" autocomplete="new-password"></label>
    <p class="err" id="p_err"></p>
    <div class="btns"><button class="btn primary" type="submit">Save password</button></div></form>`;
}

// ---------- the shell: app bar with tabs, left rail, main area ----------
const TAB_ICONS = {
  tickets: '<path d="M3 8V6.5a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1V8a2 2 0 0 0 0 4v1.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V12a2 2 0 0 0 0-4Z"/><path d="M12 7v8" stroke-dasharray="1.5 1.5"/>',
  projects: '<rect x="3" y="3.5" width="4" height="13" rx="1"/><rect x="8.5" y="3.5" width="4" height="9" rx="1"/><rect x="14" y="3.5" width="3" height="6" rx="1"/>',
  settings: '<path d="M4 6h7M15 6h1M4 14h1M9 14h7"/><circle cx="13" cy="6" r="2"/><circle cx="7" cy="14" r="2"/>',
};

function tabButtonHTML(module) {
  const icon = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round">${TAB_ICONS[module.tab] || ""}</svg>`;
  return `<button class="tab" data-tab="${module.tab}" aria-current="${S.tab === module.tab ? "page" : "false"}">${icon}<span>${esc(module.label)}</span>${module.badgeHTML ? module.badgeHTML() : ""}</button>`;
}

function render() {
  if (!S.me) return;
  if (S.me.mustChangePassword) {
    if (!$("#pwForm")) $("#root").innerHTML = `<div class="auth">${passwordFormHTML(true)}</div>`;
    return;
  }
  if (!$(".app")) {
    $("#root").innerHTML = `<div class="app">
      <header class="appbar">${brandHTML()}<nav class="tabs" id="tabs" aria-label="Sections"></nav><div class="who" id="who"></div></header>
      <div class="workspace"><aside class="rail" id="rail"></aside><main class="main" id="main"></main></div></div>`;
  }
  $("#tabs").innerHTML = visibleModules().map(tabButtonHTML).join("");
  $("#who").innerHTML = `${avatar(S.me.id, "lg")}<div class="who-text"><div class="n">${esc(S.me.name)}</div><div class="sub">${esc(S.me.accessLevelName)} · <button data-logout>Sign out</button></div></div>`;

  const module = moduleFor(), view = currentView();
  $("#rail").innerHTML = module.railHTML(view);
  const main = $("#main");
  // Remember which field had focus (and where the cursor was) so redrawing doesn't interrupt typing.
  const focused = document.activeElement;
  const focusedId = focused && focused.id && main.contains(focused) ? focused.id : null;
  let cursor = null;
  try { cursor = focusedId && "selectionStart" in focused ? focused.selectionStart : null; } catch { cursor = null; }
  const formIsBeingFilledIn = module.keepMain && main.firstChild && module.keepMain(view);
  if (!formIsBeingFilledIn) main.innerHTML = module.mainHTML(view);
  if (focusedId) {
    const again = document.getElementById(focusedId);
    if (again && again !== document.activeElement) { again.focus(); try { if (cursor != null) again.setSelectionRange(cursor, cursor); } catch { /* not a text field */ } }
  }
  renderPanel();
}

function renderPanel() {
  const overlay = $("#overlay");
  const owner = panelOwner();
  if (!owner) { overlay.innerHTML = ""; return; }
  const scrollTop = $(".panel .body")?.scrollTop || 0;
  const focusedId = document.activeElement?.id && overlay.contains(document.activeElement) ? document.activeElement.id : null;
  overlay.innerHTML = `<div class="scrim" data-close></div>${owner.panelHTML(S.panel)}`;
  const body = $(".panel .body");
  if (body) body.scrollTop = scrollTop;
  if (focusedId) document.getElementById(focusedId)?.focus();
}

// ---------- keeping pages fresh ----------
let refreshTimer = null;
const personIsBusy = () => (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) || document.body.classList.contains("dragging-active");
function startRefreshing() {
  stopRefreshing();
  refreshTimer = setInterval(async () => {
    if (document.hidden) return;
    try { await loadBootstrap(); await loadCurrentPage(); if (!personIsBusy()) render(); }
    catch { /* errors are shown by the next action */ }
  }, REFRESH_EVERY_MS);
}
function stopRefreshing() { clearInterval(refreshTimer); refreshTimer = null; }

// ---------- links straight to an item: #ticket-12, #task-34, #project-5 ----------
async function openItemFromAddress() {
  const match = /^#(ticket|task|project)-(\d+)$/.exec(location.hash);
  if (!match) return false;
  const [, kind, idText] = match, id = Number(idText);
  if (kind === "ticket") { await go("tickets"); await openPanel("ticket", id); }
  else if (kind === "task" && can("projects.access")) { await go("projects"); await openPanel("task", id); }
  else if (kind === "project" && can("projects.access")) await go("projects", "project:" + id);
  return true;
}
window.addEventListener("hashchange", () => { if (S.me) openItemFromAddress(); });

// ---------- events: core actions first, then each module in turn ----------
async function passToModules(handlerName, event, element) {
  for (const module of modules) {
    const handler = module[handlerName];
    if (handler && (await handler(event, element))) return true;
  }
  return false;
}

async function submitSignIn() {
  try { await api("POST", "/api/login", { username: $("#l_username").value, password: $("#l_pw").value }); }
  catch (error) { $("#l_err").textContent = error.message; return; }
  return start();
}
async function submitFirstRunSetup() {
  const body = { setupCode: $("#s_code").value, name: $("#s_name").value, username: $("#s_username").value, email: $("#s_email").value, password: $("#s_pw").value };
  try { await api("POST", "/api/setup", body); }
  catch (error) { $("#s_err").textContent = error.message; return; }
  return start();
}
async function submitPasswordChange() {
  if ($("#p_new").value !== $("#p_new2").value) { $("#p_err").textContent = "The new passwords do not match."; return; }
  try { await api("POST", "/api/me/password", { current: $("#p_cur").value, next: $("#p_new").value }); }
  catch (error) { $("#p_err").textContent = error.message; return; }
  toast("Password changed");
  $("#root").innerHTML = "";
  return start();
}

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id === "loginForm") return submitSignIn();
  if (form.id === "setupForm") return submitFirstRunSetup();
  if (form.id === "pwForm") return submitPasswordChange();
  if (form.id === "forgotForm") return submitForgotPassword();
  try { await passToModules("onSubmit", event, form); } catch { /* the toast already explained */ }
});

document.addEventListener("click", async (event) => {
  const element = event.target.closest("button,[data-open],[data-task],[data-project],.scrim");
  if (!element) return;
  const data = element.dataset;
  try {
    if (data.forgot !== undefined) { event.preventDefault(); return showForgotPassword(); }
    if (data.backtosignin !== undefined) { event.preventDefault(); return showSignIn(); }
    if (data.logout !== undefined) { await api("POST", "/api/logout").catch(() => {}); S.me = null; stopRefreshing(); showSignIn(); return; }
    if (data.tab !== undefined) { event.preventDefault(); return go(data.tab); }
    if (data.close !== undefined) { event.preventDefault(); return closePanel(); }
    const isMenuLink = data.view !== undefined && !element.closest(".panel");
    if (isMenuLink) { event.preventDefault(); moduleFor().onViewClick?.(data); return go(S.tab, data.view); }
    await passToModules("onClick", event, element);
  } catch { /* the toast already explained */ }
});
document.addEventListener("change", async (event) => { try { await passToModules("onChange", event, event.target); } catch { /* toast shown */ } });
document.addEventListener("input", (event) => { passToModules("onInput", event, event.target); });
document.addEventListener("keydown", (event) => {
  const inTextField = event.target.closest?.("input,textarea,select");
  if (event.key === "Escape" && S.panel && !inTextField) { closePanel(); return; }
  const isOpenableRow = event.target.matches?.("tr.row,[data-task].row,[data-task].card,article[data-project]");
  if ((event.key === "Enter" || event.key === " ") && isOpenableRow) { event.preventDefault(); event.target.click(); return; }
  passToModules("onKeydown", event, event.target);
});

// ---------- start ----------
async function start() {
  try {
    const setup = await fetch("/api/setup").then((r) => r.json());
    if (setup.needsSetup) return showFirstRunSetup();
    await loadBootstrap();
  } catch {
    if (!S.me) showSignIn();
    return;
  }
  $("#root").innerHTML = "";
  const openedFromLink = await openItemFromAddress().catch(() => false);
  if (!openedFromLink) await go(S.tab);
  startRefreshing();
}

window.LH = {
  S, $, esc, escapeHtml, toast, formatDateTime, shortDuration, isoDay, dueDateLabel, api, act,
  can, isAdministrator, userName, initials, avatar, photoUrl, preparePhotoUpload, personHTML, peopleWhoCanTakeTickets, peopleWhoUseProjects, personOptions,
  loadBootstrap, loadTickets, register, go, currentView, render, renderPanel, openPanel, closePanel, passwordFormHTML, applyTheme,
};
document.addEventListener("DOMContentLoaded", start);
})();
