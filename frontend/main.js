import { initializeFaro } from '@grafana/faro-web-sdk';
import { snapshotSchema } from './src/features/fleet/schema';
import './web/style.css';
import './web/dark.css';
import './web/backports.css';

initializeFaro({
  url: new URL('/_telemetry/collect', window.location.origin).href,
  app: { name: 'observatory-client', version: '1.0.0' },
  consoleInstrumentation: { disabledLevels: [] },
});
globalThis.validateSnapshot = (value) => snapshotSchema.parse(value);
await import('./web/app.js');
