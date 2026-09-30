// Entry point for the graduation cron — deployed as its own Railway
// service (Cron Schedule, not a long-running process), same reasoning as
// reward-cron.mjs: a stuck graduation run can't affect the site staying up,
// and vice versa. Runs once and exits. Doesn't run the cycle itself — see
// cron-trigger.mjs for why.
import { triggerInternalCycle } from './cron-trigger.mjs';

console.log(`[${new Date().toISOString()}] graduation cron starting`);
try {
  await triggerInternalCycle('/internal/run-graduation-cycle', 'graduation cycle');
  console.log(`[${new Date().toISOString()}] graduation cron finished`);
  process.exit(0);
} catch (err) {
  console.error(`[${new Date().toISOString()}] graduation cron crashed:`, err.message);
  process.exit(1);
}
