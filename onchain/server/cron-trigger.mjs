// Shared by reward-cron.mjs/graduation-cron.mjs: neither can open db.mjs's
// SQLite file directly (see index.mjs's own comment on the internal
// routes for why — Railway volumes attach to one service at a time), so
// both just ask the always-on perpside service, which has the real
// database, to run the cycle over Railway's private network.
const PERPSIDE_INTERNAL_URL = process.env.PERPSIDE_INTERNAL_URL || 'http://perpside.railway.internal:3000';

export async function triggerInternalCycle(path, label) {
  const secret = process.env.INTERNAL_CRON_SECRET;
  if (!secret) throw new Error('INTERNAL_CRON_SECRET not set');
  const res = await fetch(`${PERPSIDE_INTERNAL_URL}${path}`, {
    method: 'POST',
    headers: { 'x-internal-secret': secret },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} request failed: HTTP ${res.status} ${body}`);
  }
}
