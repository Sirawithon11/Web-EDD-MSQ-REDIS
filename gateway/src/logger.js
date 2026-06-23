// Structured logging via pino.
//
// We emit ONE JSON object per line to stdout (NDJSON). That is exactly what the
// ELK pipeline in ./elk wants: Filebeat tails the container stdout and ships the
// JSON straight to Logstash/Elasticsearch with the fields already parsed — no
// brittle grok regex over free-text "[realtime] ..." strings.
//
// Env:
//   LOG_LEVEL  - pino level (trace|debug|info|warn|error|fatal). Default "info".
//   LOG_PRETTY - set to "1" for human-readable colored output in local dev.
//   SERVICE_NAME - overrides the `service` field stamped on every line.
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: process.env.SERVICE_NAME || "gateway" },
  ...(process.env.LOG_PRETTY === "1"
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
    : {}),
});

module.exports = logger;
