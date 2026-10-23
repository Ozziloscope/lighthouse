// Every fixed number, limit and list the server uses, in one place and with a name.
// To change how Lighthouse behaves, change a value here rather than hunting through the code.

// ---------- units of time, in milliseconds ----------
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// ---------- tickets ----------
const TICKET_PRIORITIES = ["P1", "P2", "P3", "P4"];
const TICKET_STATUSES = ["New", "Assigned", "In Progress", "Pending", "Resolved", "Closed"];
const OPEN_TICKET_STATUSES = ["New", "Assigned", "In Progress", "Pending"];
// Categories are grouped in the ticket form's menu. Each name must be unique across all groups,
// because the name is what's stored on the ticket (hence "Facilities: Other" next to the general "Other").
const TICKET_CATEGORY_GROUPS = [
  { group: "Data center", categories: ["Server hardware", "Storage", "Network / fabric", "Power & cooling", "Physical access", "Cabling", "OS / firmware"] },
  { group: "Tech (software & applications)", categories: ["Login Issue", "Site Improvement", "Feature Request", "Software Issue"] },
  { group: "Facilities", categories: ["Plumbing", "Stock", "Electrical", "Carpentry", "Capital Expenditure", "Procurement", "Property Maintenance", "Facilities: Other"] },
  { group: "General", categories: ["Request", "Other"] },
];
const TICKET_CATEGORIES = TICKET_CATEGORY_GROUPS.flatMap((g) => g.categories);
const DEFAULT_TICKET_PRIORITY = "P3";
const DEFAULT_TICKET_CATEGORY = "Other";

// How long each priority has from being raised to being resolved.
// Starting SLA targets (hours from open to resolve). Admins change them in Settings > SLA targets.
const SLA_HOURS_BY_PRIORITY = { P1: 4, P2: 24, P3: 72, P4: 168 };
const MIN_SLA_HOURS = 1;
const MAX_SLA_HOURS = 90 * 24; // 90 days
const FALLBACK_SLA_HOURS = 72;
// An "SLA running out" warning goes out when this fraction of the SLA window is left.
const SLA_WARNING_FRACTION_LEFT = 0.25;

// Tags on tickets: lower case letters, digits, dot, dash and underscore (spaces become dashes).
const MAX_TAG_LENGTH = 30;
const MAX_TAGS_PER_TICKET = 15;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

// Links between tickets. "a duplicates b", "a blocks b"; "related" works both ways.
const TICKET_LINK_KINDS = ["related", "duplicate", "blocks"];
const MAX_LINKS_PER_TICKET = 50;

// Files attached to tickets, stored in DATA_DIR/attachments.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB per file
const MAX_ATTACHMENTS_PER_TICKET = 50;
const MAX_FILE_NAME_LENGTH = 180;

// Ticket numbers start here (TKT-1001).
const FIRST_TICKET_NUMBER = 1001;
// The most tickets returned in one list. Older tickets are still kept.
const MAX_TICKETS_PER_LIST = 5000;

// ---------- text length limits (characters) ----------
const MAX_LENGTH = {
  personName: 80,
  username: 32,
  email: 160,
  ticketTitle: 140,
  ticketDescription: 20000,
  ticketComment: 20000,
  assetTag: 80,
  groupName: 60,
  groupDescription: 300,
  accessLevelName: 50,
  accessLevelDescription: 300,
  projectName: 80,
  projectDescription: 4000,
  sectionName: 60,
  taskTitle: 200,
  taskDescription: 20000,
};
const MIN_USERNAME_LENGTH = 3;
// Usernames: letters, digits, dot, dash and underscore. Stored in lower case.
const USERNAME_PATTERN = /^[a-z0-9._-]+$/;

// ---------- passwords and sessions ----------
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;
const GENERATED_PASSWORD_LENGTH = 14;
const DEFAULT_SESSION_DAYS = 7;
// "Forgot password": a one-time passphrase emailed to the address on file, valid for a short while.
// The old password keeps working until the passphrase is used, so a stranger can't lock anyone out.
const RESET_PASSPHRASE_WORDS = 4;
const RESET_PASSPHRASE_LIFETIME_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TOKEN_BYTES = 32; // 256 bits of randomness
const SESSION_TOKEN_PATTERN = /^[0-9a-f]{64}$/; // the token as hex text

