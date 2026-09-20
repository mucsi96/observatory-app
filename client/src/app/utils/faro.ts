import { faro, initializeFaro, LogLevel } from '@grafana/faro-web-sdk';

const sends = new Set<Promise<unknown>>();
export function initFaro(url: string, name: string): void {
  if (!url) return;
  initializeFaro({
    url,
    app: { name },
    consoleInstrumentation: { disabledLevels: [] },
  });
  faro.transports.transports.forEach((transport) => {
    const send = transport.send.bind(transport);
    transport.send = (items) => {
      const result = send(items);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        const promise = result as Promise<unknown>;
        sends.add(promise);
        void promise.then(
          () => sends.delete(promise),
          () => sends.delete(promise)
        );
      }
      return result;
    };
  });
}
export async function flushFaro(): Promise<void> {
  if (!faro) return;
  faro.api.pushLog(['[auth] redirect'], { level: LogLevel.INFO });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await Promise.race([
    Promise.allSettled([...sends]),
    new Promise((resolve) => setTimeout(resolve, 1200)),
  ]);
}
