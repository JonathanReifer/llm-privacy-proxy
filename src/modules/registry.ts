export type ScanDecision = "allow" | "ask" | "block";
export type FindingSeverity = "block" | "warn" | "info";

export interface ScanFinding {
  scannerId: string;
  description: string;
  severity: FindingSeverity;
  atlasTechnique?: string;
  owaspCategory?: string;
  detail?: Record<string, unknown>;
}

export interface ModuleScanResult {
  decision: ScanDecision;
  findings: ScanFinding[];
  durationMs: number;
  degraded?: boolean;
  degradedReason?: string;
}

export type ProxyPhase = "request" | "response";

export interface ProxyModule {
  readonly id: string;
  readonly phases: ProxyPhase[];
  scan(text: string, phase: ProxyPhase, sessionId?: string): Promise<ModuleScanResult>;
}

export class ModuleRegistry {
  private modules = new Map<string, ProxyModule>();

  register(module: ProxyModule): void {
    this.modules.set(module.id, module);
  }

  getModulesForPhase(phase: ProxyPhase): ProxyModule[] {
    return [...this.modules.values()].filter(m => m.phases.includes(phase));
  }

  get size(): number {
    return this.modules.size;
  }
}
