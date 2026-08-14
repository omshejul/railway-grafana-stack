# Grafana Stack on Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/8TLSQD?referralCode=IFlm92)

## Shared deployment

This repository backs the standalone Railway project named `Grafana`. It is a
shared observability service, not a component of PetTech. Applications identify
themselves with OpenTelemetry resource attributes and Prometheus labels such as
`project`, `environment`, and `service`.

The deployed components are pinned to these versions:

| Component | Version |
|---|---|
| Grafana | `13.1.3` |
| Loki | `3.7.6` |
| Prometheus | `v3.13.2` |
| Tempo | `2.9.4` |
| gcx | `1.0.0` |
| Locomotive | `sha256:7381f8c5dfd7004a5ffef0ef08f75c05955504e921ffdafef397a21cd49e66a0` |
| Resend relay Node runtime | `24.19.0-alpine3.24` |
| Slack relay Node runtime | `24.19.0-alpine3.24` |

Tempo is intentionally pinned to `2.9.4` because this template's configuration
is not compatible with newer Tempo releases without a configuration migration.

### CLI workflow

`gcx` is installed and authenticated with the context `grafana`. Common queries:

```sh
gcx logs query '{project_name="PetTech"}' --since 30m
gcx metrics query 'up{project="pettech"}'
gcx traces query '{ resource.service.name = "pettech-api" }' --since 30m
gcx alert rules list
gcx alert contact-points list
```

The default alert policy routes to the contact point named `Grafana`. The
private webhook relay converts Grafana's payload to Slack Block Kit and calls
Slack `chat.postMessage`. It also sends a Sentry-like HTML email from
`alerts@theom.app` through Resend's HTTPS API. The relay queries private Loki
for the latest matching error, then uses its trace ID to retrieve the exception
message and stack trace from Tempo. The separate SMTP-to-Resend relay remains
available as a fallback for Grafana's native email integration.
`LOKI_QUERY_URL` defaults to
`http://loki.railway.internal:3100/loki/api/v1/query_range` and
`TEMPO_QUERY_URL` defaults to
`http://tempo.railway.internal:3200/api/traces`. Both relays stay private inside
the shared Railway project.

Application errors are classified from explicit error severity, structured
exception fields, nonzero failure counters, or strong crash signatures. Do not
use a generic substring search for `error`: it incorrectly classifies fields
such as `unexpected_errors=0`. The version-controlled Grafana API payload is at
`grafana/alerting/application-error-rule.json`. Apply it with:

```sh
gcx --context grafana api /api/v1/provisioning/alert-rules/efuvaeei1l0qoc \
  -X PUT -d @grafana/alerting/application-error-rule.json
```

Known third-party logging defects may be excluded only after verifying the
exact source and adding a regression fixture. For example, MCP SDK session
cleanup currently writes `Terminating session: None` to stderr even though the
SDK records it at INFO.

Railway and Locomotive may derive severity from stdout versus stderr. Uvicorn
writes normal `INFO:` lifecycle messages to stderr, so explicit message level
overrides transport-derived severity. Django also writes ordinary
`Not Found: /path` 404 responses through `django.request`; these remain in Loki
but do not page as application errors. Keep exclusions narrow and
fixture-tested. Alert separately on sustained 404 rates when that signal matters.
PostgreSQL also emits routine server messages such as checkpoint activity to
stderr with its own embedded `LOG:` level. Railway's transport-derived error
label is ignored only for that anchored PostgreSQL `LOG:` format. Embedded
`ERROR:`, `FATAL:`, and `PANIC:` records remain alertable.

### Adding another project

1. Export application traces to the public Tempo OTLP HTTP `/v1/traces`
   endpoint and set `service.name`, `project`, and `environment` resource
   attributes.
2. Add the application's metrics endpoint to `prometheus/prom.yml`, including
   `project`, `environment`, and `service` labels.
3. Add its Railway service IDs to Locomotive's `TRAIN` value if Railway logs
   should be forwarded to Loki.
4. Query the new labels through `gcx` before creating dashboards or alerts.

### Bookkeeping metrics credential

