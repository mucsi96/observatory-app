import { test as base } from '@playwright/test';
import { cleanupDbRecords, waitForSnapshot } from './utils';

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const reset = await fetch('http://localhost:3071/reset', {
      method: 'POST',
    });
    if (!reset.ok) throw new Error('Mock upstream reset failed');
    await cleanupDbRecords();
    await waitForSnapshot();
    const logs: string[] = [];
    page.on('console', (message) =>
      logs.push(`[${message.type()}] ${message.text()}`)
    );
    page.on('pageerror', (error) => logs.push(`[PAGE_ERROR] ${error.stack}`));
    await use(page);
    if (testInfo.status !== testInfo.expectedStatus)
      await testInfo.attach('console-logs', {
        body: logs.join('\n'),
        contentType: 'text/plain',
      });
  },
});
export { expect } from '@playwright/test';
