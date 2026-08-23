import { createServer } from "node:http";

import { buildEmailMessage, postToResend } from "./email.mjs";
import { buildSlackMessage, enrichPayloadWithTelemetry, isAuthorized, postToSlack } from "./relay.mjs";

const port = Number(process.env.PORT ?? "8080");
const slackToken = process.env.SLACK_BOT_TOKEN;
const channelId = process.env.SLACK_CHANNEL_ID;
const mentionUserId = process.env.SLACK_MENTION_USER_ID;
const webhookToken = process.env.GRAFANA_WEBHOOK_TOKEN;
const resendApiKey = process.env.RESEND_API_KEY;
const alertEmailFrom = process.env.ALERT_EMAIL_FROM;
const alertEmailTo = process.env.ALERT_EMAIL_TO;
const lokiQueryUrl = process.env.LOKI_QUERY_URL
  ?? "http://loki.railway.internal:3100/loki/api/v1/query_range";
const tempoQueryUrl = process.env.TEMPO_QUERY_URL
  ?? "http://tempo.railway.internal:3200/api/traces";
const emailEnabled = Boolean(resendApiKey || alertEmailFrom || alertEmailTo);

if (!slackToken) throw new Error("SLACK_BOT_TOKEN is required");
if (!channelId) throw new Error("SLACK_CHANNEL_ID is required");
if (!webhookToken) throw new Error("GRAFANA_WEBHOOK_TOKEN is required");
if (emailEnabled && (!resendApiKey || !alertEmailFrom || !alertEmailTo)) {
  throw new Error("RESEND_API_KEY, ALERT_EMAIL_FROM, and ALERT_EMAIL_TO are all required for email delivery");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");

function respond(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    respond(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST" || request.url !== "/grafana") {
    respond(response, 404, { error: "not_found" });
    return;
  }
  if (!isAuthorized(request.headers.authorization, webhookToken)) {
    respond(response, 401, { error: "unauthorized" });
    return;
  }

  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 1_048_576) request.destroy(new Error("payload_too_large"));
    else chunks.push(chunk);
  });
  request.on("end", () => {
    void (async () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let enrichedPayload = payload;
        try {
          enrichedPayload = await enrichPayloadWithTelemetry(payload, lokiQueryUrl, tempoQueryUrl);
        } catch (error) {
          console.warn(JSON.stringify({
            level: "warning",
            message: "Alert telemetry enrichment failed",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        const slackMessage = buildSlackMessage(enrichedPayload, { channelId, mentionUserId });
        const slackDelivery = postToSlack(slackMessage, slackToken);
        const emailDelivery = emailEnabled
          ? postToResend(buildEmailMessage(enrichedPayload, {
            from: alertEmailFrom,
            to: alertEmailTo,
          }), resendApiKey)
          : Promise.resolve(undefined);
        const [slackResult, emailResult] = await Promise.all([slackDelivery, emailDelivery]);
        console.log(JSON.stringify({
          level: "info",
          message: "Grafana notification sent",
          channel: slackResult.channel,
          slack_ts: slackResult.ts,
          resend_id: emailResult?.id,
          status: payload.status,
        }));
        respond(response, 200, { ok: true });
      } catch (error) {
        console.error(JSON.stringify({ level: "error", message: "Grafana notification failed", error: error instanceof Error ? error.message : String(error) }));
        respond(response, 502, { error: "delivery_failed" });
      }
    })();
  });
  request.on("error", (error) => {
    const status = error.message === "payload_too_large" ? 413 : 400;
    if (!response.headersSent) respond(response, status, { error: error.message });
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "Grafana notification relay ready", email_enabled: emailEnabled, port }));
});
