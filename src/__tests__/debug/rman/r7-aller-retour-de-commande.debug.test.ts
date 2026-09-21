/**
 * Suite de RELEVE (pas d'assertions de contrat) — `src/__tests__/debug/`.
 *
 * LOT R7 de `docs/ASSESSMENT-RMAN.md`, le dernier ouvert de son tableau.
 * La poignee de main TNS traverse deja routeur et pare-feu ; ce que
 * l'assessment nomme comme limite est l'ALLER-RETOUR DE LA COMMANDE :
 *
 *   << la difference de trames entre CONNECT seul et CONNECT + BACKUP
 *      est nulle [...] l'aller-retour de la COMMANDE n'est pas trame
 *      non plus >>
 *
 * Ce banc la mesure sur une commande qui ne transporte AUCUNE donnee,
 * pour lever toute ambiguite : `BACKUP` ecrit la piece sur le disque de
 * la CIBLE — que ses octets ne traversent pas est CORRECT — tandis que
 * `SQL '...'` et `REPORT SCHEMA` n'ont d'autre effet que de poser une
 * question a la cible et d'en lire la reponse. Si meme celles-la ne
 * mettent rien sur le fil, c'est que RMAN lit l'objet du pair.
 *
 * La mesure est une DIFFERENCE, comme l'exige CLAUDE.md §4 : un vrai
 * CONNECT met deja des trames sur le fil, donc compter l'absolu ne
 * distinguerait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab } from '../../support/rmanLab';
import { framesSentOn } from '../../support/wireWatch';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  resetAllOracleInstances(); Logger.reset();
});

const note = (l: string) => { console.log(l); };
const DR = 'sys/oracle@10.10.20.20:1521/ORCL';

describe('R7 — l aller-retour de la commande traverse-t-il le fil ?', () => {
  it('CONNECT seul, puis CONNECT + une commande qui ne porte pas de donnees', async () => {
    const lab = await buildRmanLab();
    lab.sql(lab.dr, 'CREATE TABLE marqueur_dr (site VARCHAR2(12));');
    lab.sql(lab.dr, "INSERT INTO marqueur_dr VALUES ('SITE_DR');");
    lab.sql(lab.dr, 'COMMIT;');

    const trames = framesSentOn(lab.prod, 'eth0');

    const mesure = (script: string): number => {
      const avant = trames.length;
      lab.sh(lab.prod, `printf '${script}' | rman`);
      return trames.length - avant;
    };

    const connectSeul = mesure(`CONNECT TARGET ${DR};\\n`);
    note(`[r7-1] CONNECT seul                       : ${connectSeul} trames`);

    const avecSql = mesure(
      `CONNECT TARGET ${DR};\\nSQL "SELECT site FROM marqueur_dr";\\n`);
    note(`[r7-2] CONNECT + SQL '...'                : ${avecSql} trames`);
    note(`[r7-3] DIFFERENCE portee par la commande  : ${avecSql - connectSeul}`);

    const avecReport = mesure(`CONNECT TARGET ${DR};\\nREPORT SCHEMA;\\n`);
    note(`[r7-4] CONNECT + REPORT SCHEMA            : ${avecReport} trames`);
    note(`[r7-5] DIFFERENCE                         : ${avecReport - connectSeul}`);

    const avecBackup = mesure(`CONNECT TARGET ${DR};\\nBACKUP DATABASE;\\n`);
    note(`[r7-6] CONNECT + BACKUP DATABASE          : ${avecBackup} trames`);
    note(`[r7-7] DIFFERENCE                         : ${avecBackup - connectSeul}`);

    const sortie = lab.sh(lab.prod,
      `printf 'CONNECT TARGET ${DR};\\nREPORT SCHEMA;\\n' | rman`);
    note(`[r7-8] ce que RMAN affiche : ${
      JSON.stringify(sortie.split('\n').filter((l) => l.trim()).slice(-4).join(' | '))}`);
    expect(true).toBe(true);
  }, 120000);
});
