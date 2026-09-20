import { InjectionToken, makeEnvironmentProviders } from '@angular/core';
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';
import { EnvironmentConfig } from './environment/environment.config';

export const USER_MANAGER = new InjectionToken<UserManager>('USER_MANAGER');

export function provideOidcAuth(config: EnvironmentConfig) {
  return makeEnvironmentProviders([
    {
      provide: USER_MANAGER,
      useFactory: () =>
        new UserManager({
          authority: config.mockOAuth2ServerUri
            ? `${config.mockOAuth2ServerUri}/default`
            : `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
          client_id: config.mockOAuth2ServerUri
            ? 'mock-client-id'
            : config.clientId,
          scope: config.mockOAuth2ServerUri
            ? 'openid profile'
            : `openid profile offline_access ${config.apiClientId}/api-access`,
          redirect_uri: window.location.origin,
          post_logout_redirect_uri: window.location.origin,
          response_type: 'code',
          automaticSilentRenew: false,
          monitorSession: false,
          loadUserInfo: false,
          userStore: new WebStorageStateStore({ store: localStorage }),
          stateStore: new WebStorageStateStore({ store: localStorage }),
        }),
    },
  ]);
}
