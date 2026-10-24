import { asActor } from '../src/platform/auth/actor.js';
import { createPart } from '../src/modules/parts/service.js';
import { createLocation } from '../src/modules/inventory/service.js';
import { setTracking } from '../src/modules/inventory/lot-service.js';
import { listStorageGroups, setChemicalPart } from '../src/modules/chemicals/service.js';
import type { World } from './fixtures.js';

export const daysFrom = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Two storerooms at A and one at B, an acid, a base, a solvent and an oxidizer (lot tracked, marked as chemicals), and an ordinary part. */
export async function chemicalWorld(w: World) {
  const as = <T>(fn: (tx: any) => Promise<T>) => asActor(w.admin, fn);
  const store = await as((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-CHEM1', name: 'Chemical store 1' }));
  const store2 = await as((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.A!, code: 'A-CHEM2', name: 'Chemical store 2' }));
  const storeB = await as((tx) => createLocation(tx, w.admin, { facilityId: w.facilities.B!, code: 'B-CHEM1', name: 'Chemical store B' }));
  const groups = await as((tx) => listStorageGroups(tx, w.admin));
  const g = (code: string) => groups.groups.find((x: any) => x.code === code)!.id as string;
  const part = async (partNumber: string, description: string, uom: string, attrs: any) => {
    const p = await as((tx) => createPart(tx, w.admin, { partNumber, description, uom, unitCost: 5 }));
    await as((tx) => setTracking(tx, w.admin, p.id, { tracking: 'lot' }));
    if (attrs) await as((tx) => setChemicalPart(tx, w.admin, p.id, { isChemical: true, ...attrs }));
    return p;
  };
  const acid = await part('HCL-37', 'Hydrochloric acid 37%', 'L', { hazardClasses: ['corrosive'], signalWord: 'danger', casNumber: '7647-01-0', storageGroupId: g('ACID'), inUseDays: 30 });
  const base = await part('NAOH-50', 'Sodium hydroxide 50%', 'L', { hazardClasses: ['corrosive'], signalWord: 'danger', casNumber: '1310-73-2', storageGroupId: g('BASE'), inUseDays: 90 });
  const solvent = await part('IPA-99', 'Isopropanol 99%', 'L', { hazardClasses: ['flammable', 'health_hazard'], signalWord: 'danger', casNumber: '67-63-0', storageGroupId: g('FLAM'), inUseDays: 60 });
  const oxidizer = await part('H2O2-30', 'Hydrogen peroxide 30%', 'L', { hazardClasses: ['oxidizer'], signalWord: 'danger', casNumber: '7722-84-1', storageGroupId: g('OXID'), inUseDays: 30 });
  const plain = await as((tx) => createPart(tx, w.admin, { partNumber: 'RAG-9', description: 'Wipes', uom: 'EA' }));
  return { store, store2, storeB, g, acid, base, solvent, oxidizer, plain, part };
}
