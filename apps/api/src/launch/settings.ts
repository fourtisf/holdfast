import type { ApiConfig } from "../config.js";
import type { LaunchCostSettings } from "./cost.js";

export function launchCostSettings(c: ApiConfig): LaunchCostSettings {
  return c.launchPlan;
}
