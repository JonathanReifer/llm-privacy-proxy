export { ModuleRegistry } from "./registry.js";
export type { ProxyModule, ProxyPhase, ScanDecision, FindingSeverity, ScanFinding, ModuleScanResult } from "./registry.js";
export { ProxyPipeline } from "./pipeline.js";
export { PrivacyProxyModule } from "./privacy.module.js";

import { ModuleRegistry } from "./registry.js";
import { ProxyPipeline } from "./pipeline.js";
import { PrivacyProxyModule } from "./privacy.module.js";

export function createDefaultProxyPipeline(): ProxyPipeline {
  const registry = new ModuleRegistry();
  registry.register(new PrivacyProxyModule());
  return new ProxyPipeline(registry);
}
