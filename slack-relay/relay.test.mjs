import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSlackMessage,
  classifyErrorEvent,
  enrichPayloadWithEventNames,
  enrichPayloadWithTelemetry,
  findLatestErrorEvent,
  findLatestEventName,
  findTraceException,
  isAuthorized,
  postToSlack,
} from "./relay.mjs";

test("classifies only explicit error signals", () => {
  const negatives = [
    "worker cycle materialized=2 unexpected_errors=0 delivered=2",
    "worker cycle error_count=0",
    "no errors detected",
    "GET /error/settings 200",
    "email_retried=0 email_discarded=0",
    "Terminating session: None",
    "INFO:     Application startup complete.",
    "INFO:     Received SIGTERM, exiting.",
    "StreamableHTTP session manager started",
    "StreamableHTTP session manager shutting down",
  ];
  for (const line of negatives) {
    assert.equal(classifyErrorEvent({ level: "info", severity: "info" }, line), undefined, line);
  }

  assert.deepEqual(
    classifyErrorEvent({ level: "info" }, "worker cycle unexpected_errors=2"),
    {
      signalKind: "failure_counter",
      matchReason: "unexpected_errors=2",
      impact: "2 failures reported",
    },
  );
  assert.deepEqual(
    classifyErrorEvent({ severity: "error" }, "request failed"),
    { signalKind: "structured_error", matchReason: "error severity" },
  );
  assert.deepEqual(
    classifyErrorEvent({ level: "info", error_type: "CheckoutError" }, "INFO: checkout failed"),
    { signalKind: "structured_error", matchReason: "error_type is present" },
  );
  assert.deepEqual(
    classifyErrorEvent({}, "Traceback (most recent call last):"),
    { signalKind: "unstructured_crash", matchReason: "strong unstructured crash pattern" },
  );
});

test("does not enrich from a harmless error counter", async () => {
  const event = await findLatestErrorEvent(
    payload.alerts[0],
    payload,
    "http://loki.test/loki/api/v1/query_range",
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          result: [{
            stream: { level: "info", severity: "info" },
            values: [["1786470684228845716", "worker cycle unexpected_errors=0 delivered=2"]],
          }],
        },
      }),
    }),
  );
  assert.equal(event, undefined);
});

const payload = {
  receiver: "Grafana",
  status: "firing",
  alerts: [{
    status: "firing",
    labels: { alertname: "Application error detected", project_name: "PetTech", service_name: "web", environment_name: "production", severity: "error" },
    annotations: {
      summary: "Application error in PetTech / web",
      description: "Test exception from checkout",
    },
    values: { B: 1, C: 1 },
    startsAt: "2026-08-11T14:00:00Z",
    generatorURL: "https://grafana.example/alerting/rule/view",
    silenceURL: "https://grafana.example/alerting/silence/new",
    fingerprint: "abc123",
  }],
  commonLabels: { alertname: "Application error detected", project_name: "PetTech", service_name: "web", environment_name: "production", severity: "error" },
  externalURL: "https://grafana.example/",
};

test("builds an accessible Block Kit alert", () => {
  const message = buildSlackMessage(payload, { channelId: "C123", mentionUserId: "U123" });
  assert.equal(message.channel, "C123");
  assert.match(message.text, /<@U123> FIRING/);
  assert.equal(message.blocks[0].type, "section");
  assert.match(message.blocks[0].text.text, /🔴.*Application error detected/);
  assert.ok(message.blocks.some((block) => block.type === "context"));
  assert.ok(!message.blocks.some((block) => block.type === "actions"));
  assert.ok(message.blocks.length <= 50);
});

test("uses alert annotations instead of Grafana expression references", () => {
  const message = buildSlackMessage({
    ...payload,
    alerts: [{
      ...payload.alerts[0],
      annotations: {
        summary: "Application error in PetTech / web",
        description: "Grafana detected 1 error-like log line for PetTech / web in the last five minutes.",
      },
    }],
  });
  const rendered = JSON.stringify(message.blocks);
  assert.match(rendered, /1 error-like log line/);
  assert.doesNotMatch(rendered, /B=1|C=1|Values:/);
  assert.doesNotMatch(rendered, /Grafana · Grafana|2026-08-11T14:00:00Z/);
  assert.match(rendered, /environment:.*production/);
  assert.match(rendered, /PetTech-web.*production.*Open alert.*Silence/);
});

test("renders a safe event name without Grafana expression values", () => {
  const message = buildSlackMessage({
    ...payload,
    alerts: [{
      ...payload.alerts[0],
      annotations: {
        ...payload.alerts[0].annotations,
        event_name: "MobileCoverageVerification_20260811_1751",
      },
    }],
  });
  const rendered = JSON.stringify(message);
  assert.match(rendered, /Event:.*MobileCoverageVerification_20260811_1751/);
  assert.match(message.text, /MobileCoverageVerification_20260811_1751/);
  assert.doesNotMatch(rendered, /B=1|C=1|Values:/);
});

test("looks up the latest error event from Loki", async () => {
  const eventName = await findLatestEventName(
    payload.alerts[0],
    payload,
    "http://loki.test/loki/api/v1/query_range",
    async (url) => {
      assert.match(url.searchParams.get("query"), /project_name="PetTech"/);
      return {
        ok: true,
        json: async () => ({
          data: {
            result: [{
              stream: { error_type: "Error", error_source: "mobile" },
              values: [[
                "1786470684228845716",
                "MobileCoverageVerification_20260811_1751",
              ]],
            }],
          },
        }),
      };
    },
  );
  assert.equal(eventName, "MobileCoverageVerification_20260811_1751");
});

