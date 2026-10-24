import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function prepareClient(directory, destination, assetBaseUrl, config) {
  const root = resolve(directory);
  const index = await readFile(join(root, 'index.html'), 'utf8');
  if (!index.includes('"__APP_CONFIG_JSON__"')) throw new Error('Missing runtime config marker');
  for (const entry of await readdir(root, { recursive: true })) {
    if ((await lstat(join(root, entry))).isSymbolicLink())
      throw new Error(`Unexpected symlink: ${entry}`);
  }
  const assets = join(destination, 'assets');
  const documents = join(destination, 'documents');
  await mkdir(documents, { recursive: true });
  await cp(root, assets, { recursive: true });
  const html = index.replace(/<(script|link)\b[^>]*>/gi, (tag) => {
    const attribute = /^<script\b/i.test(tag) ? 'src' : 'href';
    const pattern = new RegExp(`\\b${attribute}=(['"])(.*?)\\1`, 'i');
    if (!pattern.test(tag)) return tag;
    const rewritten = tag
      .replace(pattern, (_, quote, path) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path))
          throw new Error(`Build assets must be local: ${path}`);
        const url = new URL(path.replace(/^\/+/, ''), assetBaseUrl).href;
        return `${attribute}="${url.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"`;
      })
      .replace(/\s+crossorigin(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?/gi, '');
    return rewritten.replace(/\s*\/?>(?=$)/, ' crossorigin="anonymous">');
  });
  await rename(join(assets, 'index.html'), join(documents, 'index.html'));
  await writeFile(join(documents, 'index.html'), html);
  // Match Helm's sorted JSON serialization for the public bootstrap script.
  const sorted = Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
  const hash = createHash('sha256')
    .update(`window.__APP_CONFIG__ = ${JSON.stringify(sorted)};`)
    .digest('base64');
  const origin = new URL(assetBaseUrl).origin;
  const headers = {
    'Content-Security-Policy': `default-src 'self'; script-src 'self' ${origin} 'sha256-${hash}'; style-src 'self' ${origin} 'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o=' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; style-src-attr 'unsafe-hashes' 'sha256-3oFxofzq3N//6J8H86e9ul4WT2OkJrtonB66gn/TLJw='; font-src 'self' ${origin}; img-src 'self' ${origin} data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  await writeFile(join(destination, 'headers.json'), JSON.stringify(headers));
  return headers;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 6)
    throw new Error('Usage: static-client.mjs <build> <output> <assets-url> <runtime-config-json>');
  await prepareClient(...process.argv.slice(2, 5), JSON.parse(process.argv[5]));
}
