// Entry point for the reward cron — deployed as its own Railway service
// (Cron Schedule, not a long-running process) rather than folded into the
// main API server, so a stuck reward run can't affect the site staying up,
// and vice versa. Runs once and exits; Railway's scheduler handles the
// every-2-hours cadence (see docs/token-launch-plan.md "Reward cron").
import { runRewardCycle } from './rewards.mjs';

console.log(`[${new Date().toISOString()}] reward cron starting`);
try {
  await runRewardCycle();
  console.log(`[${new Date().toISOString()}] reward cron finished`);
  process.exit(0);
} catch (err) {
  console.error(`[${new Date().toISOString()}] reward cron crashed:`, err);
  process.exit(1);
}
