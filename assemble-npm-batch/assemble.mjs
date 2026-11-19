import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBatch } from '../promote-npm/batch.mjs';
import { INSIDER, readInsiderArtifact } from '../promote-npm/engine.mjs';

export async function assemble(raw, {fetcher = fetch} = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 32 * 1024) throw Error('Invalid selection size');
  const selection = JSON.parse(raw);
  if (!selection || Object.keys(selection).some(k => !['batchId', 'packages'].includes(k)) ||
      !Array.isArray(selection.packages) || selection.packages.length > 100) throw Error('Invalid selection');
  const manifest = parseBatch(JSON.stringify({
    schema: 1, batchId: selection.batchId, sourceRegistry: INSIDER,
    packages: selection.packages.map(p => {
      if (!p || Object.keys(p).some(k => !['name', 'version', 'tag'].includes(k))) throw Error('Invalid package selection');
      return {...p, integrity: 'sha512-' + Buffer.alloc(64).toString('base64')};
    })
  }));
  const temp = await mkdtemp(join(tmpdir(), 'assemble-insider-'));
  try {
    for (const [index, p] of manifest.packages.entries()) {
      const {hash} = await readInsiderArtifact({
        packageName: p.name, version: p.version, targetTag: p.tag, directory: join(temp, String(index)), fetcher
      });
      p.integrity = hash;
    }
    return parseBatch(JSON.stringify(manifest));
  } finally {
    await rm(temp, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const manifest = await assemble(process.env.ACTION_SELECTION);
    await appendFile(process.env.GITHUB_OUTPUT, 'batch=' + JSON.stringify(manifest) + '\n');
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      'Assembled from exact Insider downloads. Independent producer history was not verified.\n');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
