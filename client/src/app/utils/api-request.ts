export function isApiRequest(value: string): boolean {
  const url = new URL(value, window.location.origin);
  return (
    url.origin === window.location.origin && url.pathname.startsWith('/api/')
  );
}
