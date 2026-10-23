export interface RuntimeConfig {
  clientLogUrl: string;
  clientAppName: string;
}

declare global {
  interface Window {
    __APP_CONFIG__?: RuntimeConfig;
  }
}
