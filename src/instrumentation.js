const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { Resource } = require('@opentelemetry/resources');
const { SEMRESATTRS_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
const otlpHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS ?
  Object.fromEntries(
    process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map(h => {
      const [key, value] = h.split('=');
      return [key.trim(), value.trim()];
    })
  ) : {};

const sdk = new NodeSDK({
  resource: new Resource({ [SEMRESATTRS_SERVICE_NAME]: 'chaos-controller', 'service.language': 'nodejs' }),
  traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces`, headers: otlpHeaders }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
process.on('SIGTERM', () => sdk.shutdown().then(() => process.exit(0)));
