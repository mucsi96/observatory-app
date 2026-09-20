import {
  ApplicationConfig,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MAT_RIPPLE_GLOBAL_OPTIONS } from '@angular/material/core';
import { provideAngularMaterialTheme } from '@mucsi96/angular-material-theme';
import {
  EnvironmentConfig,
  ENVIRONMENT_CONFIG,
} from './environment/environment.config';
import { provideOidcAuth } from './auth.config';
import { AuthService } from './auth.service';
import { routes } from './app.routes';
import { errorInterceptor } from './utils/error.interceptor';
import { authRetryInterceptor } from './utils/auth-retry.interceptor';
import { tokenInterceptor } from './utils/token.interceptor';

export function getAppConfig(
  environment: EnvironmentConfig
): ApplicationConfig {
  return {
    providers: [
      provideZoneChangeDetection({ eventCoalescing: true }),
      provideRouter(routes),
      provideHttpClient(
        withInterceptors([
          errorInterceptor,
          authRetryInterceptor,
          tokenInterceptor,
        ])
      ),
      provideAnimationsAsync(),
      provideAngularMaterialTheme(),
      { provide: MAT_RIPPLE_GLOBAL_OPTIONS, useValue: { disabled: true } },
      { provide: ENVIRONMENT_CONFIG, useValue: environment },
      provideOidcAuth(environment),
      provideAppInitializer(() => inject(AuthService).init()),
    ],
  };
}
