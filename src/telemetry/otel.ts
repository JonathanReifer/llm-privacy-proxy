// Minimal OTLP/HTTP logs emitter — no SDK dependency, matches this repo's
// zero-runtime-dependency convention. See aih-security/docs/telemetry-schema.md.
//
// No-op unless OTEL_EXPORTER_OTLP_ENDPOINT_HTTP (or OTEL_EXPORTER_OTLP_ENDPOINT,
// with :4317 swapped for :4318) is set. Never throws.
//
// This runs inside a long-running server process, so unlike the CLI hook
// producers, callers should NOT await this in a request's hot path — start it
// and let it settle in the background (true fire-and-forget).

const SCHEMA_VERSION = "1";
const COMPONENT = "aih-privacy-proxy";

export interface TelemetryRecord {
  session_id?: string;
  project?: string;
  harness?: string;
  scanner_id?: string;
  event_type: "prompt_scan" | "tool_scan" | "response_scan";
  decision?: "allow" | "ask" | "block";
  severity?: "block" | "warn" | "info";
  atlas_technique?: string;
  owasp_category?: string;
  degraded?: boolean;
  duration_ms?: number;
}

function resolveEndpoint(): string | null {
  const http = process.env.OTEL_EXPORTER_OTLP_ENDPOINT_HTTP;
  if (http) return http;
  const grpc = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (grpc) return grpc.replace(/:4317\/?$/, ":4318");
  return null;
}

type OtlpAttrValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function attrValue(value: unknown): OtlpAttrValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: String(value) };
}

/**
 * Emits one OTLP log record over HTTP. Resolves once the request settles
 * (success or failure) but never rejects and never throws. This process
 * stays alive regardless, so callers in the request path should call this
 * unawaited (fire-and-forget) rather than block on it.
 */
export async function emitLog(record: TelemetryRecord): Promise<void> {
  const endpoint = resolveEndpoint();
  if (!endpoint) return;

  try {
    const attributes = Object.entries({ schema_version: SCHEMA_VERSION, component: COMPONENT, ...record })
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({ key, value: attrValue(value) }));

    const body = JSON.stringify({
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: COMPONENT } },
              { key: "service.namespace", value: { stringValue: "aih-security" } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: `${BigInt(Date.now())}000000`,
                  severityText: record.severity ?? "info",
                  body: { stringValue: `${COMPONENT}.${record.event_type}` },
                  attributes,
                },
              ],
            },
          ],
        },
      ],
    });

    await fetch(`${endpoint.replace(/\/$/, "")}/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(300),
    });
  } catch {
    // fail open — telemetry must never affect a security decision
  }
}
