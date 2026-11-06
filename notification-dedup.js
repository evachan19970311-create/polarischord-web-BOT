"use strict";

// Successful notifications are retained for a day; failed deliveries can retry.
function createNotificationDeduplicator({ now = Date.now, ttlMs = 86400000, maxEntries = 5000 } = {}) {
  const entries = new Map();
  return function deliverOnce(key, job) {
    if (!key) return Promise.resolve().then(job);
    for (const [id, entry] of entries) if (entry.expiresAt <= now()) entries.delete(id);
    if (entries.has(key)) return entries.get(key).promise;
    if (entries.size >= maxEntries) {
      const settled = [...entries].find(([, entry]) => entry.expiresAt !== Infinity);
      if (settled) entries.delete(settled[0]);
      else return Promise.reject(new Error("Notification queue is busy"));
    }
    const entry = { expiresAt: Infinity, promise: null };
    entry.promise = Promise.resolve().then(job).then(result => {
      entry.expiresAt = now() + ttlMs;
      return result;
    }, error => { entries.delete(key); throw error; });
    entries.set(key, entry);
    return entry.promise;
  };
}

module.exports = { createNotificationDeduplicator };
