import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mucsi96/react-ui/styles.css';
import './styles.css';
import { FleetDashboard } from './features/fleet/FleetDashboard';
import { initializeFaro } from '@grafana/faro-web-sdk';
// Public telemetry settings are compiled into the bundle, independent of hosting.
initializeFaro({
  url: new URL('/_telemetry/collect', window.location.origin).href,
  app: { name: 'observatory-client', version: '1.0.0' },
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
