import { InjectionToken } from '@angular/core';

export interface EnvironmentConfig {
  tenantId: string;
  clientId: string;
  apiClientId: string;
  mockOAuth2ServerUri: string;
  clientLogUrl: string;
  clientAppName: string;
}
export const ENVIRONMENT_CONFIG = new InjectionToken<EnvironmentConfig>(
  'ENVIRONMENT_CONFIG'
);
