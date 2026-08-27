import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
    "Waiting up to 2 seconds",
    "Press Ctrl-C to quit",
    "Sentry is attempting to send 2 pending events",
    "[2026-08-23 12:57:16 +0000] [1] [INFO] Starting gunicorn 26.0.0",
    "    at ignore-listed frames",
    "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action",
    "StreamableHTTP session manager started",
    "StreamableHTTP session manager shutting down",
    "2026-08-12 07:52:07.952 UTC [101] LOG:  checkpoint starting: time",
    "2026-08-12 07:52:08.268 UTC [101] LOG:  checkpoint complete: wrote 3 buffers",
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
  assert.equal(
    classifyErrorEvent({ severity: "error" }, "Not Found: /robots.txt"),
    undefined,
  );
  assert.equal(
    classifyErrorEvent({ severity: "error" }, "Not Found: /api/widgets/42"),
    undefined,
  );
  assert.equal(
    classifyErrorEvent({ severity: "error" }, "Unauthorized: /api/v1/jobs"),
    undefined,
  );
  assert.equal(
    classifyErrorEvent(
      { severity: "error" },
      'Error: The Server Reference ID did not match the expected format. Received "x".',
    ),
    undefined,
  );
  assert.deepEqual(
    classifyErrorEvent(
      { severity: "error" },
      'Error: The Server Reference ID did not match the expected format. Received "40f9a24c2e95d41a".',
    ),
    { signalKind: "structured_error", matchReason: "error severity" },
  );
  assert.equal(
    classifyErrorEvent(
      { severity: "error", error_type: "Error" },
      "MobileCoverageVerification_20260811_1751",
    ),
    undefined,
  );
  assert.equal(
    classifyErrorEvent(
      { severity: "error" },
      '{"message":"test","client_error_type":"observability_test"}',
    ),
    undefined,
  );
  assert.deepEqual(
    classifyErrorEvent(
      { severity: "error" },
      "Failed to export span batch code: request timed out",
    ),
    { signalKind: "structured_error", matchReason: "error severity" },
  );
  assert.equal(
    classifyErrorEvent(
      { severity: "error" },
      "2026-08-12 07:52:08.268 UTC [101] LOG:  checkpoint complete: wrote 3 buffers",
    ),
    undefined,
  );
  assert.deepEqual(
    classifyErrorEvent({ severity: "error" }, "DatabaseError: connection refused"),
    { signalKind: "structured_error", matchReason: "error severity" },
  );
  assert.deepEqual(
    classifyErrorEvent(
      { severity: "error" },
      "2026-08-12 07:52:09.000 UTC [101] ERROR:  could not write to file",
    ),
    { signalKind: "structured_error", matchReason: "error severity" },
  );
  assert.deepEqual(
    classifyErrorEvent(
      { severity: "error", error_type: "ResolverFailure" },
      "Not Found: /api/widgets/42",
    ),
    { signalKind: "structured_error", matchReason: "error_type is present" },
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

test("Grafana rule narrowly excludes verified benign events", async () => {
  const rule = JSON.parse(await readFile(
    new URL("../grafana/alerting/application-error-rule.json", import.meta.url),
    "utf8",
  ));
  const expression = rule.data.find(({ refId }) => refId === "A").model.expr;
  const django404Exclusion = "Not Found: /[^[:space:]]*$";
  const postgresLogExclusion = "UTC \\[[0-9]+\\] LOG:[[:space:]]";
  const djangoUnauthorizedExclusion = "Unauthorized: /[^[:space:]]*$";
  const exporterExclusion = "Failed to export span batch code:";
  const gunicornInfoExclusion = "\\[INFO\\][[:space:]]+";
  const sentryLifecycleExclusion = "Sentry is attempting to send [1-9][0-9]* pending events$";
  const serverActionDocsExclusion = "Read more: https://nextjs.org/docs/messages/failed-to-find-server-action$";
  const invalidServerActionExclusion = "Error: The Server Reference ID did not match the expected format\\. Received";
  const syntheticVerificationExclusion = "MobileCoverageVerification_[0-9_]+$";

  assert.equal(expression.split(django404Exclusion).length - 1, 3);
  assert.equal(expression.split(postgresLogExclusion).length - 1, 3);
  assert.equal(expression.split(djangoUnauthorizedExclusion).length - 1, 3);
  assert.equal(expression.split(exporterExclusion).length - 1, 3);
  assert.equal(expression.split(gunicornInfoExclusion).length - 1, 3);
  assert.equal(expression.split(sentryLifecycleExclusion).length - 1, 3);
  assert.equal(expression.split(serverActionDocsExclusion).length - 1, 3);
  assert.equal(expression.split(invalidServerActionExclusion).length - 1, 8);
  assert.equal(expression.split(syntheticVerificationExclusion).length - 1, 8);
  assert.match(expression, /\| error_type =~ "\.\+"/);
  assert.match(expression, /\| exception =~ "\.\+"/);
  assert.doesNotMatch(expression, /\| (error_type|exception|analysis_failure) != ""/);
  assert.match(expression, /traceback/);
});

test("Grafana routes downgraded signals to dedicated warning rules", async () => {
  const telemetryRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/telemetry-export-failure-rule.json", import.meta.url),
    "utf8",
  ));
  const unauthorizedRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/django-unauthorized-rate-rule.json", import.meta.url),
    "utf8",
  ));

  assert.match(telemetryRule.data[0].model.expr, /\^Failed to export span batch code:/);
  assert.equal(telemetryRule.labels.severity, "warning");
  assert.ok(unauthorizedRule.data[0].model.expr.includes("^Unauthorized: /[^[:space:]]*$"));
  assert.equal(unauthorizedRule.data[2].model.conditions[0].evaluator.params[0], 10);
  assert.equal(unauthorizedRule.for, "5m");
  assert.equal(unauthorizedRule.labels.severity, "warning");
});

