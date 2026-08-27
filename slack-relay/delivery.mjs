import { shouldSendEmail } from "./email.mjs";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function notificationKey(payload) {
  const status = String(payload?.status ?? "firing").toLowerCase();
  const alerts = Array.isArray(payload?.alerts) ? payload.alerts : [];
  const identities = alerts.map((alert) => [
    alert?.fingerprint ?? "",
    alert?.startsAt ?? "",
    alert?.labels?.alertname ?? "",
  ].join(":"));
  return `${status}:${identities.sort().join("|")}`;
}

export function createDeliveryTracker({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const delivered = new Map();

  function prune() {
    const current = now();
    for (const [key, expiresAt] of delivered) {
      if (expiresAt <= current) delivered.delete(key);
    }
  }

  return {
    has(destination, payload) {
      prune();
      return delivered.has(`${destination}:${notificationKey(payload)}`);
    },
    mark(destination, payload) {
      prune();
      delivered.set(`${destination}:${notificationKey(payload)}`, now() + ttlMs);
    },
  };
}

export async function deliverNotification(payload, options) {
  const {
    tracker,
    slackMessage,
    emailMessage,
    sendSlack,
    sendEmail,
  } = options;
  const jobs = [];

  if (!tracker.has("slack", payload)) {
    jobs.push({
      destination: "slack",
      run: sendSlack,
      message: slackMessage,
    });
  }
  if (emailMessage && shouldSendEmail(payload) && !tracker.has("email", payload)) {
    jobs.push({
      destination: "email",
      run: sendEmail,
      message: emailMessage,
    });
  }

  const results = await Promise.allSettled(jobs.map(({ run, message }) => run(message)));
  const response = {};
  const failures = [];

  results.forEach((result, index) => {
    const { destination } = jobs[index];
    if (result.status === "fulfilled") {
      tracker.mark(destination, payload);
      response[destination] = result.value;
    } else {
      failures.push(result.reason);
    }
  });

  if (failures.length > 0) {
    throw new AggregateError(failures, failures.map((failure) => (
      failure instanceof Error ? failure.message : String(failure)
    )).join("; "));
  }
  return response;
}