// ---------- rate limits: { most attempts, within this window } ----------
const RATE_LIMITS = {
  failedLoginsPerAccount: { max: 10, windowMs: 15 * MINUTE_MS }, // per IP address + username
  failedLoginsPerAddress: { max: 50, windowMs: 15 * MINUTE_MS }, // per IP address, any username (password spraying)
  wrongSetupCodes: { max: 10, windowMs: 15 * MINUTE_MS },
  wrongCurrentPasswords: { max: 10, windowMs: 15 * MINUTE_MS },
  changesPerUser: { max: 120, windowMs: MINUTE_MS },
  verificationCodesPerUser: { max: 5, windowMs: HOUR_MS },
  testAlertsPerUser: { max: 6, windowMs: HOUR_MS },
  passwordResetsPerAddress: { max: 10, windowMs: HOUR_MS },  // "forgot password" requests from one IP address
  passwordResetsPerAccount: { max: 3, windowMs: HOUR_MS },   // reset emails sent to one account
};
// Memory guard for the rate limiters: above this many tracked keys, expired ones are cleared out.
const RATE_LIMIT_MAX_TRACKED_KEYS = 20000;

// ---------- HTTP ----------
const MAX_REQUEST_BODY_BYTES = 200 * 1024;
const HEADERS_TIMEOUT_MS = 20 * SECOND_MS;
const REQUEST_TIMEOUT_MS = 120 * SECOND_MS; // long enough to upload a large attachment on a slow connection
const STATIC_FILE_CACHE_SECONDS = 3600;
const HSTS_MAX_AGE_SECONDS = 365 * 24 * 3600;
const EXPIRED_SESSION_CLEANUP_INTERVAL_MS = HOUR_MS;

// ---------- projects ----------
const PROJECT_COLORS = ["teal", "blue", "violet", "pink", "red", "orange", "yellow", "green", "slate"];
const DEFAULT_PROJECT_COLOR = "teal";
const PROJECT_STATUSES = ["on_track", "at_risk", "off_track", "on_hold", "complete"];
const TASK_PRIORITIES = ["", "low", "medium", "high"]; // "" means no priority
const MAX_SECTIONS_PER_PROJECT = 30;
const MAX_MEMBERS_WHEN_CREATING_PROJECT = 100;
const COMPLETED_TASKS_SHOWN_FOR_DAYS = 7; // in My tasks

// ---------- alerts ----------
const VERIFICATION_CODE_DIGITS = 6;
const VERIFICATION_CODE_LIFETIME_MS = 10 * MINUTE_MS;
const VERIFICATION_CODE_MAX_TRIES = 5;
const DELIVERY_RETRY_DELAYS_MS = [MINUTE_MS, 5 * MINUTE_MS, 15 * MINUTE_MS, HOUR_MS];
const MAX_DELIVERY_ATTEMPTS = DELIVERY_RETRY_DELAYS_MS.length + 1;
const DELIVERY_BATCH_SIZE = 25;
const DELIVERY_CHECK_INTERVAL_MS = 10 * SECOND_MS;
const SCHEDULED_CHECK_INTERVAL_MS = MINUTE_MS;
const FIRST_SCHEDULED_CHECK_DELAY_MS = 5 * SECOND_MS;
const HISTORY_CLEANUP_INTERVAL_MS = 6 * HOUR_MS;
const ALERT_HISTORY_KEPT_MS = 30 * DAY_MS;
// After a restart or upgrade, do not announce breaches or overdue tasks that are already old news.
const IGNORE_SLA_BREACHES_OLDER_THAN_MS = 6 * HOUR_MS;
const IGNORE_TASKS_OVERDUE_BY_MORE_THAN_DAYS = 7;
const NETWORK_TIMEOUT_MS = 15 * SECOND_MS;
const SMTP_REPLY_TIMEOUT_MS = 20 * SECOND_MS;
const MAX_SMTP_REPLY_BYTES = 64 * 1024;
const MAX_TEXT_MESSAGE_LENGTH = 320; // two SMS segments
const MAX_LOGGED_ERROR_LENGTH = 300;
// ---------- profile photos ----------
// The browser shrinks photos to a square of this size before uploading, so stored photos stay small.
const PHOTO_SIZE_PX = 256;
const MAX_PHOTO_BYTES = 120 * 1024; // fits in one request (MAX_REQUEST_BODY_BYTES) after base64 encoding
const PHOTO_CACHE_SECONDS = 7 * 24 * 3600; // safe to cache: the photo's address changes when it is replaced

