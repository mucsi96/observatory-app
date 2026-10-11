import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@mucsi96/react-ui/styles.css';
import './styles.css';
import { FleetDashboard } from './features/fleet/FleetDashboard';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <FleetDashboard />
    </QueryClientProvider>
  </StrictMode>,
);
