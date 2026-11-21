import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validatePackageName, validateVersion, PUBLIC } from '../promote-npm/engine.mjs';

const metadataLimit = 1024 * 1024;
const tarballLimit = 256 * 1024 * 1024;

async function readBody(response, maxBytes, consume) {
  if (!response.body) throw Error('Public npm returned no response body');
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw Error('Public npm response exceeded the verification size limit');
    consume(chunk);
  }
}

export async function checkPublic({ name, version, integrity, verifyTarball = false, fetcher = fetch }) {
  validatePackageName(name);
  validateVersion(version);
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/u.test(integrity ?? '')) throw Error('Expected SHA-512 integrity');
  const url = new URL(encodeURIComponent(name) + '/' + encodeURIComponent(version), PUBLIC);
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 404) return 'not_visible';
  if (!response.ok) throw Error('Public npm query failed: HTTP ' + response.status);
  let metadata;
  if (verifyTarball) {
    const chunks = [];
    await readBody(response, metadataLimit, chunk => chunks.push(chunk));
    try { metadata = JSON.parse(Buffer.concat(chunks)); }
    catch { throw Error('Public npm returned invalid package metadata'); }
  } else {
    metadata = await response.json();
  }
  if (metadata?.name !== name || metadata.version !== version || metadata.dist?.integrity !== integrity) return 'mismatch';
  if (verifyTarball) {
    // Derive the exact npm tarball URL; metadata can confirm it, never point
    // us to a different artifact or origin.
    const basename = name.split('/').at(-1);
    const tarball = new URL(name + '/-/' + basename + '-' + version + '.tgz', PUBLIC);
    if (metadata.dist.tarball !== tarball.href) return 'mismatch';
    const archive = await fetcher(tarball, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (archive.status !== 200) throw Error('Public npm tarball query failed: HTTP ' + archive.status);
    const digest = createHash('sha512');
    await readBody(archive, tarballLimit, chunk => digest.update(chunk));
    if ('sha512-' + digest.digest('base64') !== integrity) return 'mismatch';
  }
  return 'visible_match';
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const verify = process.env.ACTION_VERIFY_TARBALL || 'false';
    if (verify !== 'true' && verify !== 'false') throw Error('verify-tarball must be true or false');
    const result = await checkPublic({ verifyTarball: verify === 'true', name: process.env.ACTION_PACKAGE, version: process.env.ACTION_VERSION, integrity: process.env.ACTION_INTEGRITY });
    await appendFile(process.env.GITHUB_OUTPUT, 'status=' + result + '\n');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
