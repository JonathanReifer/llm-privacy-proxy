import { ModuleRegistry, ModuleScanResult, ProxyModule, ProxyPhase, ScanDecision, ScanFinding } from "./registry.js";

const SEVERITY_ORDER: Record<string, number> = { block: 2, warn: 1, info: 0 };
const DECISION_ORDER: Record<ScanDecision, number> = { block: 2, ask: 1, allow: 0 };

export class ProxyPipeline {
  constructor(private registry: ModuleRegistry) {}

  register(module: ProxyModule): void {
    this.registry.register(module);
  }

  async runPhase(phase: ProxyPhase, text: string, sessionId: string): Promise<ModuleScanResult> {
    const modules = this.registry.getModulesForPhase(phase);
    const start = performance.now();

    const settled = await Promise.allSettled(
      modules.map(m => m.scan(text, phase, sessionId))
    );

    let worstDecision: ScanDecision = "allow";
    const allFindings: ScanFinding[] = [];
    let anyDegraded = false;
    const degradedReasons: string[] = [];

    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "rejected") {
        process.stderr.write(`[llm-proxy-module] ${modules[i].id} error: ${r.reason}\n`);
        anyDegraded = true;
        degradedReasons.push(String(r.reason));
        continue;
      }
      const result = r.value;
      if (result.degraded) {
        anyDegraded = true;
        if (result.degradedReason) degradedReasons.push(result.degradedReason);
      }
      // Response phase is advisory — never escalate to block
      if (phase === "request" && DECISION_ORDER[result.decision] > DECISION_ORDER[worstDecision]) {
        worstDecision = result.decision;
      }
      allFindings.push(...result.findings);
    }

    allFindings.sort((a, b) => (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0));

    return {
      decision: phase === "response" ? "allow" : worstDecision,
      findings: allFindings,
      durationMs: performance.now() - start,
      ...(anyDegraded ? { degraded: true, degradedReason: degradedReasons.join("; ") } : {}),
    };
  }

  getModuleCount(): number {
    return this.registry.size;
  }
}
