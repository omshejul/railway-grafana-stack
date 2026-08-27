import assert from "node:assert/strict";
import test from "node:test";

import { buildEmailMessage, postToResend, shouldSendEmail } from "./email.mjs";

const payload = {
  status: "firing",
  externalURL: "https://grafana.example/",
  alerts: [{
    labels: {
      alertname: "Application error detected",
      project_name: "PetTech",
      service_name: "web",
      environment_name: "production",
      severity: "error",
    },
    annotations: {
      summary: "Application error in PetTech / web",
      description: "Grafana detected 8 application error events in the last five minutes.",
      event_name: "fetch failed: UnknownHostException",
    },
    values: { B: 8, C: 1 },
    startsAt: "2026-08-11T18:37:00Z",
    generatorURL: "https://grafana.example/alerting/rule/view",
    silenceURL: "https://grafana.example/alerting/silence/new",
    _relay: {
      eventName: "fetch failed: UnknownHostException",
      traceId: "35f8bf0777eda528c7f0c30b25913f2b",
      metadata: {
        error_type: "Error",
        error_source: "mobile",
        feature_name: "authentication",
        os_type: "android",
      },
      exception: {
        type: "Error",
        message: "fetch failed: UnknownHostException",
        stacktrace: "Error: fetch failed: UnknownHostException\n    at signIn (/app/auth.js:10:2)",
      },
    },
  }],
};

test("builds a Sentry-like email from enriched alert data", () => {
  const message = buildEmailMessage(payload, {
    from: "Grafana <alerts@theom.app>",
    to: "omshejul07@gmail.com",
  });
  assert.match(message.subject, /^\[FIRING\] Error · PetTech \/ web/);
  assert.deepEqual(message.to, ["omshejul07@gmail.com"]);
  assert.match(message.html, />Exception</);
  assert.match(message.html, /UnknownHostException/);
  assert.match(message.html, /signIn/);
  assert.match(message.html, /<strong>8<\/strong> occurrences/);
  assert.match(message.html, /Project<\/td>.*PetTech/s);
  assert.match(message.html, /Environment<\/td>.*production/s);
  assert.match(message.html, /feature_name.*authentication/s);
  assert.doesNotMatch(message.html, /B=8|C=1|Values/);
});

test("posts the custom email through Resend", async () => {
  const result = await postToResend(
    buildEmailMessage(payload, { from: "Grafana <alerts@theom.app>", to: "om@example.com" }),
    "resend-key",
    async (_url, request) => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer resend-key");
      const body = JSON.parse(request.body);
      assert.match(body.html, /Exception/);
      return { ok: true, json: async () => ({ id: "email-123" }) };
    },
  );
  assert.equal(result.id, "email-123");
});

test("emails only firing critical alerts", () => {
  const critical = {
    ...payload,
    alerts: [{
      ...payload.alerts[0],
      labels: { ...payload.alerts[0].labels, severity: "critical" },
    }],
  };

  assert.equal(shouldSendEmail(critical), true);
  assert.equal(shouldSendEmail({ ...critical, status: "resolved" }), false);
  assert.equal(shouldSendEmail(payload), false);
  assert.equal(shouldSendEmail({
    ...payload,
    alerts: [{
      ...payload.alerts[0],
      labels: { ...payload.alerts[0].labels, severity: "warning" },
    }],
  }), false);
});
