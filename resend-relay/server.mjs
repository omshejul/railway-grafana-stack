import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";

const apiKey = process.env.RESEND_API_KEY;
const port = Number(process.env.PORT ?? "2525");

if (!apiKey) throw new Error("RESEND_API_KEY is required");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT is invalid");

function addresses(field) {
  return field?.value.map(({ address }) => address).filter(Boolean) ?? [];
}

const server = new SMTPServer({
  authOptional: true,
  disabledCommands: ["AUTH", "STARTTLS"],
  logger: false,
  onData(stream, _session, done) {
    void (async () => {
      try {
        const message = await simpleParser(stream);
        const from = message.from?.text;
        const to = addresses(message.to);
        if (!from || to.length === 0) throw new Error("Message requires a sender and recipient");

        const payload = {
          from,
          to,
          cc: addresses(message.cc),
          bcc: addresses(message.bcc),
          subject: message.subject ?? "Grafana alert",
          text: message.text,
          html: typeof message.html === "string" ? message.html : undefined,
          attachments: message.attachments.map((attachment) => ({
            filename: attachment.filename ?? "attachment",
            content: attachment.content.toString("base64"),
            content_type: attachment.contentType,
          })),
        };

        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Resend returned ${response.status}: ${detail.slice(0, 500)}`);
        }

        const result = await response.json();
        console.log(JSON.stringify({ level: "info", message: "email sent", resend_id: result.id }));
        done();
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          message: "email delivery failed",
          error: error instanceof Error ? error.message : String(error),
        }));
        done(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  },
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ level: "info", message: "SMTP relay ready", port }));
});
