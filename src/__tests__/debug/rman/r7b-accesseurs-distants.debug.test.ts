/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * SUITE DU LOT R7. Le premier lot a fait traverser le fil a l'ouverture
 * de session, aux requetes SQL et a `getDatafiles`. Le message de commit
 * a NOMME ce qui restait : six accesseurs qui, pour une cible DISTANTE,
 * lisent encore l'objet du pair.
 *
 * COMMENT CE BANC DISCRIMINE, et pourquoi le contenu ne suffit pas.
 * `forTarget` construit le contexte SUR la machine cible, avec la base
 * de la cible : `getCurrentScn()` rend donc DEJA le bon SCN — celui de
 * DR. La VALEUR est juste ; c'est le MOYEN qui ne l'est pas. Un temoin
 * de contenu ne distinguerait rien. Seul le COMPTE DE TRAMES le fait,
 * exactement comme CLAUDE.md §4 l'exige.
 *
 * Chaque accesseur est donc appele SEUL, entre deux relevés du compteur
 * de trames sorties de PROD. Un accesseur qui demande rend un compte
 * non nul ; un accesseur qui lit l'objet du pair rend zero.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab } from '../../support/rmanLab';
import { framesSentOn } from '../../support/wireWatch';
import { LinuxRmanContext } from '@/terminal/subshells/rman/integration/LinuxRmanContext';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const note = (l: string) => { console.log(l); };

describe('R7b — les accesseurs d une cible distante demandent-ils ?', () => {
  it('chaque accesseur, seul, entre deux relevés du compteur de trames', async () => {
    const lab = await buildRmanLab();
    const resolu = LinuxRmanContext.forTarget(
      lab.prod, '10.10.20.20:1521/ORCL',
      { username: 'sys', password: 'oracle', asSysdba: true });
    if (resolu.ok === false) {
      note(`[r7b-0] la cible ne se resout pas : ${resolu.error}`);
      expect(true).toBe(true);
      return;
    }
    const ctx = resolu.ctx;
    note('[r7b-0] cible distante resolue, session Oracle Net ouverte');

    const trames = framesSentOn(lab.prod, 'eth0');
    const mesure = (nom: string, appel: () => unknown): void => {
      const avant = trames.length;
      const valeur = appel();
      const porte = trames.length - avant;
      const rendu = Array.isArray(valeur)
        ? `[${valeur.length} element(s)]`
        : JSON.stringify(valeur);
      note(`[r7b] ${nom.padEnd(26)} ${String(porte).padStart(2)} trame(s)   ${
        String(rendu).slice(0, 60)}`);
    };

    mesure('getDatafiles', () => ctx.getDatafiles());
    mesure('getCurrentScn', () => ctx.getCurrentScn());
    mesure('getInstanceState', () => ctx.getInstanceState());
    mesure('getSpfileParam(db_name)', () => ctx.getSpfileParam('db_name'));
    mesure('getControlFilePaths', () => ctx.getControlFilePaths());
    mesure('getArchivelogPaths', () => ctx.getArchivelogPaths());
    mesure('getRecoveryAreaUsedBytes', () => ctx.getRecoveryAreaUsedBytes());
    mesure('runSqlStatement (TEMOIN)', () => ctx.runSqlStatement('SELECT 1 FROM dual'));
    expect(true).toBe(true);
  }, 120000);
});
