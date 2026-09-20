import { Pool } from 'pg';
const pool = new Pool({
  host: 'localhost',
  port: 5471,
  database: 'test',
  user: 'postgres',
  password: 'postgres',
  allowExitOnIdle: true,
});
export const query = (text: string, params?: unknown[]) =>
  pool.query(text, params);
export const cleanupDbRecords = () =>
  query('DELETE FROM observatory.snapshots WHERE environment = $1', ['test']);
export async function waitForSnapshot(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const { rows } = await query(
      'SELECT apps FROM observatory.snapshots WHERE environment = $1',
      ['test']
    );
    if (rows[0]?.apps?.length === 3) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Collector did not persist a snapshot');
}
