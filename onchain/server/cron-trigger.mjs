// Shared by reward-cron.mjs/graduation-cron.mjs: neither can open db.mjs's
// SQLite file directly (see index.mjs's own comment on the internal
// routes for why — Railway volumes attach to one service at a time), so
// both just ask the always-on perpside service, which has the real
// database, to run the cycle over Railway's private network.
//
// Port 8080, not the Dockerfile's EXPOSE 3000 — Railway auto-injects its
// own PORT at runtime regardless of what the image exposes (confirmed by
// SSHing into the real running perpside container and reading its actual
// $PORT, not assumed; a first attempt at this default guessed 3000 from
// the Dockerfile and failed with a real ECONNREFUSED from graduation-cron
// against production). PERPSIDE_INTERNAL_URL exists as an escape hatch if
// that value ever changes.
const PERPSIDE_INTERNAL_URL = process.env.PERPSIDE_INTERNAL_URL || 'http://perpside.railway.internal:8080';

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
