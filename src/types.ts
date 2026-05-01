export type PatternType =
  | "api_key_openai"
  | "api_key_anthropic"
  | "api_key_xai"
  | "api_key_aws_access"
  | "api_key_aws_secret"
  | "api_key_github"
  | "api_key_google"
  | "api_key_slack"
  | "api_key_stripe"
  | "api_key_twilio"
  | "api_key_sendgrid"
  | "api_key_generic"
  | "pii_email"
  | "pii_phone_us"
  | "pii_ssn_us"
  | "pii_credit_card"
  | "pii_ipv4"
  | "pii_passport_us"
  | "pii_dob";

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
  refCount?: number;
  lastAccessedAt?: string;
}

export interface IVault {
  readonly mode: "sqlite" | "memory";
  readonly path: string | null;
  get(token: string): Promise<VaultEntry | null>;
  put(entry: VaultEntry): Promise<void>;
  list(limit?: number): Promise<VaultEntry[]>;
  search(query: string): Promise<VaultEntry[]>;
  stats(): Promise<Partial<Record<PatternType, number>>>;
  hot(limit?: number): Promise<VaultEntry[]>;
}