// How much of a ticket or task appears in an alert.
const ALERT_EXCERPT_LENGTH = { title: 90, smsTitle: 80, description: 600, comment: 1500, resolution: 800, smsComment: 110 };

module.exports = {
  SECOND_MS, MINUTE_MS, HOUR_MS, DAY_MS,
  TICKET_PRIORITIES, TICKET_STATUSES, OPEN_TICKET_STATUSES, TICKET_CATEGORY_GROUPS, TICKET_CATEGORIES,
  MAX_TAG_LENGTH, MAX_TAGS_PER_TICKET, TAG_PATTERN, TICKET_LINK_KINDS, MAX_LINKS_PER_TICKET,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_TICKET, MAX_FILE_NAME_LENGTH, RESET_PASSPHRASE_WORDS, RESET_PASSPHRASE_LIFETIME_MS, DEFAULT_TICKET_PRIORITY, DEFAULT_TICKET_CATEGORY,
  SLA_HOURS_BY_PRIORITY, MIN_SLA_HOURS, MAX_SLA_HOURS, FALLBACK_SLA_HOURS, SLA_WARNING_FRACTION_LEFT, FIRST_TICKET_NUMBER, MAX_TICKETS_PER_LIST,
  MAX_LENGTH, MIN_USERNAME_LENGTH, USERNAME_PATTERN,
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH, GENERATED_PASSWORD_LENGTH, DEFAULT_SESSION_DAYS, SESSION_TOKEN_BYTES, SESSION_TOKEN_PATTERN,
  RATE_LIMITS, RATE_LIMIT_MAX_TRACKED_KEYS,
  MAX_REQUEST_BODY_BYTES, HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS, STATIC_FILE_CACHE_SECONDS, HSTS_MAX_AGE_SECONDS, EXPIRED_SESSION_CLEANUP_INTERVAL_MS,
  PROJECT_COLORS, DEFAULT_PROJECT_COLOR, PROJECT_STATUSES, TASK_PRIORITIES, MAX_SECTIONS_PER_PROJECT, MAX_MEMBERS_WHEN_CREATING_PROJECT, COMPLETED_TASKS_SHOWN_FOR_DAYS,
  VERIFICATION_CODE_DIGITS, VERIFICATION_CODE_LIFETIME_MS, VERIFICATION_CODE_MAX_TRIES,
  DELIVERY_RETRY_DELAYS_MS, MAX_DELIVERY_ATTEMPTS, DELIVERY_BATCH_SIZE, DELIVERY_CHECK_INTERVAL_MS, SCHEDULED_CHECK_INTERVAL_MS, FIRST_SCHEDULED_CHECK_DELAY_MS,
  HISTORY_CLEANUP_INTERVAL_MS, ALERT_HISTORY_KEPT_MS, IGNORE_SLA_BREACHES_OLDER_THAN_MS, IGNORE_TASKS_OVERDUE_BY_MORE_THAN_DAYS,
  PHOTO_SIZE_PX, MAX_PHOTO_BYTES, PHOTO_CACHE_SECONDS,
  NETWORK_TIMEOUT_MS, SMTP_REPLY_TIMEOUT_MS, MAX_SMTP_REPLY_BYTES, MAX_TEXT_MESSAGE_LENGTH, MAX_LOGGED_ERROR_LENGTH, ALERT_EXCERPT_LENGTH,
};
