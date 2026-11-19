import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePackageName, validateVersion, PUBLIC } from '../promote-npm/engine.mjs';

export async function checkPublic({ name, version, integrity, fetcher = fetch }) {
  validatePackageName(name);
  validateVersion(version);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity ?? '')) throw Error('Expected SHA-512 integrity');
  const url = new URL(encodeURIComponent(name) + '/' + encodeURIComponent(version), PUBLIC);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return 'not_visible';
  if (!response.ok) throw Error('Public npm query failed: HTTP ' + response.status);
  const metadata = await response.json();
  if (metadata.name !== name || metadata.version !== version || metadata.dist?.integrity !== integrity) return 'mismatch';
  return 'visible_match';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await checkPublic({ name: process.env.ACTION_PACKAGE, version: process.env.ACTION_VERSION, integrity: process.env.ACTION_INTEGRITY });
    await appendFile(process.env.GITHUB_OUTPUT, 'status=' + result + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
