import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const perpside = github("Perpside/perpside", { checkSuites: false });

  const perpsideVolume = volume("perpside-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "sfo", sizeMB: 5000 });
  const perpside2 = service("perpside", {
    source: perpside,
    replicas: { "sfo": 1 },
    domains: ["perpside.fun"],
    volumeMounts: { "/data": perpsideVolume },
    env: { CLUSTER: preserve(), DB_PATH: preserve(), FRONTEND_ORIGIN: preserve(), PLATFORM_WALLET_SECRET: preserve(), RPC_URL: preserve() },
  });
  const rewardCron = service("reward-cron", {
    source: perpside,
    replicas: { "sfo": 1 },
    volumeMounts: { "/data": perpsideVolume },
    env: { CLUSTER: preserve(), DB_PATH: preserve(), RPC_URL: preserve(), PLATFORM_WALLET_SECRET: preserve() },
    deploy: { startCommand: "node --experimental-sqlite onchain/server/reward-cron.mjs", cronSchedule: "0 */2 * * *" },
  });

  return project("perpside", {
    resources: [perpside2, rewardCron, perpsideVolume],
  });
});
