import { bootstrapApplication } from '@angular/platform-browser';
import { AppComponent } from './app/app.component';
import { getAppConfig } from './app/app.config';
import { EnvironmentConfig } from './app/environment/environment.config';
import { initFaro } from './app/utils/faro';

async function bootstrap(): Promise<void> {
  const response = await fetch('/api/environment');
  if (!response.ok)
    throw new Error(`Failed to load configuration: ${response.status}`);
  const environment: EnvironmentConfig = await response.json();
  initFaro(environment.clientLogUrl, environment.clientAppName);
  await bootstrapApplication(AppComponent, getAppConfig(environment));
}

bootstrap().catch((error) => {
  console.error('Application startup failed', error);
  const root = document.querySelector('app-root');
  if (root)
    root.textContent = 'Observatory could not start. Reload the page to retry.';
});
