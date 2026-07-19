/**
 * Re-export engines từ bản full (../lib).
 * Deploy Render: root git = "Auto Best" (chứa cả lite/ và lib/).
 */
export { runFarmAuto, clearFarmRuntimeLocks } from "../../lib/farmEngine";
export { runAutoBuffCheck } from "../../lib/buffEngine";
export {
  runClaimExpAuto,
  runAchievementClaimAuto,
  runBodyCultAuto,
  runOnboardingClaimAuto,
  runWorldCupCheckinAuto,
} from "../../lib/dailyEngine";
export { runWorldBossAuto } from "../../lib/worldBossEngine";
export { runBreakthroughAuto } from "../../lib/breakthroughEngine";
export { runMailClaimAll } from "../../lib/mailEngine";
export { runMazeAuto } from "../../lib/mazeEngine";
export { runAutoEquipCheck } from "../../lib/autoEquipEngine";
export { runCraftAuto } from "../../lib/craftEngine";
export { runPvpAuto } from "../../lib/pvpEngine";
export { runNhapMongAuto } from "../../lib/nhapMongEngine";
export { runKhoiLoiAuto } from "../../lib/khoiLoiEngine";
