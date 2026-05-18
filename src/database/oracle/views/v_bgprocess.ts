/**
 * V$BGPROCESS — directory of every known background process.
 *
 * Catalogue + status. The catalogue is the union of process names that
 * a 19c instance can start (we include the common ones); the STATUS
 * column is set from the live background processes maintained by
 * OracleInstance, which are driven by
 * `oracle.instance.background-process-started/stopped` events.
 */

import { col } from './_columns';
import { queryResult } from '../../engine/executor/ResultSet';
import { registerView } from './registry';

const CATALOGUE = [
  'PMON', 'SMON', 'DBW0', 'LGWR', 'CKPT', 'RECO', 'MMON', 'MMNL',
  'ARC0', 'ARC1', 'ARC2', 'ARC3', 'DIA0', 'DIAG', 'PSP0', 'VKTM',
  'GEN0', 'MMAN', 'CJQ0', 'QMNC', 'RVWR', 'LREG', 'W000', 'W001',
];

registerView({
  name: 'V$BGPROCESS',
  comment: 'Catalogue of background processes',
  query({ instance }) {
    const live = new Map<string, number>();
    for (const p of instance.getBackgroundProcesses()) live.set(p.name, p.pid);
    const known = new Set<string>([...CATALOGUE, ...live.keys()]);
    return queryResult(
      [
        col.num('PADDR'),
        col.num('PSERIAL#'),
        col.str('NAME', 5),
        col.str('DESCRIPTION', 64),
        col.str('ERROR', 1),
      ],
      [...known].map(name => {
        const pid = live.get(name);
        return [pid ?? 0, pid ?? 0, name, descriptionFor(name), pid ? 'Y' : 'N'];
      })
    );
  },
});

function descriptionFor(name: string): string {
  const desc: Record<string, string> = {
    PMON: 'Process Monitor',
    SMON: 'System Monitor',
    DBW0: 'Database Writer 0',
    LGWR: 'Log Writer',
    CKPT: 'Checkpoint',
    RECO: 'Recovery',
    MMON: 'Manageability Monitor',
    MMNL: 'Manageability Monitor Light',
    ARC0: 'Archiver 0',
    ARC1: 'Archiver 1',
    ARC2: 'Archiver 2',
    ARC3: 'Archiver 3',
    DIA0: 'Diagnostic 0',
    DIAG: 'Diagnostic',
    PSP0: 'Process Spawner',
    VKTM: 'Virtual Keeper of Time',
    GEN0: 'Generic Task Process',
    MMAN: 'Memory Manager',
    CJQ0: 'Job Coordinator',
    QMNC: 'AQ Coordinator',
    RVWR: 'Recovery Writer',
    LREG: 'Listener Registration',
    W000: 'Space Management Worker',
    W001: 'Space Management Worker',
  };
  return desc[name] ?? '';
}
