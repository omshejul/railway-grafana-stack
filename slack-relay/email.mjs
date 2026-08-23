const MAX_SUBJECT = 180;
const MAX_MESSAGE = 4_000;
const MAX_STACKTRACE = 12_000;
const MAX_EMAIL_ALERTS = 4;

function clean(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function truncate(value, limit) {
  const text = clean(value);
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function labelValue(payload, alert, ...keys) {
  for (const source of [alert?.labels, payload.commonLabels, payload.groupLabels]) {
    for (const key of keys) {
      if (source?.[key] !== undefined && String(source[key]).trim()) return String(source[key]).trim();
    }
  }
  return "unknown";
}

function annotationValue(payload, alert, ...keys) {
  for (const source of [alert?.annotations, payload.commonAnnotations]) {
    for (const key of keys) {
      if (source?.[key] !== undefined && String(source[key]).trim()) return String(source[key]).trim();
    }
  }
  return "";
}

function titleCase(value) {
  const text = clean(value, "Error");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function displayTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(date).replace(" at ", " ") + " UTC";
}

function numericValue(value) {
  const candidate = value && typeof value === "object" ? value.value : value;
  const number = Number(candidate);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function occurrenceCount(alert) {
  const direct = numericValue(alert?.values?.B);
  if (direct !== undefined) return direct;
  const match = clean(alert?.annotations?.description).match(/detected\s+(\d+)\s+(?:application\s+)?error/i);
  return match ? Number(match[1]) : 1;
}

function addresses(value) {
  const values = Array.isArray(value) ? value : String(value ?? "").split(",");
  return values.map((item) => item.trim()).filter(Boolean);
}

function renderButton(label, url, primary = false) {
  const href = safeUrl(url);
  if (!href) return "";
  const background = primary ? "#6c5ce7" : "#ffffff";
  const color = primary ? "#ffffff" : "#34303f";
  const border = primary ? "#6c5ce7" : "#c9c6d0";
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 17px;border:1px solid ${border};border-radius:5px;background:${background};color:${color};font-size:14px;font-weight:700;text-decoration:none">${escapeHtml(label)}</a>`;
}

function renderMetadata(rows) {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:separate;border-spacing:0 7px">${rows.map(([label, value]) => `<tr><td width="135" valign="top" style="padding:8px 12px 8px 0;color:#777180;font-size:14px;font-weight:700">${escapeHtml(label)}</td><td valign="top" style="padding:8px 12px;border-radius:4px;background:#f6f5f8;color:#29262f;font-size:14px">${escapeHtml(value)}</td></tr>`).join("")}</table>`;
}

function renderTags(tags) {
  const entries = Object.entries(tags ?? {}).filter(([, value]) => clean(value));
  if (entries.length === 0) return "";
  return `<h3 style="margin:30px 0 12px;color:#29262f;font-size:17px">Context</h3><div>${entries.map(([key, value]) => `<span style="display:inline-block;margin:0 7px 7px 0;padding:6px 9px;border-radius:4px;background:#f3f1f5;color:#5b5661;font-size:12px">${escapeHtml(key)} = <strong style="color:#5746d9">${escapeHtml(value)}</strong></span>`).join("")}</div>`;
}

function renderAlert(payload, alert, status) {
  const firing = status === "firing";
  const project = labelValue(payload, alert, "project", "project_name");
  const service = labelValue(payload, alert, "service", "service_name");
  const environment = labelValue(payload, alert, "environment", "environment_name", "deployment_environment");
  const severity = labelValue(payload, alert, "severity", "level");
  const relay = alert._relay ?? {};
  const exception = relay.exception ?? {};
  const eventName = clean(relay.eventName || annotationValue(payload, alert, "event_name", "eventName"));
  const summary = annotationValue(payload, alert, "summary") || labelValue(payload, alert, "alertname");
  const message = truncate(
    exception.message
    || eventName
    || annotationValue(payload, alert, "description")
    || summary,
    MAX_MESSAGE,
  );
  const issueType = titleCase(exception.type || relay.metadata?.error_type || severity || "Error");
  const stacktrace = truncate(exception.stacktrace || message, MAX_STACKTRACE);
  const count = occurrenceCount(alert);
  const generatorURL = safeUrl(alert.generatorURL || alert.dashboardURL);
  const traceLabel = relay.traceId ? `Trace ${relay.traceId.slice(0, 12)}…` : "";

  return `<div style="padding:34px 38px;border-top:1px solid #dfdce3">
    <div style="margin-bottom:10px;color:#777180;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Issue</div>
    <h2 style="margin:0 0 10px;font-size:24px;line-height:1.3">${generatorURL ? `<a href="${escapeHtml(generatorURL)}" style="color:#5b4bdb;text-decoration:none">${escapeHtml(issueType)}</a>` : escapeHtml(issueType)}</h2>
    <div style="margin:0 0 20px;color:#5d5764;font-size:17px;line-height:1.55">${escapeHtml(message)}</div>
    <div style="margin:0 0 24px;color:#777180;font-size:13px">${escapeHtml(displayTime(alert.startsAt))}&nbsp;&nbsp; · &nbsp;&nbsp;<strong>${escapeHtml(count)}</strong> occurrence${count === 1 ? "" : "s"}${traceLabel ? `&nbsp;&nbsp; · &nbsp;&nbsp;${escapeHtml(traceLabel)}` : ""}</div>
    ${renderMetadata([
      ["Project", project],
      ["Environment", environment],
      ["Service", service],
      ["Level", severity],
    ])}
    <h3 style="margin:30px 0 12px;color:#29262f;font-size:17px">Exception</h3>
    <pre style="box-sizing:border-box;max-width:100%;margin:0;padding:18px;overflow:auto;border:1px solid #dedbe2;border-radius:6px;background:#242328;color:#e2dfe6;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;white-space:pre-wrap;word-break:break-word">${escapeHtml(stacktrace)}</pre>
    ${renderTags(relay.metadata)}
    <div style="margin-top:28px">${renderButton("View alert", generatorURL, true)}${firing ? renderButton("Silence", alert.silenceURL) : ""}${renderButton("Open Grafana", payload.externalURL)}</div>
  </div>`;
}

export function buildEmailMessage(payload, options = {}) {
  const alerts = Array.isArray(payload.alerts) ? payload.alerts.slice(0, MAX_EMAIL_ALERTS) : [];
  const firstAlert = alerts[0] ?? {};
  const status = String(payload.status ?? "firing").toLowerCase() === "resolved" ? "resolved" : "firing";
  const firing = status === "firing";
  const project = labelValue(payload, firstAlert, "project", "project_name");
  const service = labelValue(payload, firstAlert, "service", "service_name");
  const relay = firstAlert._relay ?? {};
  const exception = relay.exception ?? {};
  const severity = labelValue(payload, firstAlert, "severity", "level");
  const issueType = titleCase(exception.type || relay.metadata?.error_type || severity || "Error");
  const message = truncate(
    exception.message
    || relay.eventName
    || annotationValue(payload, firstAlert, "event_name", "description", "summary"),
    90,
  );
  const subject = truncate(
    `[${firing ? "FIRING" : "RESOLVED"}] ${issueType} · ${project} / ${service}${message ? ` · ${message}` : ""}`,
    MAX_SUBJECT,
  );
  const statusColor = firing ? "#d92d3b" : "#16865a";
  const statusBackground = firing ? "#fff0f1" : "#ebfaf3";
  const alertName = labelValue(payload, firstAlert, "alertname");
  const hiddenPreview = `${firing ? "New" : "Resolved"} ${issueType} in ${project} / ${service}: ${message}`;
  const more = (payload.alerts?.length ?? 0) > alerts.length
    ? `<div style="padding:18px 38px;border-top:1px solid #dfdce3;color:#777180;font-size:13px">+${payload.alerts.length - alerts.length} additional alerts in this notification group</div>`
    : "";

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><style>
@media (prefers-color-scheme: dark) { .page { background:#17161a!important } .card { background:#211f24!important;border-color:#454149!important } .header-title,.headline { color:#f2eff4!important } }
</style></head>
<body class="page" style="margin:0;padding:24px;background:#f2f0f4;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#29262f">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(hiddenPreview)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
  <table role="presentation" class="card" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;border:1px solid #d5d1d9;border-radius:7px;background:#ffffff;overflow:hidden">
    <tr><td style="padding:25px 38px;border-bottom:1px solid #dfdce3">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr>
        <td class="header-title" style="color:#29262f;font-size:24px;font-weight:800"><span style="display:inline-block;width:17px;height:17px;margin-right:9px;border-radius:50%;background:#f36f21;vertical-align:-1px"></span>Grafana</td>
        <td align="right"><span style="display:inline-block;padding:7px 10px;border-radius:4px;background:${statusBackground};color:${statusColor};font-size:12px;font-weight:800;letter-spacing:.04em">${firing ? "FIRING" : "RESOLVED"}</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:30px 38px 22px">
      <div style="margin-bottom:5px;color:#777180;font-size:14px">${firing ? "New alert" : "Alert resolved"}</div>
      <h1 class="headline" style="margin:0;color:#29262f;font-size:26px;line-height:1.35">${escapeHtml(alertName)}</h1>
      <div style="margin-top:8px;color:#777180;font-size:14px">${escapeHtml(project)} / ${escapeHtml(service)}</div>
    </td></tr>
    ${alerts.map((alert) => renderAlert(payload, alert, status)).join("")}
    ${more}
    <tr><td style="padding:18px 38px;border-top:1px solid #dfdce3;color:#8b8590;font-size:12px">Grafana observability · ${escapeHtml(project)} · ${escapeHtml(status)}</td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = alerts.map((alert) => {
    const alertRelay = alert._relay ?? {};
    const alertException = alertRelay.exception ?? {};
    const alertProject = labelValue(payload, alert, "project", "project_name");
    const alertService = labelValue(payload, alert, "service", "service_name");
    const environment = labelValue(payload, alert, "environment", "environment_name", "deployment_environment");
    const stacktrace = alertException.stacktrace || alertException.message || alertRelay.eventName || annotationValue(payload, alert, "description");
    return `${firing ? "FIRING" : "RESOLVED"}: ${issueType}\n${alertProject} / ${alertService} / ${environment}\n${stacktrace}\n${safeUrl(alert.generatorURL)}`;
  }).join("\n\n");

  return {
    from: options.from,
    to: addresses(options.to),
    subject,
    text,
    html,
  };
}

export async function postToResend(message, apiKey, fetchImpl = fetch) {
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Resend delivery failed: ${response.status} ${detail.slice(0, 300)}`);
  }
  return response.json();
}
