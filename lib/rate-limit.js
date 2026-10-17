// Simple in-memory rate limiter: "at most `max` events per key within `windowMs`".
// Each window starts at the first event for a key and resets once it has passed.
const { RATE_LIMIT_MAX_TRACKED_KEYS } = require("./constants");

function createRateLimiter({ max, windowMs }) {
  const windowsByKey = new Map(); // key -> { startedAt, count }

  const windowHasExpired = (entry, now) => now - entry.startedAt >= windowMs;

  function forgetExpiredKeys(now) {
    for (const [key, entry] of windowsByKey) if (windowHasExpired(entry, now)) windowsByKey.delete(key);
    // Still too many (e.g. a flood of random usernames)? Start over rather than grow without limit.
    if (windowsByKey.size > RATE_LIMIT_MAX_TRACKED_KEYS) windowsByKey.clear();
  }

  return {
    isBlocked(key) {
      const entry = windowsByKey.get(key);
      return !!entry && !windowHasExpired(entry, Date.now()) && entry.count >= max;
    },
    record(key) {
      const now = Date.now();
      const entry = windowsByKey.get(key);
      if (!entry || windowHasExpired(entry, now)) windowsByKey.set(key, { startedAt: now, count: 1 });
      else entry.count++;
      if (windowsByKey.size > RATE_LIMIT_MAX_TRACKED_KEYS) forgetExpiredKeys(now);
    },
    reset(key) { windowsByKey.delete(key); },
  };
}

module.exports = { createRateLimiter };
