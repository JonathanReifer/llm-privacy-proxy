import { scan } from "../core.js";
import type { ProxyModule, ModuleScanResult, ProxyPhase, ScanFinding } from "./registry.js";

export class PrivacyProxyModule implements ProxyModule {
  readonly id = "privacy";
  readonly phases: ProxyPhase[] = ["request", "response"];

  async scan(text: string, phase: ProxyPhase, sessionId?: string): Promise<ModuleScanResult> {
    const start = performance.now();

    if (!text) {
      return { decision: "allow", findings: [], durationMs: performance.now() - start };
    }

    let coreResult;
    try {
      coreResult = await scan(text);
    } catch (err) {
      process.stderr.write(`[llm-proxy-module] privacy error: ${err}\n`);
      return { decision: "allow", findings: [], durationMs: performance.now() - start, degraded: true, degradedReason: String(err) };
    }

    const { matches, hasBlocks, hasWarnings } = coreResult;

    if (phase === "response") {
      // Response phase: advisory only — check for orphaned tokens and PII
      const orphaned = /\btok_[A-Za-z0-9_-]{12}\b/.test(text);
      const findings: ScanFinding[] = [];

      if (orphaned) {
        findings.push({
          scannerId: "privacy/orphaned-token",
          description: "LLM response contains unreplaced privacy token",
          severity: "warn",
          atlasTechnique: "AML.T0057",
          owaspCategory: "LLM02",
        });
      }

      for (const m of matches) {
        findings.push({
          scannerId: `privacy/${m.type}`,
          description: `PII in LLM response: ${m.type.replace(/_/g, " ")}`,
          severity: "info",
          atlasTechnique: "AML.T0057",
          owaspCategory: "LLM02",
        });
      }

      return { decision: "allow", findings, durationMs: performance.now() - start };
    }

    // Request phase
    if (matches.length === 0) {
      return { decision: "allow", findings: [], durationMs: performance.now() - start };
    }

    const findings: ScanFinding[] = matches.map(m => ({
      scannerId: `privacy/${m.type}`,
      description: `Privacy pattern in request: ${m.type.replace(/_/g, " ")}`,
      severity: m.severity === "block" ? "block" as const : "warn" as const,
      atlasTechnique: "AML.T0098",
      owaspCategory: "LLM02",
    }));

    return {
      decision: hasBlocks ? "block" : "ask",
      findings,
      durationMs: performance.now() - start,
    };
  }
}
