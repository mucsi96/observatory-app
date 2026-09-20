import { cleanupDbRecords, waitForSnapshot } from './utils';
export default async function globalSetup() {
  const response = await fetch('http://localhost:8170/api/environment');
  if (!response.ok)
    throw new Error('Start the test pod with scripts/pod_up.sh first');
  await cleanupDbRecords();
  await waitForSnapshot();
}
