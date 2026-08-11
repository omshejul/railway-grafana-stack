import { timingSafeEqual } from "node:crypto";

const MAX_TEXT = 2_900;
const MAX_ALERTS = 4;
const MAX_EVENT_NAME = 180;
const ERROR_SEVERITIES = new Set(["error", "critical", "fatal", "panic"]);
const FAILURE_COUNTER_PATTERN = /\b(unexpected_errors|error_count|failure_count|errors)=([0-9]+)\b/gi;
const CRASH_PATTERN = /(traceback \(most recent call last\)|uncaught (error|exception)|unhandled (exception|rejection)|panic:|fatal:|segmentation fault|out of memory|(^|\s)(error|exception):)/i;
const TRANSPORT_MISCLASSIFIED_INFO_PATTERN = /^(INFO:\s+|Terminating session: None$|StreamableHTTP session manager (started|shutting down)$)/;
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/i;
const EVENT_METADATA_KEYS = [
  "app_version",
  "error_action",
  "error_fatal",
  "error_source",
  "error_type",
  "feature_name",
  "os_type",
];

function clean(value, fallback = "unknown") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function truncate(value, limit = MAX_TEXT) {
  const text = clean(value, "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function escapeMrkdwn(value) {
  return truncate(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function firstValue(...values) {
  return values.find((value) => String(value ?? "").trim()) ?? "unknown";
}

function optionalValue(...values) {
  const value = values.find((candidate) => String(candidate ?? "").trim());
  return value === undefined ? "" : String(value).trim();
}

function sanitizedEventName(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/(authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1?[redacted]")
    .trim();
  if (!text || text === "unknown" || text.startsWith("{") || text.startsWith("[")) return "";
  return truncate(text, MAX_EVENT_NAME);
}

function logqlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function selectedMetadata(metadata) {
  const selected = {};
  for (const key of EVENT_METADATA_KEYS) {
    const value = metadata[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    selected[key] = truncate(String(value), 180);
  }
  return selected;
}

function normalizedSeverity(metadata) {
  return optionalValue(metadata.severity, metadata.level, metadata.detected_level).toLowerCase();
}

function nonzeroFailureCounter(line) {
  for (const match of String(line ?? "").matchAll(FAILURE_COUNTER_PATTERN)) {
    const value = Number(match[2]);
    if (Number.isSafeInteger(value) && value > 0) {
      return { name: match[1].toLowerCase(), value };
    }
  }
  return undefined;
}

export function classifyErrorEvent(metadata = {}, line = "") {
  for (const key of ["error_type", "exception", "analysis_failure"]) {
    if (String(metadata[key] ?? "").trim()) {
      return { signalKind: "structured_error", matchReason: `${key} is present` };
    }
  }

  if (TRANSPORT_MISCLASSIFIED_INFO_PATTERN.test(String(line ?? "").trim())) return undefined;

  const severity = normalizedSeverity(metadata);
  if (ERROR_SEVERITIES.has(severity)) {
    return {
      signalKind: "structured_error",
      matchReason: `${optionalValue(metadata.severity, metadata.level, metadata.detected_level)} severity`,
    };
  }

  const counter = nonzeroFailureCounter(line);
  if (counter) {
    return {
      signalKind: "failure_counter",
      matchReason: `${counter.name}=${counter.value}`,
      impact: `${counter.value} failure${counter.value === 1 ? "" : "s"} reported`,
    };
  }

  if (CRASH_PATTERN.test(String(line ?? ""))) {
    return {
      signalKind: "unstructured_crash",
      matchReason: "strong unstructured crash pattern",
    };
  }

  return undefined;
}

function latestErrorEvent(result) {
  const candidates = [];
  for (const stream of result?.data?.result ?? []) {
    const streamMetadata = stream.stream ?? {};
    for (const value of stream.values ?? []) {
      const [timestamp, line, structuredMetadata = {}] = value;
      const metadata = { ...streamMetadata, ...structuredMetadata };
      const classification = classifyErrorEvent(metadata, line);
      if (!classification) continue;
      const eventName = sanitizedEventName(
        metadata.event_name
        || metadata.eventName
        || line,
      );
      if (!eventName) continue;
      const traceId = TRACE_ID_PATTERN.test(String(metadata.trace_id ?? ""))
        ? String(metadata.trace_id).toLowerCase()
        : "";
      const spanId = SPAN_ID_PATTERN.test(String(metadata.span_id ?? ""))
        ? String(metadata.span_id).toLowerCase()
        : "";
      candidates.push({
        timestamp: BigInt(timestamp),
        eventName,
        traceId,
        spanId,
        metadata: selectedMetadata(metadata),
        ...classification,
      });
    }
  }
  candidates.sort((left, right) => (left.timestamp > right.timestamp ? -1 : 1));
  return candidates[0];
}

function attributeValue(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue", "bytesValue"]) {
    if (value[key] !== undefined) return value[key];
  }
  return undefined;
}

function attributesObject(attributes) {
  return Object.fromEntries((attributes ?? []).map((attribute) => [
    attribute.key,
    attributeValue(attribute.value),
  ]));
}

function otlpIdToHex(value) {
  const text = String(value ?? "");
  if (SPAN_ID_PATTERN.test(text)) return text.toLowerCase();
  try {
    const hex = Buffer.from(text, "base64").toString("hex");
    return SPAN_ID_PATTERN.test(hex) ? hex : "";
  } catch {
    return "";
  }
}

function traceSpans(trace) {
  const spans = [];
  for (const resourceSpans of trace?.resourceSpans ?? trace?.batches ?? []) {
    for (const scopeSpans of resourceSpans.scopeSpans ?? resourceSpans.instrumentationLibrarySpans ?? []) {
      spans.push(...(scopeSpans.spans ?? []));
    }
  }
  return spans;
}

function exceptionFromSpan(span) {
  for (const event of span?.events ?? []) {
    const attributes = attributesObject(event.attributes);
    const stacktrace = clean(attributes["exception.stacktrace"], "");
    const message = clean(attributes["exception.message"], "");
    const type = clean(attributes["exception.type"], "");
    if (stacktrace || message || type || event.name === "exception") {
      return {
        type: truncate(type || "Error", 120),
        message: truncate(message, 4_000),
        stacktrace: truncate(stacktrace, 12_000),
      };
    }
  }
  return undefined;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function labelValue(payload, alert, ...keys) {
  const sources = [alert?.labels, payload.commonLabels, payload.groupLabels];
  for (const source of sources) {
    for (const key of keys) {
      if (source?.[key]) return source[key];
    }
  }
  return "unknown";
}

function linkedText(label, url) {
  const validUrl = safeUrl(url);
  const text = escapeMrkdwn(label);
  return validUrl ? `<${validUrl}|${text}>` : text;
}

function relativeDate(value) {
  const timestamp = Math.floor(new Date(value).getTime() / 1_000);
  return Number.isFinite(timestamp)
    ? `<!date^${timestamp}^{relative}|recently>`
    : "unknown";
}

function codeBlock(value) {
  const text = escapeMrkdwn(value).replaceAll("```", "''' ");
  return `\`\`\`\n${truncate(text, 2_700)}\n\`\`\``;
}

export function isAuthorized(header, secret) {
  if (!secret || typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function findLatestErrorEvent(alert, payload, lokiQueryUrl, fetchImpl = fetch) {
  if (!lokiQueryUrl) return undefined;
  const project = labelValue(payload, alert, "project", "project_name");
  const service = labelValue(payload, alert, "service", "service_name");
  const environment = labelValue(payload, alert, "environment", "environment_name", "deployment_environment");
  if ([project, service, environment].includes("unknown")) return undefined;

  const now = Date.now();
  const alertStart = new Date(alert.startsAt ?? now).getTime();
  const boundedStart = Number.isFinite(alertStart)
    ? Math.max(alertStart - 5 * 60_000, now - 60 * 60_000)
    : now - 15 * 60_000;
  const selector = `{project_name=${logqlString(project)},service_name=${logqlString(service)},environment_name=${logqlString(environment)}}`;
  const url = new URL(lokiQueryUrl);
  url.searchParams.set("query", selector);
  url.searchParams.set("start", String(BigInt(boundedStart) * 1_000_000n));
  url.searchParams.set("end", String(BigInt(now) * 1_000_000n));
  url.searchParams.set("direction", "backward");
  url.searchParams.set("limit", "100");

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(2_500) });
  if (!response.ok) throw new Error(`Loki event lookup failed: ${response.status}`);
  return latestErrorEvent(await response.json());
}

export async function findLatestEventName(alert, payload, lokiQueryUrl, fetchImpl = fetch) {
  return (await findLatestErrorEvent(alert, payload, lokiQueryUrl, fetchImpl))?.eventName ?? "";
}

export async function findTraceException(traceId, spanId, tempoQueryUrl, fetchImpl = fetch) {
  if (!TRACE_ID_PATTERN.test(String(traceId ?? "")) || !tempoQueryUrl) return undefined;
  const url = new URL(`${tempoQueryUrl.replace(/\/$/, "")}/${traceId}`);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(3_500) });
  if (!response.ok) throw new Error(`Tempo trace lookup failed: ${response.status}`);
  const spans = traceSpans(await response.json());
  const matchingSpan = spans.find((span) => otlpIdToHex(span.spanId) === spanId);
  return exceptionFromSpan(matchingSpan) ?? spans.map(exceptionFromSpan).find(Boolean);
}

export async function enrichPayloadWithTelemetry(
  payload,
  lokiQueryUrl,
  tempoQueryUrl,
  fetchImpl = fetch,
) {
  const alerts = await Promise.all((payload.alerts ?? []).map(async (alert) => {
    const existing = sanitizedEventName(
      alert.annotations?.event_name
      || alert.annotations?.eventName
      || alert.labels?.event_name,
    );
    const event = await findLatestErrorEvent(alert, payload, lokiQueryUrl, fetchImpl);
    const eventName = existing || event?.eventName || "";
    let exception;
    if (event?.traceId) {
      try {
        exception = await findTraceException(
          event.traceId,
          event.spanId,
          tempoQueryUrl,
          fetchImpl,
        );
      } catch {
        exception = undefined;
      }
    }
    if (!eventName && !event) return alert;
    return {
      ...alert,
      annotations: eventName
        ? { ...alert.annotations, event_name: eventName }
        : alert.annotations,
      _relay: {
        eventName,
        traceId: event?.traceId ?? "",
        spanId: event?.spanId ?? "",
        timestamp: event?.timestamp ? event.timestamp.toString() : "",
        metadata: event?.metadata ?? {},
        signalKind: event?.signalKind ?? "",
        matchReason: event?.matchReason ?? "",
        impact: event?.impact ?? "",
        exception,
      },
    };
  }));
  return { ...payload, alerts };
}

export async function enrichPayloadWithEventNames(payload, lokiQueryUrl, fetchImpl = fetch) {
  return enrichPayloadWithTelemetry(payload, lokiQueryUrl, undefined, fetchImpl);
}

export function buildSlackMessage(payload, options = {}) {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts : [];
  const status = String(payload.status ?? "firing").toLowerCase() === "resolved" ? "resolved" : "firing";
  const firing = status === "firing";
  const statusText = firing ? "FIRING" : "RESOLVED";
  const alertName = firstValue(
    payload.commonLabels?.alertname,
    payload.groupLabels?.alertname,
    alerts[0]?.labels?.alertname,
    "Grafana alert",
  );
  const firstAlert = alerts[0] ?? {};
  const project = labelValue(payload, firstAlert, "project", "project_name");
  const service = labelValue(payload, firstAlert, "service", "service_name");
  const environment = labelValue(payload, firstAlert, "environment", "environment_name", "deployment_environment");
  const firstEventName = sanitizedEventName(
    firstAlert.annotations?.event_name
    || firstAlert.annotations?.eventName
    || firstAlert.labels?.event_name,
  );
  const mention = options.mentionUserId ? `<@${options.mentionUserId}>` : undefined;
  const fallback = `${mention ? `${mention} ` : ""}${statusText}: ${alertName}${firstEventName ? ` · ${firstEventName}` : ""} · ${project}/${service} (${environment})`;
  const blocks = [];

  for (const [index, alert] of alerts.slice(0, MAX_ALERTS).entries()) {
    if (index > 0) blocks.push({ type: "divider" });
    const name = firstValue(alert.labels?.alertname, alertName);
    const summary = firstValue(alert.annotations?.summary, payload.commonAnnotations?.summary, alertName);
    const description = optionalValue(alert.annotations?.description, payload.commonAnnotations?.description, summary);
    const alertProject = labelValue(payload, alert, "project", "project_name");
    const alertService = labelValue(payload, alert, "service", "service_name");
    const alertEnvironment = labelValue(payload, alert, "environment", "environment_name", "deployment_environment");
    const alertSeverity = labelValue(payload, alert, "severity", "level");
    const eventName = sanitizedEventName(
      alert.annotations?.event_name
      || alert.annotations?.eventName
      || alert.labels?.event_name,
    );
    const matchReason = optionalValue(alert._relay?.matchReason, alert.annotations?.match_reason);
    const impact = optionalValue(alert._relay?.impact, alert.annotations?.impact);
    const titleUrl = safeUrl(alert.generatorURL) ?? safeUrl(alert.dashboardURL);
    const state = firing ? "Firing" : "Resolved";
    const suggested = mention ? `  *Suggested:* ${mention}` : "";

    blocks.push({
      type: "section",
      block_id: `alert-${index}-${truncate(alert.fingerprint ?? index, 80)}`,
      text: {
        type: "mrkdwn",
        text: `${firing ? "🔴" : "🟢"} *${linkedText(name, titleUrl)}*\n\n${escapeMrkdwn(summary)}`,
      },
    });
    if (eventName) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `*Event:* \`${escapeMrkdwn(eventName)}\`` },
      });
    }
    if (matchReason) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Why:* ${escapeMrkdwn(matchReason)}${impact ? `\n*Impact:* ${escapeMrkdwn(impact)}` : ""}`,
        },
      });
    }
    blocks.push({ type: "section", text: { type: "mrkdwn", text: codeBlock(description) } });
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `environment: \`${escapeMrkdwn(alertEnvironment)}\`   severity: \`${escapeMrkdwn(alertSeverity)}\`\n\n*State:* ${state}   *First Seen:* ${relativeDate(alert.startsAt)}${suggested}`,
      },
    });

    const links = [
      linkedText("Open alert", alert.generatorURL),
      ...(firing && safeUrl(alert.silenceURL) ? [linkedText("Silence", alert.silenceURL)] : []),
    ];
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `${escapeMrkdwn(alertProject)}-${escapeMrkdwn(alertService)} | ${escapeMrkdwn(alertEnvironment)} | ${links.join(" | ")}`,
      }],
    });
  }

  if (alerts.length > MAX_ALERTS) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `+${alerts.length - MAX_ALERTS} more alerts in this group` }] });
  }

  return {
    channel: options.channelId,
    text: fallback,
    blocks: blocks.slice(0, 50),
    unfurl_links: false,
    unfurl_media: false,
  };
}

export async function postToSlack(message, token, fetchImpl = fetch) {
  const response = await fetchImpl("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(message),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Slack delivery failed: ${result.error ?? response.status}`);
  return result;
}
