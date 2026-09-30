// Entry point for the reward cron — deployed as its own Railway service
// (Cron Schedule, not a long-running process) rather than folded into the
// main API server, so a stuck reward run can't affect the site staying up,
// and vice versa. Runs once and exits; Railway's scheduler handles the
// every-2-hours cadence (see docs/token-launch-plan.md "Reward cron").
// Doesn't run the cycle itself — see cron-trigger.mjs for why.
import { triggerInternalCycle } from './cron-trigger.mjs';

console.log(`[${new Date().toISOString()}] reward cron starting`);
try {
  await triggerInternalCycle('/internal/run-reward-cycle', 'reward cycle');
  console.log(`[${new Date().toISOString()}] reward cron finished`);
  process.exit(0);
} catch (err) {
  console.error(`[${new Date().toISOString()}] reward cron crashed:`, err.message);
  process.exit(1);
}
