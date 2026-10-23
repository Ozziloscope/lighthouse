// Settings tab, admin pages. Each one shows only to people whose access level includes its permission:
//   Users           "Manage user accounts"           add people, temporary passwords, levels, photos
//   Access levels   "Manage access levels"           (Administrators) what each level may do
//   SLA targets     "Change SLA targets"             hours to resolve, per priority
//   Alert setup     "Set up email and text delivery" (Administrators) mail server and Twilio, with test sends
//   Alert delivery  "See the alert delivery log"     every email and text sent, with retry
// The page framework (LH.addSettingsPages) is described at the top of settings.js.
(() => {
"use strict";
const { S, $, esc, toast, formatDateTime, api, act, can, isAdministrator, userName, avatar, personHTML } = LH;
const rebuild = () => LH.rebuildSettingsPage();

const PRIORITY_LABELS = { P1: "P1 Critical", P2: "P2 High", P3: "P3 Normal", P4: "P4 Low" };
const HOURS_PER_DAY = 24;
const SYSTEM_EVENT_LABELS = { verify: "Verification code", test: "Test message", password_reset: "Temporary passphrase" };
const DELIVERY_STATUS_CLASS = { sent: "ok", failed: "bad", skipped: "off", pending: "" };

// Shared by Users and Access levels: the list of levels and permissions.
let accessLevels = null; // GET /api/access-levels: { levels, permissions, administratorOnlyPermissions }
const loadAccessLevels = async () => { accessLevels = await api("GET", "/api/access-levels"); };

// ========== Users ==========
const U = { adding: false, editingId: null, newCredentials: null, confirmingResetFor: null };

// Who can manage whom (the server enforces the same rules).
const holdsAll = (permissionKeys) => permissionKeys.every((key) => can(key));
const grantableLevels = () => (accessLevels?.levels || []).filter((level) => isAdministrator() || (!level.isAdministrator && holdsAll(level.permissions)));
function canManagePerson(person) {
  if (person.id === S.me.id) return false;
  if (isAdministrator()) return true;
  const level = accessLevels?.levels.find((l) => l.id === person.accessLevelId);
  return !!level && !level.isAdministrator && holdsAll(level.permissions);
}
const levelOptionsHTML = (selectedId) => grantableLevels().map((level) => `<option value="${level.id}" ${level.id === selectedId ? "selected" : ""}>${esc(level.name)}</option>`).join("");

function newCredentialsBannerHTML() {
  const credentials = U.newCredentials;
  if (!credentials) return "";
  return `<div class="banner creds row-actions"><div>
      <b>${credentials.isNewAccount ? "Account created." : "Password reset."}</b> Give these sign-in details to the person directly. This is the only time the password is shown.
      <dl class="kv"><dt>Username</dt><dd class="mono">${esc(credentials.username)}</dd><dt>Temporary password</dt><dd class="mono">${esc(credentials.password)}</dd></dl>
      <span class="sub">They'll choose their own password when they first sign in.</span></div>
    <span class="btns"><button class="btn sm" data-copycreds>Copy</button><button class="btn sm" data-dismisscreds>Done</button></span></div>`;
}
function userPhotoFieldHTML(person) {
  return `<div class="f"><span>Photo</span><div class="photo-editor">${avatar(person.id, "xl")}
    <span class="btns"><label class="btn sm file-btn">${person.photoVersion ? "Change photo" : "Upload photo"}<input type="file" id="u_photo" accept="image/*"></label>
      ${person.photoVersion ? '<button type="button" class="btn sm danger" data-removeuserphoto>Remove photo</button>' : ""}</span></div></div>`;
}
function userFormHTML() {
  const L = S.C.MAX_LENGTH;
  const editing = U.editingId ? S.users.get(U.editingId) : null;
  if (!U.adding && !editing) return "";
  const defaultLevel = grantableLevels().find((l) => l.name === "Technician") || grantableLevels().find((l) => !l.isAdministrator) || grantableLevels()[0];
  const levelField = editing ? "" : `<label class="f">Access level<select id="u_level" required>${levelOptionsHTML(defaultLevel?.id)}</select></label>`;
  return `<form class="formcard" id="userForm"><h2>${editing ? `Edit ${esc(editing.name)}` : "Add a user"}</h2>
    ${editing ? userPhotoFieldHTML(editing) : ""}
    <div class="grid2">
      <label class="f">Full name<input id="u_name" required maxlength="${L.personName}" value="${esc(editing?.name)}" autocomplete="off"></label>
      <label class="f">Username<input id="u_username" required minlength="${S.C.MIN_USERNAME_LENGTH}" maxlength="${L.username}" pattern="[A-Za-z0-9._\\-]+" value="${esc(editing?.username)}" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="e.g. jsmith"></label>
      <label class="f">Email (optional)<input id="u_email" type="email" maxlength="${L.email}" value="${esc(editing?.email)}" autocomplete="off"><span class="note">Used for alerts. People can add or change their own under My alerts.</span></label>
      ${levelField}
    </div>
    ${editing ? "" : '<p class="note">Lighthouse makes up a temporary password and shows it once after you create the account. People can add their own photo under My profile.</p>'}
    <div class="btns end"><button type="button" class="btn" data-canceluser>${editing ? "Close" : "Cancel"}</button><button class="btn primary" type="submit">${editing ? "Save changes" : "Create user"}</button></div></form>`;
}
function userRowHTML(person) {
  const openStatuses = new Set(S.C.OPEN_STATUSES);
  const openAssigned = [...S.tickets.values()].filter((t) => t.assigneeId === person.id && openStatuses.has(t.status)).length;
  const groups = [...S.groups.values()].filter((g) => g.members.includes(person.id)).map((g) => esc(g.name)).join(", ");
  const manageable = canManagePerson(person);
  const currentLevelIsGrantable = grantableLevels().some((l) => l.id === person.accessLevelId);
  const levelCell = manageable
    ? `<select id="level_${person.id}" data-level="${person.id}" aria-label="Access level for ${esc(person.name)}">${levelOptionsHTML(person.accessLevelId)}${currentLevelIsGrantable ? "" : `<option value="${person.accessLevelId}" selected disabled>${esc(person.accessLevelName)}</option>`}</select>`
    : `<span class="level-tag ${person.isAdministrator ? "admin" : ""}">${esc(person.accessLevelName)}</span>`;
  const actions = !manageable ? "" : U.confirmingResetFor === person.id
    ? `<span class="confirm inline"><span>Sign them out and make a new temporary password?</span><button class="btn sm" data-cancelreset>Cancel</button><button class="btn sm primary" data-confirmreset="${person.id}">Reset</button></span>`
    : `<button class="btn sm" data-edituser="${person.id}">Edit</button><button class="btn sm" data-reset="${person.id}">Reset password</button>${person.email ? `<button class="btn sm" data-emailpassphrase="${person.id}" title="Email ${esc(person.email)} a one-time passphrase">Email passphrase</button>` : ""}<button class="btn sm ${person.active ? "danger" : ""}" data-active="${person.id}" data-to="${person.active ? 0 : 1}">${person.active ? "Deactivate" : "Reactivate"}</button>`;
  const flags = [!person.active ? "deactivated" : "", person.mustChangePassword && person.active ? "temporary password" : ""].filter(Boolean).join(" · ");
  return `<tr class="${person.active ? "" : "inactive"}">
    <td>${personHTML(person.id)}${flags ? `<div class="sub">${flags}</div>` : ""}</td>
    <td class="mono">${esc(person.username)}</td>
    <td class="sub hide-sm">${person.email ? esc(person.email) : '<span class="none">None</span>'}</td>
    <td>${levelCell}</td>
    <td class="hide-sm">${groups || '<span class="none">None</span>'}</td>
    <td class="tid hide-sm">${openAssigned}</td>
    <td><span class="btns">${actions}</span></td></tr>`;
}
async function refreshPeople() { await Promise.all([LH.loadBootstrap(), LH.loadTickets(), loadAccessLevels()]); }
async function copyCredentials() {
  const { username, password } = U.newCredentials;
  try { await navigator.clipboard.writeText(`Lighthouse sign-in\nUsername: ${username}\nTemporary password: ${password}\n${location.origin}/`); toast("Copied"); }
  catch { toast("Copy isn't available here. Select the text instead.", true); }
}
const usersPage = {
  key: "users", label: "Users", section: "Admin",
  isVisible: () => can("users.manage"),
  load: () => Promise.all([loadAccessLevels(), LH.loadTickets()]),
  holdsForm: () => !!$("#userForm"),
  reset: () => Object.assign(U, { adding: false, editingId: null, confirmingResetFor: null }),
  html() {
    if (!accessLevels) return `<div class="topbar"><h1>Users</h1></div><div class="tablewrap"><div class="empty">Loading…</div></div>`;
    const people = [...S.users.values()].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
    return `<div class="topbar"><h1>Users</h1>${!U.adding && !U.editingId ? `<button class="btn primary" data-adduser>Add user</button>` : ""}</div>
      ${newCredentialsBannerHTML()}
      ${userFormHTML()}
      <div class="tablewrap"><table class="users"><thead><tr><th>Person</th><th>Username</th><th class="hide-sm">Email</th><th>Access level</th><th class="hide-sm">Resolver groups</th><th class="hide-sm">Open tickets</th><th></th></tr></thead>
        <tbody>${people.map(userRowHTML).join("")}</tbody></table></div>
      <p class="note">Moving someone to a level without a permission, or deactivating them, releases the work that needed it: their tickets and tasks are unassigned and they leave groups and projects they can no longer be part of.
        ${can("access.manage") ? 'Change what each level allows under <button class="linkbtn" data-view="levels">Access levels</button>.' : ""}</p>`;
  },
  async onSubmit(form) {
    if (form.id !== "userForm") return false;
    const details = { name: $("#u_name").value, username: $("#u_username").value, email: $("#u_email").value };
    if (U.editingId) {
      await act(() => api("PATCH", "/api/users/" + U.editingId, details), "Saved");
      U.editingId = null;
    } else {
      const result = await act(() => api("POST", "/api/users", { ...details, accessLevelId: Number($("#u_level").value) }), "User created");
      U.newCredentials = { username: result.user.username, password: result.temporaryPassword, isNewAccount: true };
      U.adding = false;
    }
    await refreshPeople(); rebuild(); return true;
  },
  async onClick(element, data) {
    if (data.adduser !== undefined) { U.adding = true; U.editingId = null; rebuild(); $("#u_name")?.focus(); return true; }
    if (data.edituser !== undefined) { U.editingId = Number(data.edituser); U.adding = false; rebuild(); window.scrollTo(0, 0); $("#u_name")?.focus(); return true; }
    if (data.canceluser !== undefined) { U.adding = false; U.editingId = null; rebuild(); return true; }
    if (data.dismisscreds !== undefined) { U.newCredentials = null; rebuild(); return true; }
    if (data.copycreds !== undefined) { await copyCredentials(); return true; }
    if (data.removeuserphoto !== undefined) {
      await act(() => api("DELETE", `/api/users/${U.editingId}/photo`), "Photo removed");
      await LH.loadBootstrap(); rebuild(); return true;
    }
    if (data.reset !== undefined) { U.confirmingResetFor = Number(data.reset); LH.render(); return true; }
    if (data.emailpassphrase !== undefined) {
      element.disabled = true;
      try {
        const result = await act(() => api("POST", `/api/users/${data.emailpassphrase}/email-passphrase`));
        toast(`Temporary passphrase sent to ${result.sentTo}. It works for 30 minutes.`);
      } finally { element.disabled = false; }
      return true;
    }
    if (data.cancelreset !== undefined) { U.confirmingResetFor = null; LH.render(); return true; }
    if (data.confirmreset !== undefined) {
      const result = await act(() => api("POST", `/api/users/${data.confirmreset}/reset-password`), "Password reset");
      U.newCredentials = { username: result.username, password: result.temporaryPassword, isNewAccount: false };
      U.confirmingResetFor = null; rebuild(); window.scrollTo(0, 0); return true;
    }
    if (data.active !== undefined) {
      const userId = Number(data.active), activate = data.to === "1";
      await act(() => api("PATCH", "/api/users/" + userId, { active: activate }), `${userName(userId)} ${activate ? "reactivated" : "deactivated"}`);
      await refreshPeople(); LH.render(); return true;
    }
    return false;
  },
  async onChange(element) {
    if (element.id === "u_photo") {
      const file = element.files[0];
      if (!file) return true;
      try {
        const image = await LH.preparePhotoUpload(file);
        await act(() => api("PUT", `/api/users/${U.editingId}/photo`, { image }), "Photo saved");
        await LH.loadBootstrap();
      } catch (error) { toast(error.message, true); }
      rebuild(); return true;
    }
    if (element.dataset.level) {
      const userId = Number(element.dataset.level), level = accessLevels.levels.find((l) => l.id === Number(element.value));
      try { await act(() => api("PATCH", "/api/users/" + userId, { accessLevelId: level.id }), `${userName(userId)} is now ${level.name}`); }
      catch { element.value = S.users.get(userId).accessLevelId; return true; }
      await refreshPeople(); LH.render(); return true;
    }
    return false;
  },
};

// ========== Access levels ==========
const L = { editingId: null, confirmingDeleteId: null }; // editingId: a level id, or "new"

function permissionsByArea(permissions) {
  const areas = new Map();
  for (const permission of permissions) {
    if (!areas.has(permission.area)) areas.set(permission.area, []);
    areas.get(permission.area).push(permission);
  }
  return areas;
}
function levelFormHTML() {
  const isNew = L.editingId === "new";
  const level = isNew ? { name: "", description: "", permissions: ["tickets.create"] } : accessLevels.levels.find((l) => l.id === L.editingId);
  if (!level) return "";
  const limits = S.C.MAX_LENGTH;
  const areaHTML = ([area, permissions]) => `<fieldset class="perm-area"><legend>${esc(area)}</legend>
    ${permissions.map((p) => `<label class="perm"><input type="checkbox" name="perm" value="${p.key}" ${level.permissions.includes(p.key) ? "checked" : ""}>
      <span><b>${esc(p.label)}</b><span class="sub">${esc(p.description)}</span></span></label>`).join("")}</fieldset>`;
  return `<form class="formcard" id="levelForm"><h2>${isNew ? "New access level" : `Edit ${esc(level.name)}`}</h2>
    <div class="grid2">
      <label class="f">Name<input id="lv_name" required maxlength="${limits.accessLevelName}" value="${esc(level.name)}" placeholder="e.g. Shift lead"></label>
      <label class="f">Description<input id="lv_desc" maxlength="${limits.accessLevelDescription}" value="${esc(level.description)}" placeholder="Who this level is for"></label>
    </div>
    <div class="perm-grid">${[...permissionsByArea(accessLevels.permissions)].map(areaHTML).join("")}</div>
    ${!isNew && level.memberCount ? `<p class="note">${level.memberCount} ${level.memberCount === 1 ? "person has" : "people have"} this level. Taking a permission away releases the work that needed it, such as tickets assigned to them.</p>` : ""}
    <div class="btns end"><button type="button" class="btn" data-cancellevel>Cancel</button><button class="btn primary" type="submit">${isNew ? "Create level" : "Save level"}</button></div></form>`;
}
function levelCardHTML(level) {
  const permissionLabel = new Map([...accessLevels.permissions, ...accessLevels.administratorOnlyPermissions].map((p) => [p.key, p.label]));
  const chips = level.isAdministrator
    ? '<span class="perm-chip all">Every permission, including managing access levels and alert setup</span>'
    : level.permissions.length ? level.permissions.map((key) => `<span class="perm-chip">${esc(permissionLabel.get(key) || key)}</span>`).join("") : '<span class="none">No permissions: can sign in and see tickets they raised</span>';
  const actions = level.isAdministrator
    ? '<span class="pill">Built in · locked</span>'
    : `<button class="btn sm" data-editlevel="${level.id}">Edit</button><button class="btn sm danger" data-deletelevel="${level.id}">Delete</button>`;
  const deleteConfirm = L.confirmingDeleteId !== level.id ? "" : level.memberCount
    ? `<div class="confirm"><span>${level.memberCount} active ${level.memberCount === 1 ? "person uses" : "people use"} this level. Move them to another level under Users first.</span><div class="btns end"><button class="btn sm" data-canceldeletelevel>OK</button></div></div>`
    : `<div class="confirm"><span>Delete the <b>${esc(level.name)}</b> access level?</span><div class="btns end"><button class="btn sm" data-canceldeletelevel>Keep it</button><button class="btn sm danger" data-confirmdeletelevel="${level.id}">Delete level</button></div></div>`;
  return `<section class="level-card ${level.isAdministrator ? "admin" : ""}">
    <div class="hd"><div><h2>${esc(level.name)}</h2>${level.description ? `<div class="sub">${esc(level.description)}</div>` : ""}</div><span class="btns">${actions}</span></div>
    <div class="sub">${level.memberCount} active ${level.memberCount === 1 ? "person" : "people"}</div>
    <div class="perm-chips">${chips}</div>${deleteConfirm}</section>`;
}
const levelsPage = {
  key: "levels", label: "Access levels", section: "Admin",
  isVisible: () => can("access.manage"),
  load: loadAccessLevels,
  holdsForm: () => !!$("#levelForm"),
  reset: () => Object.assign(L, { editingId: null, confirmingDeleteId: null }),
  html() {
    if (!accessLevels) return `<div class="topbar"><h1>Access levels</h1></div><div class="tablewrap"><div class="empty">Loading…</div></div>`;
    return `<div class="topbar"><h1>Access levels</h1>${L.editingId ? "" : '<button class="btn primary" data-newlevel>New access level</button>'}</div>
      <p class="note lead">An access level is a named set of permissions. Every person has exactly one, chosen under Users. The Administrator level always has everything and can't be changed, so there is always a way back in. Everyone can always see the tickets they raised.</p>
      ${levelFormHTML()}
      <div class="levels">${accessLevels.levels.map(levelCardHTML).join("")}</div>`;
  },
  async onSubmit(form) {
    if (form.id !== "levelForm") return false;
    const body = {
      name: $("#lv_name").value,
      description: $("#lv_desc").value,
      permissions: [...document.querySelectorAll('input[name="perm"]:checked')].map((box) => box.value),
    };
    if (L.editingId === "new") await act(() => api("POST", "/api/access-levels", body), "Access level created");
    else await act(() => api("PATCH", "/api/access-levels/" + L.editingId, body), "Access level saved");
    L.editingId = null;
    await Promise.all([LH.loadBootstrap(), loadAccessLevels()]);
    rebuild(); return true;
  },
  async onClick(element, data) {
    if (data.newlevel !== undefined) { L.editingId = "new"; rebuild(); $("#lv_name")?.focus(); return true; }
    if (data.editlevel !== undefined) { L.editingId = Number(data.editlevel); L.confirmingDeleteId = null; rebuild(); window.scrollTo(0, 0); $("#lv_name")?.focus(); return true; }
    if (data.cancellevel !== undefined) { L.editingId = null; rebuild(); return true; }
    if (data.deletelevel !== undefined) { L.confirmingDeleteId = Number(data.deletelevel); LH.render(); return true; }
    if (data.canceldeletelevel !== undefined) { L.confirmingDeleteId = null; LH.render(); return true; }
    if (data.confirmdeletelevel !== undefined) {
      await act(() => api("DELETE", "/api/access-levels/" + data.confirmdeletelevel), "Access level deleted");
      L.confirmingDeleteId = null; await loadAccessLevels(); LH.render(); return true;
    }
    return false;
  },
};

// ========== SLA targets ==========
// "4 hours", "1 day", "3 days 12 hours"
function describeHours(totalHours) {
  const hours = Number(totalHours);
  if (!Number.isFinite(hours) || hours <= 0) return "";
  const days = Math.floor(hours / HOURS_PER_DAY), leftover = hours % HOURS_PER_DAY;
  const part = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (!days) return part(hours, "hour");
  return leftover ? `${part(days, "day")} ${part(leftover, "hour")}` : part(days, "day");
}
const slaPage = {
  key: "sla", label: "SLA targets", section: "Admin",
  isVisible: () => can("sla.manage"),
  holdsForm: () => !!$("#slaForm"),
  html() {
    const hours = S.C.SLA_HOURS;
    const row = (priority) => `<label class="f sla-row"><span>${PRIORITY_LABELS[priority]}</span>
      <span class="sla-input"><input type="number" id="sla_${priority}" data-slahours="${priority}" min="${S.C.MIN_SLA_HOURS}" max="${S.C.MAX_SLA_HOURS}" step="1" value="${hours[priority]}" required> hours</span>
      <span class="sub" id="sla_hint_${priority}">${describeHours(hours[priority])}</span></label>`;
    return `<div class="topbar"><h1>SLA targets</h1></div>
      <p class="note lead">How long each priority has from when the ticket is opened until it's resolved. Queues show the time left, and the people working a ticket are warned when a quarter of its time is left and again if it's breached.</p>
      <form class="formcard" id="slaForm"><h2>Time to resolve</h2>
        <div class="sla-grid">${S.C.PRIORITIES.map(row).join("")}</div>
        <p class="note">Whole hours from ${S.C.MIN_SLA_HOURS} to ${S.C.MAX_SLA_HOURS} (${describeHours(S.C.MAX_SLA_HOURS)}). A change applies straight away to every ticket, including ones already open: their due times move to match.</p>
        <div class="btns end"><button type="reset" class="btn" data-resetsla>Undo changes</button><button class="btn primary" type="submit">Save SLA targets</button></div></form>`;
  },
  onInput(element) {
    if (!element.dataset.slahours) return false;
    $("#sla_hint_" + element.dataset.slahours).textContent = describeHours(element.value);
    return true;
  },
  async onSubmit(form) {
    if (form.id !== "slaForm") return false;
    const slaHours = Object.fromEntries(S.C.PRIORITIES.map((priority) => [priority, Number($("#sla_" + priority).value)]));
    await act(() => api("PUT", "/api/settings/sla", { slaHours }), "SLA targets saved");
    await LH.loadBootstrap();
    rebuild(); return true;
  },
  onClick(element, data) {
    if (data.resetsla === undefined) return false;
    setTimeout(() => S.C.PRIORITIES.forEach((p) => { $("#sla_hint_" + p).textContent = describeHours($("#sla_" + p).value); }));
    return true;
  },
};

// ========== Alert setup ==========
let alertSetup = null; // GET /api/settings/alert-setup
const EMAIL_FIELDS = [
  { name: "host", label: "Mail server", placeholder: "smtp.example.com" },
  { name: "port", label: "Port", type: "number", placeholder: "587" },
  { name: "encryption", label: "Encryption", choices: [["starttls", "STARTTLS (usually port 587)"], ["tls", "TLS (usually port 465)"], ["none", "None (only a relay on this same machine)"]] },
  { name: "username", label: "Username", autocomplete: "off" },
  { name: "password", label: "Password", secret: true },
  { name: "from", label: "Send from", placeholder: "Lighthouse Service Desk <desk@example.com>", hint: "The name and address alerts come from. Your mail service must allow sending as this address." },
];
// Common mail services, to fill in the server details. People still enter their own username and password.
const EMAIL_PRESETS = {
  ses: { label: "Amazon SES (us-east-1)", host: "email-smtp.us-east-1.amazonaws.com", port: "587", encryption: "starttls", hint: "Change us-east-1 to your SES region. Use SES SMTP credentials, not your AWS keys." },
  m365: { label: "Microsoft 365", host: "smtp.office365.com", port: "587", encryption: "starttls", hint: "The mailbox needs SMTP AUTH turned on in the Microsoft 365 admin center." },
  google: { label: "Google Workspace / Gmail", host: "smtp.gmail.com", port: "587", encryption: "starttls", hint: "Use an app password, not the normal account password." },
  azure: { label: "Azure Communication Services", host: "smtp.azurecomm.net", port: "587", encryption: "starttls", hint: "The username is the SMTP username you created on the Communication Services resource." },
};
const SMS_PROVIDERS = [["", "Off"], ["twilio", "Twilio"], ["webhook", "Webhook (any other provider)"]];
const SMS_FIELDS = [
  { name: "twilioAccountSid", label: "Account SID", provider: "twilio", placeholder: "AC…" },
  { name: "twilioApiKeySid", label: "API key SID", provider: "twilio", placeholder: "SK…", hint: "Recommended: an API key you can revoke on its own. Or leave blank and use the Auth Token." },
  { name: "twilioApiKeySecret", label: "API key secret", provider: "twilio", secret: true },
  { name: "twilioAuthToken", label: "Auth Token (only without an API key)", provider: "twilio", secret: true },
  { name: "twilioFromNumber", label: "Send from (Twilio number)", provider: "twilio", placeholder: "+13175550100" },
  { name: "twilioMessagingServiceSid", label: "Or a Messaging Service SID", provider: "twilio", placeholder: "MG…" },
  { name: "webhookUrl", label: "Webhook address (HTTPS)", provider: "webhook", placeholder: "https://sms-gateway.example.com/send" },
  { name: "webhookToken", label: "Bearer token", provider: "webhook", secret: true },
];
const OPTION_FIELDS = [
  { name: "maxTextsPerHour", label: "Most texts per hour, whole desk", min: 1, max: 10000 },
  { name: "maxTextsPerPersonPerHour", label: "Most texts per hour, per person", min: 1, max: 1000 },
  { name: "dailyReminderHour", label: "Daily task reminders from (hour, 0–23)", min: 0, max: 23 },
];

function settingFieldHTML(prefix, field, view) {
  const id = `${prefix}_${field.name}`;
  const providerAttribute = field.provider ? ` data-provider="${field.provider}"` : "";
  if (field.secret) {
    const secret = view.secrets[field.name];
    const placeholder = secret.isSet ? "Saved. Leave blank to keep it." : "Not set";
    return `<div class="f"${providerAttribute}><label for="${id}">${field.label}</label><input id="${id}" type="password" autocomplete="new-password" placeholder="${placeholder}">
      ${secret.unreadable ? '<span class="note err-text">The saved value can\'t be read any more (the encryption key changed). Enter it again.</span>' : ""}
      ${secret.isSet ? `<label class="chk"><input type="checkbox" id="${id}_clear"> Remove the saved ${field.label.replace(/ \(.*\)$/, "")}</label>` : ""}</div>`;
  }
  const value = view.values[field.name] ?? "";
  if (field.choices) {
    return `<label class="f"${providerAttribute}>${field.label}<select id="${id}">${field.choices.map(([v, label]) => `<option value="${v}" ${String(value || "starttls") === v ? "selected" : ""}>${label}</option>`).join("")}</select></label>`;
  }
  return `<label class="f"${providerAttribute}>${field.label}<input id="${id}" type="${field.type || "text"}" value="${esc(value)}" placeholder="${esc(field.placeholder || "")}" autocomplete="${field.autocomplete || "off"}" spellcheck="false">
    ${field.hint ? `<span class="note">${esc(field.hint)}</span>` : ""}</label>`;
}
function statusPillHTML(described) {
  return described.configured ? '<span class="pill ok">On</span>' : '<span class="pill off">Off</span>';
}
function sourceNoteHTML(channel, view) {
  if (view.source === "app") return `<p class="note">Saved in Lighthouse. <button class="linkbtn" data-useenv="${channel}">Go back to the server's env file settings</button></p>`;
  const anythingSet = Object.values(view.values).some(Boolean);
  return `<p class="note">${anythingSet ? "Currently coming from the server's env file. Saving here takes over from it." : "Not set up yet."}</p>`;
}
function testRowHTML(channel) {
  const isEmail = channel === "email";
  return `<div class="test-row"><span class="sub">Check these settings before saving: send a test to</span>
    <div class="addrow"><input id="${channel}_test_to" type="${isEmail ? "email" : "tel"}" placeholder="${isEmail ? "you@example.com" : "+1 317 555 0100"}" value="${esc(isEmail ? S.me.email || "" : "")}" aria-label="Send a test to">
      <button type="button" class="btn sm" data-testsetup="${channel}">Send test</button></div>
    <div id="${channel}_test_result" class="note" role="status"></div></div>`;
}
function emailCardHTML() {
  const view = alertSetup.email, described = alertSetup.status.email;
  return `<form class="settings-card" id="emailSetupForm" autocomplete="off">
    <div class="row-actions"><h2>Email</h2>${statusPillHTML(described)}</div>
    ${!described.configured && described.problem ? `<div class="banner warn">${esc(described.problem)}</div>` : ""}
    ${sourceNoteHTML("email", view)}
    <label class="f">Fill in server details for<select id="em_preset"><option value="">Choose a mail service…</option>${Object.entries(EMAIL_PRESETS).map(([key, p]) => `<option value="${key}">${p.label}</option>`).join("")}</select>
      <span class="note" id="em_preset_hint"></span></label>
    <div class="grid2">${EMAIL_FIELDS.map((field) => settingFieldHTML("em", field, view)).join("")}</div>
    <p class="note">The server's certificate is always checked. For an internal mail server with a private certificate authority, set SMTP_CA_FILE in the server's env file.</p>
    <div class="btns end"><button class="btn primary" type="submit">Save email settings</button></div>
    ${testRowHTML("email")}</form>`;
}
function smsCardHTML() {
  const view = alertSetup.sms, described = alertSetup.status.sms;
  const provider = view.values.provider || "";
  return `<form class="settings-card" id="smsSetupForm" autocomplete="off">
    <div class="row-actions"><h2>Text messages</h2>${statusPillHTML(described)}</div>
    ${!described.configured && described.problem ? `<div class="banner warn">${esc(described.problem)}</div>` : ""}
    ${sourceNoteHTML("sms", view)}
    <label class="f">Provider<select id="sms_provider">${SMS_PROVIDERS.map(([v, label]) => `<option value="${v}" ${provider === v ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <div class="grid2">${SMS_FIELDS.map((field) => settingFieldHTML("sms", field, view)).join("")}</div>
    <div class="btns end"><button class="btn primary" type="submit">Save text settings</button></div>
    ${testRowHTML("sms")}</form>`;
}
function optionsCardHTML() {
  const options = alertSetup.options;
  return `<form class="settings-card" id="optionsSetupForm">
    <h2>Alert options</h2>
    <div class="grid2">${OPTION_FIELDS.map((f) => `<label class="f">${f.label}<input type="number" id="opt_${f.name}" min="${f.min}" max="${f.max}" step="1" value="${options[f.name]}" required></label>`).join("")}
      <label class="f">Default country code for phone numbers<input id="opt_defaultCountryCode" value="${esc(options.defaultCountryCode)}" inputmode="numeric" maxlength="3" required><span class="note">Used when someone types a number without +, for example 1 for the US.</span></label></div>
    <label class="chk"><input type="checkbox" id="opt_includeDetailsInTexts" ${options.includeDetailsInTexts ? "checked" : ""}> Include ticket and task titles in texts (off: ID and link only)</label>
    <dl class="kv wide"><dt>Links in alerts</dt><dd>${alertSetup.publicUrl ? esc(alertSetup.publicUrl) : '<span class="overdue">PUBLIC_URL isn\'t set in the server\'s env file, so alerts can\'t link back to Lighthouse</span>'}</dd>
      <dt>Server time zone</dt><dd>${esc(alertSetup.status.timeZone)}</dd></dl>
    <div class="btns end"><button class="btn primary" type="submit">Save alert options</button></div></form>`;
}
// Shows only the fields for the chosen text provider.
function showFieldsForProvider() {
  const provider = $("#sms_provider")?.value || "";
  document.querySelectorAll("#smsSetupForm [data-provider]").forEach((field) => { field.hidden = field.dataset.provider !== provider; });
  const testRow = $("#smsSetupForm .test-row");
  if (testRow) testRow.hidden = !provider;
}
// Reads a setup form: plain fields, any newly typed secrets, and secrets ticked for removal.
function readSetupForm(prefix, fields) {
  const settings = { clear: [] };
  for (const field of fields) {
    const input = $(`#${prefix}_${field.name}`);
    if (!input) continue;
    if (field.secret) {
      if (input.value) settings[field.name] = input.value;
      if ($(`#${prefix}_${field.name}_clear`)?.checked) settings.clear.push(field.name);
    } else {
      settings[field.name] = input.value.trim();
    }
  }
  return settings;
}
const emailFormValues = () => readSetupForm("em", EMAIL_FIELDS);
const smsFormValues = () => ({ provider: $("#sms_provider").value, ...readSetupForm("sms", SMS_FIELDS) });
const loadAlertSetup = async () => { alertSetup = await api("GET", "/api/settings/alert-setup"); };

const alertSetupPage = {
  key: "alertSetup", label: "Alert setup", section: "Admin",
  isVisible: () => can("alerts.configure"),
  load: loadAlertSetup,
  holdsForm: () => !!$("#emailSetupForm"),
  html() {
    if (!alertSetup) return `<div class="topbar"><h1>Alert setup</h1></div><div class="tablewrap"><div class="empty">Loading…</div></div>`;
    setTimeout(showFieldsForProvider);
    return `<div class="topbar"><h1>Alert setup</h1></div>
      <p class="note lead">Connect Lighthouse to a mail service and a text-message provider. Passwords and tokens are stored encrypted and are never shown again after saving. Step-by-step instructions for each service are in <span class="mono">docs/ALERTS.md</span>.</p>
      ${emailCardHTML()}${smsCardHTML()}${optionsCardHTML()}
      <p class="note">Once a channel shows <b>On</b>, each person adds and confirms their own address or number under <button class="linkbtn" data-view="alerts">My alerts</button>.${can("alerts.view_log") ? ' Every send is listed under <button class="linkbtn" data-view="delivery">Alert delivery</button>.' : ""}</p>`;
  },
  async onSubmit(form) {
    const save = async (path, body, message) => {
      alertSetup = await act(() => api("PUT", "/api/settings/alert-setup/" + path, body), message);
      await LH.loadBootstrap();
      rebuild();
    };
    if (form.id === "emailSetupForm") { await save("email", emailFormValues(), "Email settings saved"); return true; }
    if (form.id === "smsSetupForm") { await save("sms", smsFormValues(), "Text settings saved"); return true; }
    if (form.id === "optionsSetupForm") {
      const options = { includeDetailsInTexts: $("#opt_includeDetailsInTexts").checked, defaultCountryCode: $("#opt_defaultCountryCode").value };
      for (const f of OPTION_FIELDS) options[f.name] = Number($("#opt_" + f.name).value);
      await save("options", options, "Alert options saved"); return true;
    }
    return false;
  },
  async onClick(element, data) {
    if (data.useenv !== undefined) {
      alertSetup = await act(() => api("DELETE", "/api/settings/alert-setup/" + data.useenv), "Now using the server's env file settings");
      await LH.loadBootstrap(); rebuild(); return true;
    }
    if (data.testsetup !== undefined) {
      const channel = data.testsetup, result = $(`#${channel}_test_result`);
      element.disabled = true;
      result.textContent = "Sending…"; result.className = "note";
      try {
        const sent = await api("POST", "/api/settings/alert-setup/test", { channel, target: $(`#${channel}_test_to`).value, settings: channel === "email" ? emailFormValues() : smsFormValues() });
        result.textContent = `Sent to ${sent.to}. If it arrives, these settings work: save them.`;
        result.className = "note ok-text";
      } catch (error) {
        result.textContent = error.message;
        result.className = "note err-text";
      } finally { element.disabled = false; }
      return true;
    }
    return false;
  },
  onChange(element) {
    if (element.id === "sms_provider") { showFieldsForProvider(); return true; }
    if (element.id === "em_preset") {
      const preset = EMAIL_PRESETS[element.value];
      if (preset) { $("#em_host").value = preset.host; $("#em_port").value = preset.port; $("#em_encryption").value = preset.encryption; }
      $("#em_preset_hint").textContent = preset?.hint || "";
      return true;
    }
    return false;
  },
};

// ========== Alert delivery (log) ==========
let deliveryLog = null; // GET /api/alerts/admin
function deliveryRowHTML(entry) {
  const eventLabel = SYSTEM_EVENT_LABELS[entry.event] || entry.event.replace(/_/g, " ");
  const canRetry = entry.status === "failed" && !SYSTEM_EVENT_LABELS[entry.event];
  return `<tr><td class="sub nowrap">${esc(formatDateTime(entry.at))}</td>
    <td>${esc(entry.userName)}<div class="sub mono">${esc(entry.to)}</div></td>
    <td>${entry.channel === "sms" ? "Text" : "Email"}</td>
    <td><div>${esc(eventLabel)}</div><div class="sub ellip">${esc(entry.subject)}</div></td>
    <td><span class="pill ${DELIVERY_STATUS_CLASS[entry.status] ?? ""}">${esc(entry.status)}${entry.status === "pending" && entry.attempts ? ` (retry ${entry.attempts})` : ""}</span>
      ${entry.error ? `<div class="sub err-text">${esc(entry.error)}</div>` : ""}${canRetry ? `<button class="btn sm mt" data-retry="${entry.id}">Retry</button>` : ""}</td></tr>`;
}
const deliveryPage = {
  key: "delivery", label: "Alert delivery", section: "Admin",
  isVisible: () => can("alerts.view_log"),
  load: async () => { deliveryLog = await api("GET", "/api/alerts/admin"); },
  html() {
    const log = deliveryLog;
    if (!log) return `<div class="topbar"><h1>Alert delivery</h1></div><div class="tablewrap"><div class="empty">Loading…</div></div>`;
    const count = (channel, status) => log.lastDayCounts.find((row) => row.channel === channel && row.status === status)?.n || 0;
    const bothChannels = (status) => count("email", status) + count("sms", status);
    const channelLine = (name, described) => `<span>${name}: ${statusPillHTML(described)}</span>`;
    const recent = log.recent.length
      ? `<table class="log"><colgroup><col class="c-when"><col class="c-to"><col class="c-via"><col><col class="c-status"></colgroup>
          <thead><tr><th>When</th><th>To</th><th>Via</th><th>Alert</th><th>Status</th></tr></thead><tbody>${log.recent.map(deliveryRowHTML).join("")}</tbody></table>`
      : `<div class="empty"><strong>Nothing sent yet</strong><span>Alerts appear here as they go out.${can("alerts.configure") ? ' Use "Send test" under Alert setup to check delivery.' : ""}</span></div>`;
    return `<div class="topbar"><h1>Alert delivery</h1></div>
      <section class="settings-card"><div class="row-actions"><div class="btns">${channelLine("Email", log.config.email)}${channelLine("Texts", log.config.sms)}</div>
        ${can("alerts.configure") ? '<button class="btn sm" data-view="alertSetup">Alert setup</button>' : ""}</div>
        <p class="note">${log.people.withPhone} of ${log.people.active} active people have a confirmed mobile number${log.people.paused ? ` · ${log.people.paused} paused their alerts` : ""}.</p></section>
      <section class="settings-card"><h2>Last 24 hours</h2>
        <div class="stats"><div class="stat"><span class="k">Emails sent</span><span class="v">${count("email", "sent")}</span></div>
          <div class="stat"><span class="k">Texts sent</span><span class="v">${count("sms", "sent")}</span></div>
          <div class="stat ${bothChannels("failed") ? "alert" : ""}"><span class="k">Failed</span><span class="v">${bothChannels("failed")}</span></div>
          <div class="stat"><span class="k">Waiting / retrying</span><span class="v">${bothChannels("pending")}</span></div></div></section>
      <section class="settings-card"><div class="row-actions"><h2>Recent deliveries</h2><button class="btn sm" data-refreshdelivery>Refresh</button></div>
        <div class="tablewrap flat">${recent}</div></section>`;
  },
  async onClick(element, data) {
    if (data.refreshdelivery !== undefined) { await deliveryPage.load(); LH.render(); return true; }
    if (data.retry !== undefined) {
      await act(() => api("POST", "/api/alerts/admin/retry/" + data.retry), "Queued for another try");
      await deliveryPage.load(); LH.render(); return true;
    }
    return false;
  },
};

LH.addSettingsPages(usersPage, levelsPage, slaPage, alertSetupPage, deliveryPage);
})();
