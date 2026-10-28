import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    {
      name: 'local-runtime-config',
      apply: 'serve',
      transformIndexHtml: (html) =>
        html.replace(
          '"__APP_CONFIG_JSON__"',
          JSON.stringify({
            clientAppName: 'observatory-client',
            clientLogUrl: '/_telemetry/collect',
          }),
        ),
    },
  ],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8080',
      '/healthz': 'http://127.0.0.1:8080',
      '/_telemetry': 'http://127.0.0.1:8080',
    },
  },
});
