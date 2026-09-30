// Entry point for the graduation cron — deployed as its own Railway
// service (Cron Schedule, not a long-running process), same reasoning as
// reward-cron.mjs: a stuck graduation run can't affect the site staying up,
// and vice versa. Runs once and exits.
import { runGraduationCycle } from './graduation.mjs';

console.log(`[${new Date().toISOString()}] graduation cron starting`);
try {
  await runGraduationCycle();
  console.log(`[${new Date().toISOString()}] graduation cron finished`);
  process.exit(0);
} catch (err) {
  console.error(`[${new Date().toISOString()}] graduation cron crashed:`, err);
  process.exit(1);
}
