export type PatternType =
  | "api_key_openai"
  | "api_key_anthropic"
  | "api_key_xai"
  | "api_key_aws_access"
  | "api_key_github"
  | "api_key_generic"
  | "pii_email"
  | "pii_phone_us"
  | "pii_ssn_us"
  | "pii_credit_card";

export type Severity = "block" | "warn";

export interface PatternDefinition {
  type: PatternType;
  regex: RegExp;
  severity: Severity;
  description: string;
}

export interface ScanMatch {
  type: PatternType;
  severity: Severity;
  original: string;
  token: string;
  offset: number;
  length: number;
}

export interface ScanResult {
  matches: ScanMatch[];
  hasBlocks: boolean;
  hasWarnings: boolean;
}

export interface VaultEntry {
  token: string;
  original: string;
  type: PatternType;
  createdAt: string;
  sessionId?: string;
}

export interface VaultData {
  version: 1;
  entries: Record<string, VaultEntry>;
}

export interface IVault {
  readonly mode: "file" | "memory";
  readonly path: string | null;
  get(token: string): Promise<VaultEntry | null>;
  put(entry: VaultEntry): Promise<void>;
  list(limit?: number): Promise<VaultEntry[]>;
  search(query: string): Promise<VaultEntry[]>;
  stats(): Promise<Partial<Record<PatternType, number>>>;
}