test("keeps trace metadata from the latest Loki error", async () => {
  const event = await findLatestErrorEvent(
    payload.alerts[0],
    payload,
    "http://loki.test/loki/api/v1/query_range",
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          result: [{
            stream: { level: "error" },
            values: [[
              "1786470684228845716",
              "CheckoutError",
              {
                trace_id: "35f8bf0777eda528c7f0c30b25913f2b",
                span_id: "9629a16ad53ba8a0",
                error_type: "Error",
                feature_name: "checkout",
              },
            ]],
          }],
        },
      }),
    }),
  );
  assert.equal(event.eventName, "CheckoutError");
  assert.equal(event.traceId, "35f8bf0777eda528c7f0c30b25913f2b");
  assert.equal(event.spanId, "9629a16ad53ba8a0");
  assert.deepEqual(event.metadata, { error_type: "Error", feature_name: "checkout" });
  assert.equal(event.signalKind, "structured_error");
  assert.equal(event.matchReason, "error_type is present");
});

test("shows the exact reason and impact in Slack", () => {
  const message = buildSlackMessage({
    ...payload,
    alerts: [{
      ...payload.alerts[0],
      _relay: {
        matchReason: "unexpected_errors=2",
        impact: "2 failures reported",
      },
    }],
  });
  const rendered = JSON.stringify(message.blocks);
  assert.match(rendered, /Why:.*unexpected_errors=2/);
  assert.match(rendered, /Impact:.*2 failures reported/);
});

test("extracts an exception and stack trace from Tempo", async () => {
  const exception = await findTraceException(
    "35f8bf0777eda528c7f0c30b25913f2b",
    "9629a16ad53ba8a0",
    "http://tempo.test/api/traces",
    async (url) => {
      assert.match(url.toString(), /api\/traces\/35f8bf0777eda528c7f0c30b25913f2b$/);
      return {
        ok: true,
        json: async () => ({
          resourceSpans: [{
            scopeSpans: [{
              spans: [{
                spanId: "limhatU7qKA=",
                events: [{
                  name: "exception",
                  attributes: [
                    { key: "exception.type", value: { stringValue: "Error" } },
                    { key: "exception.message", value: { stringValue: "Checkout failed" } },
                    { key: "exception.stacktrace", value: { stringValue: "Error: Checkout failed\n    at checkout.js:10:2" } },
                  ],
                }],
              }],
            }],
          }],
        }),
      };
    },
  );
  assert.equal(exception.type, "Error");
  assert.equal(exception.message, "Checkout failed");
  assert.match(exception.stacktrace, /checkout\.js:10:2/);
});

test("enriches an alert with its Loki event and Tempo exception", async () => {
  const enriched = await enrichPayloadWithTelemetry(
    payload,
    "http://loki.test/loki/api/v1/query_range",
    "http://tempo.test/api/traces",
    async (url) => {
      if (url.hostname === "loki.test") {
        return {
          ok: true,
          json: async () => ({
            data: {
              result: [{
                stream: { level: "error" },
                values: [["1786470684228845716", "Checkout failed", {
                  trace_id: "35f8bf0777eda528c7f0c30b25913f2b",
                  span_id: "9629a16ad53ba8a0",
                  error_type: "Error",
                }]],
              }],
            },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          resourceSpans: [{ scopeSpans: [{ spans: [{
            spanId: "limhatU7qKA=",
            events: [{
              name: "exception",
              attributes: [
                { key: "exception.type", value: { stringValue: "Error" } },
                { key: "exception.message", value: { stringValue: "Checkout failed" } },
                { key: "exception.stacktrace", value: { stringValue: "Error: Checkout failed\n    at checkout.js:10:2" } },
              ],
            }],
          }] }] }],
        }),
      };
    },
  );
  assert.equal(enriched.alerts[0].annotations.event_name, "Checkout failed");
  assert.equal(enriched.alerts[0]._relay.exception.type, "Error");
  assert.match(enriched.alerts[0]._relay.exception.stacktrace, /checkout\.js/);
});

test("enriches firing alerts and redacts secrets", async () => {
  const enriched = await enrichPayloadWithEventNames(
    payload,
    "http://loki.test/loki/api/v1/query_range",
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          result: [{
            values: [["1786470684228845716", "token=not-for-slack", { error_type: "Error" }]],
          }],
        },
      }),
    }),
  );
  assert.equal(enriched.alerts[0].annotations.event_name, "token=[redacted]");
});

test("keeps the event name on resolved alerts", async () => {
  const enriched = await enrichPayloadWithEventNames(
    { ...payload, status: "resolved" },
    "http://loki.test/loki/api/v1/query_range",
    async () => ({
      ok: true,
      json: async () => ({
        data: {
          result: [{
            stream: { error_type: "Error" },
            values: [["1786470684228845716", "MobileCoverageVerification_20260811_1751"]],
          }],
        },
      }),
    }),
  );
  assert.equal(enriched.alerts[0].annotations.event_name, "MobileCoverageVerification_20260811_1751");
});

test("validates bearer tokens", () => {
  assert.equal(isAuthorized("Bearer secret", "secret"), true);
  assert.equal(isAuthorized("Bearer wrong", "secret"), false);
  assert.equal(isAuthorized(undefined, "secret"), false);
});

test("surfaces Slack API errors", async () => {
  await assert.rejects(
    postToSlack({}, "token", async () => ({ ok: true, json: async () => ({ ok: false, error: "invalid_blocks" }) })),
    /invalid_blocks/,
  );
});