The Railway `Prometheus` service requires `BOOKKEEPING_METRICS_PASSWORD`.
Its entrypoint writes that value to a mode `0400` credential file, unsets the
environment variable, and starts Prometheus. The Bookkeeping scrape jobs use
that file for HTTP basic authentication, so no credential is committed or
baked into the image.

Deploy this configuration only after the authenticated `/caddy` and `/worker`
routes are live at `metrics.bookkeeping.theom.app`. Verify both targets with:

```sh
gcx metrics query 'up{project="bookkeeping"}'
```

## What is this template

This template deploys a complete Grafana observability stack on Railway with just one click! The stack includes four integrated services:

- **Grafana**: The leading open-source analytics and monitoring solution
- **Loki**: A horizontally-scalable, highly-available log aggregation system
- **Prometheus**: A powerful metrics collection and alerting system
- **Tempo**: A high-scale distributed tracing backend

This template is perfect for teams who need a comprehensive observability solution for their railway project without the hassle of manual configuration and infrastructure management.

### Key Features

- **Pre-configured Integration**: _All services come pre-connected_, so Grafana is ready to query your data immediately.
- **Persistent Storage**: All four services use Railway volumes to ensure your data, dashboards, and configurations persist between updates and deploys.
- **Version Control**: Pin specific Docker image versions for each service using environment variables.
- **Customizable**: Fork the repository to customize configuration files for any service. You can take full control and edit anything you'd need to as you scale.
- **One-Click Deploy**: Get a complete Grafana-based observability stack running in minutes.

## Quick Start Guide

1. Click the "Deploy on Railway" button at the top of this page
2. Enter your desired Grafana admin username in the `GF_SECURITY_ADMIN_USER` variable
3. Leave all other variables at their defaults (or customize as needed)
4. Wait for your stack to deploy (this typically takes 3-5 minutes)
5. Navigate to the Grafana URL provided by Railway
6. Log in with your admin username and the auto-generated password found in the `GF_SECURITY_ADMIN_PASSWORD` environment variable
7. Hook up your applications to the datasources.
8. Create dashboards, alerts, and explore your data in Grafana!

## Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GF_SECURITY_ADMIN_USER` | Username for the Grafana admin account | Required input |
| `GF_SECURITY_ADMIN_PASSWORD` | Password for the Grafana admin account | Auto-generated secure string |
| `GF_DEFAULT_INSTANCE_NAME` | Name of your Grafana instance | `Grafana on Railway` |
| `GF_INSTALL_PLUGINS` | Comma-separated list of Grafana plugins to install | `grafana-simple-json-datasource,grafana-piechart-panel,grafana-worldmap-panel,grafana-clock-panel` |

### Internal Service URLs

The Grafana service exposes these environment variables that you can reference in your other Railway applications to easily send data to your observability stack:

| Variable | Description | Usage |
|----------|-------------|-------|
| `LOKI_INTERNAL_URL` | Internal URL for the Loki service | Use in your applications to send logs to and query Loki |
| `PROMETHEUS_INTERNAL_URL` | Internal URL for the Prometheus service | Use in your applications to send metrics to and query Prometheus |
| `TEMPO_INTERNAL_URL` | Internal URL for the Tempo service | Use in your applications to query Tempo |

These variables make it easy to configure your other Railway services to send telemetry data to your observability stack.

Tempo also exposes a few variables to make it easier to push tracing information to the service using either HTTP or GRPC

| Variable | Description | Usage |
|----------|-------------|-------|
| `INTERNAL_HTTP_INGEST` | Internal HTTP ingest server URL for Tempo | Use in your applications to send traces to tempo via HTTP |
| `INTERNAL_GRPC_INGEST` | Internal GRPC ingest server URL for Tempo | Use in your applications to send traces to tempo via GRPC |

### Version Control

Each service has its own `VERSION` environment variable that can be set independently in each service's settings in the Railway dashboard:

- **Grafana Service**: Set `VERSION` to control the Grafana Docker image tag
- **Loki Service**: Set `VERSION` to control the Loki Docker image tag
- **Prometheus Service**: Set `VERSION` to control the Prometheus Docker image tag
- **Tempo Service**: Set `VERSION` to control the Tempo Docker image tag

