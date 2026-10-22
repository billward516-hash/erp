import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Actor } from '../src/platform/auth/actor.js';
import { commitImport, saveProfile, stageImport } from '../src/modules/imports/service.js';

export const SAMPLES = path.resolve('samples');
export const log = (...a: unknown[]) => console.log(...a);

/** Loads a sample file the way a customer would: staged through the import pipeline (with a saved profile when given), then committed. */
export async function runImport(actor: Actor, opts: { file: string; target: string; sourceSystem: string; facilityId?: string; profile?: string; allowPartial?: boolean }) {
  const content = await readFile(path.join(SAMPLES, 'imports', opts.file));
  let profileId: string | undefined;
  if (opts.profile) {
    const p = JSON.parse(await readFile(path.join(SAMPLES, 'imports', opts.profile), 'utf8'));
    profileId = (await saveProfile(actor, { name: p.name, target: p.target, sourceSystem: p.sourceSystem, mapping: p.mapping })).id;
  }
  const staged = await stageImport(actor, { target: opts.target, sourceSystem: opts.sourceSystem, fileName: path.basename(opts.file), content, facilityId: opts.facilityId ?? null, profileId });
  const s = staged.stats;
  log(`  ${path.basename(opts.file)} → ${opts.target} [${profileId ? 'saved profile' : 'auto-mapped'}]: ${s.total} rows, ${s.valid} valid, ${s.warnings} with warnings, ${s.errors} errors`);
  for (const w of staged.warnings) log(`      note: ${w}`);
  for (const r of staged.preview.filter((r: any) => r.messages.length)) {
    log(`      row ${r.rowNumber}${r.sourceColumn ? ` [${r.sourceColumn}]` : ''} ${r.status === 'error' ? 'ERROR' : 'warning'}: ${r.messages.map((m: any) => m.message).join('; ')}`);
  }
  const committed = await commitImport(actor, staged.batchId, { allowPartial: opts.allowPartial });
  log(`      committed: ${committed.stats.created} created, ${committed.stats.updated} updated, ${committed.stats.failed} not imported`);
  return staged.batchId;
}

/** Like runImport, for a file produced at seed time (e.g. a log with recent dates) mapped with a sample profile. */
export async function runImportContent(actor: Actor, opts: { fileName: string; content: Buffer; target: string; sourceSystem: string; profile: string; allowPartial?: boolean }) {
  const p = JSON.parse(await readFile(path.join(SAMPLES, 'imports', opts.profile), 'utf8'));
  const profileId = (await saveProfile(actor, { name: p.name, target: p.target, sourceSystem: p.sourceSystem, mapping: p.mapping })).id;
  const staged = await stageImport(actor, { target: opts.target, sourceSystem: opts.sourceSystem, fileName: opts.fileName, content: opts.content, facilityId: null, profileId });
  const s = staged.stats;
  log(`  ${opts.fileName} → ${opts.target} [saved profile]: ${s.total} rows, ${s.valid} valid, ${s.warnings} with warnings, ${s.errors} errors`);
  const committed = await commitImport(actor, staged.batchId, { allowPartial: opts.allowPartial });
  log(`      committed: ${committed.stats.created} created, ${committed.stats.updated} updated, ${committed.stats.failed} not imported`);
}