test("Grafana waits for a sustained application error burst", async () => {
  const rule = JSON.parse(await readFile(
    new URL("../grafana/alerting/application-error-rule.json", import.meta.url),
    "utf8",
  ));
  const expression = rule.data.find(({ refId }) => refId === "A").model.expr;
  const threshold = rule.data.find(({ refId }) => refId === "C")
    .model.conditions[0].evaluator.params[0];

  assert.match(expression, /\[10m\]/);
  assert.match(expression, /Client diagnostic reported/);
  assert.match(expression, /Transient error .*exporting span batch/);
  assert.equal(threshold, 4);
  assert.equal(rule.for, "5m");
  assert.equal(rule.labels.severity, "warning");
});

test("worker alerts ignore restarts and require sustained failure ratios", async () => {
  const staleRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/bookkeeping-worker-stale-rule.json", import.meta.url),
    "utf8",
  ));
  const failureRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/bookkeeping-worker-failure-rule.json", import.meta.url),
    "utf8",
  ));
  const staleExpression = staleRule.data.find(({ refId }) => refId === "A").model.expr;
  const failureExpression = failureRule.data.find(({ refId }) => refId === "A").model.expr;
  const failureThreshold = failureRule.data.find(({ refId }) => refId === "B")
    .model.conditions[0].evaluator.params[0];

  assert.match(staleExpression, /last_poll_started_timestamp_seconds.*> 0/s);
  assert.equal(staleRule.for, "2m");
  assert.match(failureExpression, /clamp_min/);
  assert.match(failureExpression, /\[15m\]/);
  assert.match(failureExpression, />= 100/);
  assert.equal(failureThreshold, 20);
  assert.equal(failureRule.for, "5m");
  assert.equal(failureRule.labels.severity, "warning");
});

test("Amul alerts page on stale success and warn on sustained failure ratio", async () => {
  const staleRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/amul-catalog-stale-rule.json", import.meta.url),
    "utf8",
  ));
  const failureRule = JSON.parse(await readFile(
    new URL("../grafana/alerting/amul-catalog-failure-rate-rule.json", import.meta.url),
    "utf8",
  ));

  assert.match(staleRule.data[0].model.expr, /last_successful_catalog_run_timestamp_seconds/);
  assert.equal(staleRule.data[1].model.conditions[0].evaluator.params[0], 600);
  assert.equal(staleRule.for, "5m");
  assert.equal(staleRule.labels.severity, "critical");
  assert.match(failureRule.data[0].model.expr, /catalog_requests_total/);
  assert.match(failureRule.data[0].model.expr, /clamp_min/);
  assert.match(failureRule.data[0].model.expr, />= 20/);
  assert.equal(failureRule.data[1].model.conditions[0].evaluator.params[0], 20);
  assert.equal(failureRule.for, "5m");
  assert.equal(failureRule.labels.severity, "warning");
});

test("notification policy batches by actionable labels", async () => {
  const policy = JSON.parse(await readFile(
    new URL("../grafana/alerting/notification-policy.json", import.meta.url),
    "utf8",
  ));

  assert.deepEqual(policy.group_by, [
    "grafana_folder",
    "alertname",
    "project",
    "project_name",
    "service_name",
    "environment",
    "environment_name",
    "severity",
    "signal_kind",
  ]);
  assert.equal(policy.group_wait, "2m");
  assert.equal(policy.group_interval, "10m");
  assert.equal(policy.repeat_interval, "12h");
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
                "Checkout failed",
              ]],
            }],
          },
        }),
      };
    },
  );
  assert.equal(eventName, "Checkout failed");
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
            values: [["1786470684228845716", "Checkout failed"]],
          }],
        },
      }),
    }),
  );
  assert.equal(enriched.alerts[0].annotations.event_name, "Checkout failed");
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
