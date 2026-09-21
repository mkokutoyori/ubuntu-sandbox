/**
 * SUITE DU LOT R7 — les six accesseurs qui lisaient encore l'objet du
 * pair (`docs/ASSESSMENT-RMAN.md`, et le message de commit de R7 qui les
 * nommait un par un).
 *
 * POURQUOI LE COMPTE DE TRAMES, ET PAS LE CONTENU. `forTarget` construit
 * le contexte SUR la machine cible, avec la base de la cible :
 * `getCurrentScn()` rendait DEJA le bon SCN — celui de DR. La VALEUR
 * etait juste ; c'est le MOYEN qui ne l'etait pas. Un temoin de contenu
 * ne distinguerait donc RIEN, et c'est exactement le piege que
 * CLAUDE.md §4 decrit : « une methode sur l'objet du pair, si correcte
 * que soit la reponse ». Seul le compte de trames tranche.
 *
 * MESURE AVANT (`src/__tests__/debug/rman/r7b-accesseurs-distants.debug.test.ts`),
 * chaque accesseur appele SEUL entre deux relevés du compteur :
 *
 *   getDatafiles                2 trames      <- ferme par R7
 *   getCurrentScn               0
 *   getInstanceState            0
 *   getSpfileParam(db_name)     0
 *   getControlFilePaths         0
 *   getArchivelogPaths          0
 *   getRecoveryAreaUsedBytes    0
 *   runSqlStatement  (TEMOIN)   2 trames      <- ferme par R7
 *
 * APRES : les sept a 2 trames, et les valeurs inchangees.
 *
 * Chaque accesseur pose sa question a LA VUE qui la porte — V$DATABASE,
 * V$INSTANCE, V$PARAMETER, V$CONTROLFILE, V$ARCHIVED_LOG,
 * V$RECOVERY_FILE_DEST — par un port unique, et non par six chemins qui
 * finiraient par se contredire.
 *
 * Discrimination : 6 cas sur 9 tombent sous `git stash push -- src/terminal`.
 * Les trois autres, et pourquoi ils passent des deux cotes :
 *
 *   - << getDatafiles pose sa question >> : il a ete ferme par le lot R7
 *     lui-meme, qui est COMMITTE — le remisage ne le retire donc pas.
 *     Non-regression : les six qui suivent partagent desormais son port,
 *     et ce cas garde que le premier n'a pas ete casse en route.
 *
 *   - << une cible LOCALE ne met RIEN sur le fil >> : c'est le
 *     contre-temoin, et il compte autant que les sept. Une connexion
 *     bequeath n'a pas de reseau a traverser ; router tout par le fil
 *     serait un defaut symetrique de celui qu'on ferme.
 *   - << les valeurs rendues sont celles de la CIBLE >> : elles
 *     l'etaient deja, par le raccourci. Non-regression : demander au
 *     lieu de lire ne doit pas changer la reponse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';
import { framesSentOn } from '../support/wireWatch';
import { LinuxRmanContext } from '@/terminal/subshells/rman/integration/LinuxRmanContext';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const DR_SANS_CREDENTIALS = '10.10.20.20:1521/ORCL';
const CREDENTIALS = { username: 'sys', password: 'oracle', asSysdba: true };

async function contexteDistant(lab: RmanLab): Promise<LinuxRmanContext> {
  const resolu = LinuxRmanContext.forTarget(lab.prod, DR_SANS_CREDENTIALS, CREDENTIALS);
  if (resolu.ok === false) throw new Error(`cible non resolue : ${resolu.error}`);
  return resolu.ctx;
}

function tramesPour(lab: RmanLab, ctx: LinuxRmanContext, appel: (c: LinuxRmanContext) => unknown): number {
  const trames = framesSentOn(lab.prod, 'eth0');
  const avant = trames.length;
  appel(ctx);
  return trames.length - avant;
}

const ACCESSEURS: ReadonlyArray<readonly [string, (c: LinuxRmanContext) => unknown]> = [
  ['getCurrentScn', (c) => c.getCurrentScn()],
  ['getInstanceState', (c) => c.getInstanceState()],
  ['getSpfileParam', (c) => c.getSpfileParam('db_name')],
  ['getControlFilePaths', (c) => c.getControlFilePaths()],
  ['getArchivelogPaths', (c) => c.getArchivelogPaths()],
  ['getRecoveryAreaUsedBytes', (c) => c.getRecoveryAreaUsedBytes()],
  ['getDatafiles', (c) => c.getDatafiles()],
];

describe('une cible DISTANTE repond par le fil', () => {
  it.each(ACCESSEURS)('%s pose sa question au lieu de lire l objet du pair', async (_nom, appel) => {
    const lab = await buildRmanLab();
    const ctx = await contexteDistant(lab);
    expect(tramesPour(lab, ctx, appel)).toBeGreaterThan(0);
  }, 60000);

  it('CONTRE-TEMOIN — une cible LOCALE ne met rien sur le fil', async () => {
    const lab = await buildRmanLab();
    const local = LinuxRmanContext.forDevice(lab.prod);
    for (const [, appel] of ACCESSEURS) {
      expect(tramesPour(lab, local, appel)).toBe(0);
    }
  }, 60000);

  it('NON-REGRESSION — les valeurs rendues restent celles de la cible', async () => {
    const lab = await buildRmanLab();
    const ctx = await contexteDistant(lab);
    expect(ctx.getInstanceState()).toBe('OPEN');
    expect(ctx.getSpfileParam('db_name')).toBe('ORCL');
    expect(ctx.getCurrentScn()).toBeGreaterThan(0);
    expect(ctx.getControlFilePaths().length).toBeGreaterThan(0);
    expect(ctx.getDatafiles().length).toBeGreaterThan(0);
  }, 60000);
});