By default, all services use the `latest` tag, but you can pin specific versions for stability:

Examples:
- Grafana: `VERSION=11.5.2`
- Loki: `VERSION=3.4.2`
- Prometheus: `VERSION=v3.2.1`
- Tempo: `VERSION=2.9.0`

This allows you to update each component independently as needed.

> **⚠️ Note on Tempo v2.10.0**: There is a known issue with Tempo v2.10.0 where the `compactor` configuration block is not recognized, causing startup failures. This template is pinned to v2.9.0 until this issue is resolved in a future release.

## Project Structure & Services

This template deploys four interconnected services:

### Grafana
- The central visualization and dashboarding platform
- Pre-configured with connections to all other services
- Persistent volume for storing dashboards, users, and configurations
- Comes with useful plugins pre-installed
- Exposes internal URLs for other Railway services to connect to Loki, Prometheus, and Tempo

### Prometheus
- Time-series database for metrics collection
- Configured with sensible defaults for monitoring
- Persistent volume for metrics data

### Loki
- Log aggregation system designed to be cost-effective
- Horizontally scalable architecture
- Persistent volume for log storage

### Tempo
- Distributed tracing system for tracking requests across services
- High-performance trace storage
- Persistent volume for trace data

All services are deployed using official Docker images and configured to work together seamlessly.

## Connecting Your Applications

### Using [Locomotive](https://railway.com/template/jP9r-f) for Loki

You can easily ingest *all* of your railway logs into Loki from *any* service using [Locomotive](https://railway.com/template/jP9r-f). Just spin up their template, drop in your Railway API key, the ID of the services you want to monitor, and a link to your new Loki instance and logs will start flowing! no code changes needed anywhere!

### Using OpenTelemetry libraries for Tempo 

Tempo is a bit different than both Prometheus and Loki in that exposes separate GRPC and HTTP servers on ports `:4317` and `:4318` respectively specifically for ingesting your tracing data or "spans".

When configuring your application to send traces to Tempo, please use one of the preconfigured variables in the Tempo service: `INTERNAL_HTTP_INGEST` or `INTERNAL_GRPC_INGEST`.

Another thing to note is that the ingest API endpoint for the HTTP server is `/v1/traces`. For a working example of this in a node.js express API, see `/examples/api/tracer.js` in our GitHub repository.

### Using otherwise standard observability tooling

To send data from your other Railway applications to this observability stack:

1. In your application's Railway service, add environment variables that reference the internal URLs:
   ```
   LOKI_URL=${{Grafana.LOKI_INTERNAL_URL}}
   PROMETHEUS_URL=${{Grafana.PROMETHEUS_INTERNAL_URL}}
   TEMPO_URL=${{Grafana.TEMPO_INTERNAL_URL}}
   ```
2. Configure your application's logging, metrics, or tracing libraries to use these URLs
3. Your application data will automatically appear in your Grafana dashboards

## Customizing Your Stack

To customize the configuration of Loki, Prometheus, or Tempo:

1. Fork the [GitHub repository](https://github.com/yourusername/grafana-railway-template)
2. Modify the configuration files in their respective directories
3. In Railway, disconnect the service you want to customize
4. Reconnect the service to your forked repository
5. Deploy the updated service

The pre-configured Grafana connections will continue to work with your customized services.

## Additional Resources

- [Locomotive: a loki transport for railway services](https://railway.com/template/jP9r-f)
- [Grafana Documentation](https://grafana.com/docs/grafana/latest/)
- [Loki Documentation](https://grafana.com/docs/loki/latest/)
- [Prometheus Documentation](https://prometheus.io/docs/introduction/overview/)
- [Tempo Documentation](https://grafana.com/docs/tempo/latest/)
- [Grafana Community Forums](https://community.grafana.com/)
- [Grafana Plugins Directory](https://grafana.com/grafana/plugins/)

---

Developed and maintained by [Mykal](https://mykal.codes). For issues or suggestions, please open an issue on the [GitHub repository](https://github.com/MykalMachon/grafana-stack-railway).
