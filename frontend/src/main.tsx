import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mucsi96/react-ui/styles.css';
import './styles.css';
import { FleetDashboard } from './features/fleet/FleetDashboard';
import { initializeFaro } from '@grafana/faro-web-sdk';
import type { RuntimeConfig } from './runtime-config';

const config: RuntimeConfig | undefined = window.__APP_CONFIG__;
if (
  !config ||
  typeof config.clientLogUrl !== 'string' ||
  typeof config.clientAppName !== 'string'
) {
  throw new Error('Missing frontend runtime configuration in index.html');
}
initializeFaro({
  url: config.clientLogUrl,
  app: { name: config.clientAppName, version: '1.0.0' },
  consoleInstrumentation: { disabledLevels: [] },
});

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FleetDashboard />
    </QueryClientProvider>
  </StrictMode>,
);
