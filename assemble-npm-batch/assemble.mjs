import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseBatch } from '../promote-npm/batch.mjs';
import { INSIDER, readInsiderMetadata } from '../promote-npm/engine.mjs';

export async function assemble(raw, {fetcher = fetch} = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024) throw Error('Invalid selection size');
  const selection = JSON.parse(raw);
  if (!selection || Object.keys(selection).some(k => !['batchId', 'packages'].includes(k)) ||
      !Array.isArray(selection.packages) || selection.packages.length > 100) throw Error('Invalid selection');
  const manifest = {
    schema: 1, batchId: selection.batchId ?? (process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}` : "promotion"), sourceRegistry: INSIDER,
    packages: selection.packages.map(p => {
      if (!p || Object.keys(p).some(k => !['name', 'version', 'tag'].includes(k))) throw Error('Invalid package selection');
      return {...p, tag: p.tag ?? "latest", integrity: 'sha512-' + Buffer.alloc(64).toString('base64')};
    })
  };
  parseBatch(JSON.stringify(manifest));
  for (const p of manifest.packages) {
    const {expectedIntegrity} = await readInsiderMetadata({
      packageName: p.name, version: p.version, targetTag: p.tag, fetcher
    });
    p.integrity = expectedIntegrity;
  }
  return parseBatch(JSON.stringify(manifest));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = await assemble(process.env.ACTION_SELECTION);
    await appendFile(process.env.GITHUB_OUTPUT, 'batch=' + JSON.stringify(manifest) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      'Resolved expected SHA-512 from exact Insider version metadata. No tarballs downloaded.\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
