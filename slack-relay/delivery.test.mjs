import assert from "node:assert/strict";
import test from "node:test";

import { createDeliveryTracker, deliverNotification } from "./delivery.mjs";

const payload = {
  status: "firing",
  alerts: [{
    status: "firing",
    fingerprint: "alert-1",
    startsAt: "2026-08-27T10:00:00Z",
    labels: { severity: "critical" },
  }],
};

test("routes critical firing alerts to Slack and email", async () => {
  const calls = [];
  const result = await deliverNotification(payload, {
    tracker: createDeliveryTracker(),
    slackMessage: { channel: "C123" },
    emailMessage: { to: ["om@example.com"] },
    sendSlack: async () => { calls.push("slack"); return { channel: "C123", ts: "1" }; },
    sendEmail: async () => { calls.push("email"); return { id: "email-1" }; },
  });

  assert.deepEqual(calls.sort(), ["email", "slack"]);
  assert.equal(result.slack.ts, "1");
  assert.equal(result.email.id, "email-1");
});

test("routes noncritical and resolved alerts to Slack only", async () => {
  for (const candidate of [
    { ...payload, alerts: [{ ...payload.alerts[0], labels: { severity: "warning" } }] },
    { ...payload, status: "resolved" },
  ]) {
    const calls = [];
    await deliverNotification(candidate, {
      tracker: createDeliveryTracker(),
      slackMessage: { channel: "C123" },
      emailMessage: { to: ["om@example.com"] },
      sendSlack: async () => { calls.push("slack"); return { channel: "C123", ts: "1" }; },
      sendEmail: async () => { calls.push("email"); return { id: "email-1" }; },
    });
    assert.deepEqual(calls, ["slack"]);
  }
});

test("does not repost Slack when email delivery is retried", async () => {
  const tracker = createDeliveryTracker();
  let slackCalls = 0;
  let emailCalls = 0;
  const options = {
    tracker,
    slackMessage: { channel: "C123" },
    emailMessage: { to: ["om@example.com"] },
    sendSlack: async () => { slackCalls += 1; return { channel: "C123", ts: "1" }; },
    sendEmail: async () => {
      emailCalls += 1;
      if (emailCalls === 1) throw new Error("temporary email failure");
      return { id: "email-1" };
    },
  };

  await assert.rejects(deliverNotification(payload, options), /temporary email failure/);
  await deliverNotification(payload, options);

  assert.equal(slackCalls, 1);
  assert.equal(emailCalls, 2);
});
