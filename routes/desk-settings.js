// Desk settings changed from inside the app:
//   PUT  /api/settings/sla                      SLA targets            needs "Change SLA targets"
//   GET  /api/settings/alert-setup              email/text setup       needs "Set up email and text delivery" (Administrators)
//   PUT  /api/settings/alert-setup/email|sms    save a channel
//   PUT  /api/settings/alert-setup/options      text limits, reminder hour, ...
//   DELETE /api/settings/alert-setup/email|sms  go back to the server's environment file
//   POST /api/settings/alert-setup/test         send a test with the settings on screen, before saving them
const { RATE_LIMITS } = require("../lib/constants");
const { STATUS, fail, isValidEmail } = require("../lib/http");
const { normalizePhoneNumber, maskPhoneNumber } = require("../alerts/sms");
const { createRateLimiter } = require("../lib/rate-limit");

const CHANNELS = ["email", "sms"];

module.exports = function registerDeskSettingRoutes(app) {
  const { route, audit, notify, deskSettings, config, requirePermission } = app;
  const testMessages = createRateLimiter(RATE_LIMITS.testAlertsPerUser);
  const channelFrom = (value) => (CHANNELS.includes(value) ? value : fail(STATUS.badRequest, "Choose email or sms."));

  // ---------- SLA targets ----------
  route("PUT", "/api/settings/sla", (request) => {
    requirePermission(request, "sla.manage");
    const before = deskSettings.slaHours();
    const slaHours = deskSettings.saveSlaHours(request.body.slaHours, request.user.id);
    audit("settings.sla", request, { before, after: slaHours });
    return { slaHours };
  });

  // ---------- email and text setup ----------
  const setupView = () => ({
    email: deskSettings.channelView("email"),
    sms: deskSettings.channelView("sms"),
    options: deskSettings.alertOptions(),
    status: notify.describe(),
    publicUrl: config.publicUrl,
  });

  route("GET", "/api/settings/alert-setup", (request) => {
    requirePermission(request, "alerts.configure");
    return setupView();
  });

  route("PUT", "/api/settings/alert-setup/:channel", (request) => {
    requirePermission(request, "alerts.configure");
    const what = request.params.channel;
    if (what === "options") {
      deskSettings.saveAlertOptions(request.body, request.user.id);
      audit("settings.alert_options", request, {});
    } else {
      const channel = channelFrom(what);
      deskSettings.saveChannel(channel, request.body, request.user.id);
      notify.reconfigure();
      // Which secrets changed is recorded, never their values.
      const secretsChanged = Object.keys(request.body).filter((key) => /password|secret|token/i.test(key) && request.body[key]);
      audit("settings.alert_channel", request, { channel, secretsChanged, cleared: request.body.clear || [] });
    }
    return setupView();
  });

  route("DELETE", "/api/settings/alert-setup/:channel", (request) => {
    requirePermission(request, "alerts.configure");
    const channel = channelFrom(request.params.channel);
    deskSettings.useEnvironmentFor(channel);
    notify.reconfigure();
    audit("settings.alert_channel_reset", request, { channel });
    return setupView();
  });

  route("POST", "/api/settings/alert-setup/test", async (request) => {
    requirePermission(request, "alerts.configure");
    const channel = channelFrom(request.body.channel);
    const settings = deskSettings.combine(channel, request.body.settings || {});
    let target;
    if (channel === "email") {
      if (!settings.host) fail(STATUS.badRequest, "Enter the mail server first.");
      target = String(request.body.target || "").trim().toLowerCase();
      if (!isValidEmail(target)) fail(STATUS.badRequest, "Enter the email address to send the test to.");
    } else {
      if (!settings.provider) fail(STATUS.badRequest, "Choose a text provider first.");
      target = normalizePhoneNumber(request.body.target, deskSettings.alertOptions().defaultCountryCode);
      if (!target) fail(STATUS.badRequest, "Enter the mobile number to send the test to, with country code.");
    }
    const limiterKey = String(request.user.id);
    if (testMessages.isBlocked(limiterKey)) fail(STATUS.tooMany, "Too many test messages. Wait an hour and try again.");
    testMessages.record(limiterKey);

    const link = config.publicUrl ? `\n\n${config.publicUrl}/` : "";
    const message = channel === "email"
      ? { subject: "[Lighthouse] Test email", body: `This is a test from Lighthouse, sent by ${request.user.name} from Settings > Alert setup.\n\nIf you can read this, email alerts are set up correctly.${link}` }
      : { body: `Lighthouse test from ${request.user.name}: text alerts are set up correctly.` };
    try {
      await notify.sendTestWithSettings({ userId: request.user.id, channel, target, event: "test", settings, ...message });
    } catch (error) {
      fail(STATUS.badGateway, `The test didn't go through: ${error.message}`);
    }
    audit("settings.alert_test", request, { channel, target: channel === "sms" ? maskPhoneNumber(target) : target });
    return { ok: true, to: channel === "sms" ? maskPhoneNumber(target) : target };
  });
};
