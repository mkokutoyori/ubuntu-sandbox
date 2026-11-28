/*
 * Sonde — la configuration du broker est REPLIQUEE sur les membres : `dgmgrl` connecte a la standby voit la configuration creee sur la primaire.
 *
 * Releve AVANT (laboratoire RMAN, standby creee par DUPLICATE, configuration creee et activee sur la primaire) : `SHOW CONFIGURATION` sur la standby repondait
 * « ORA-16532: Oracle Data Guard broker configuration does not exist » et `EDIT DATABASE ... SET PROPERTY LogXptMode` aussi : la configuration vivait dans une table en memoire
 * du module, par instance, sans jamais quitter la primaire.
 *
 * Oracle (Data Guard Broker, Concepts : « the broker configuration is stored in two configuration files on each database of the configuration », dr1/dr2<db_unique_name>.dat ; DMON
 * replique chaque changement vers les membres) : la configuration se lit de n'importe quel membre. Ici elle est inscrite dans un parametre cache de chaque instance
 * (`_dg_broker_config`), et la primaire l'ecrit sur chaque membre par un `ALTER SYSTEM SET` sur une session Oracle Net : des trames reelles, pas un appel a l'objet du pair.
 * Un changement tape sur une standby (EDIT, ADD...) est ROUTE vers la primaire par un message DMON sur une session Oracle Net (un `ALTER SYSTEM SET` du parametre cache `_dg_broker_command`,
 * le texte de la commande encode en hexadecimal, la reponse revenant dans le message de la session) : la primaire l'applique et le replique, comme un vrai broker. `dgmgrl` connecte a distance
 * (`sys/oracle@hote:1521/service`) passe par le meme canal.
 *
 * Apres un SWITCHOVER ou un FAILOVER la configuration suit : la liste des membres bascule (l'ancienne primaire devient membre, la nouvelle sort de la liste), sur les deux membres pour le switchover ;
 * le FAILOVER, tape sur la standby quand la primaire est perdue, ne peut atteindre personne : seule la copie locale est ajustee, l'ancienne primaire sort de la liste (pas de REINSTATE).
 *
 * Discrimine par `git stash push -- src/terminal` : 4 des 6 premiers cas tombent (mesure faite avant les cas de bascule ; 3 de plus tombent contre la version precedente, et et le cas de l'adresse injoignable contre celle d'avant le routage ; le cas de la session distante joignable passe des deux cotes, puisque l'ancienne version l'executait localement et que la primaire est locale ici). Deux passent des deux cotes et sont nommes : le TEMOIN (la primaire garde sa configuration) et l'effacement
 * sur la standby, vrai avant parce que la standby n'avait aucune configuration (il garde que le correctif n'invente pas de configuration residuelle).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { __resetBrokers } from '@/terminal/commands/DgmgrlCommands';
import { BackupKey, DeviceCatalogRegistry } from '@/terminal/subshells/rman';
import { addStandbyRedoLogs, buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances(); Logger.reset(); BackupKey._reset(); DeviceCatalogRegistry._reset(); __resetBrokers();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.prod, 'STARTUP MOUNT;');
  lab.sql(lab.prod, 'ALTER DATABASE ARCHIVELOG;');
  lab.sql(lab.prod, 'ALTER DATABASE OPEN;');
  lab.sql(lab.dr, 'SHUTDOWN IMMEDIATE;');
  lab.sql(lab.dr, 'STARTUP NOMOUNT;');
  lab.sh(lab.prod, `rman target / <<'EOF'\nCONNECT AUXILIARY sys/oracle@${lab.drIp}:1521/ORCL;\nDUPLICATE TARGET DATABASE FOR STANDBY FROM ACTIVE DATABASE DORECOVER NOFILENAMECHECK;\nEOF`);
});

const dgmgrl = (device: Parameters<RmanLab['sh']>[0], ...commands: string[]): string =>
  lab.sh(device, `dgmgrl / <<'EOF'\n${commands.join('\n')}\nEOF`);

const configured = (): void => {
  addStandbyRedoLogs(lab);
  dgmgrl(lab.prod, "CREATE CONFIGURATION 'lumiere_dg' AS PRIMARY DATABASE IS 'ORCL' CONNECT IDENTIFIER IS orcl;", `ADD DATABASE 'ORCL_STB' AS CONNECT IDENTIFIER IS ${lab.drIp}:1521/ORCL MAINTAINED AS PHYSICAL;`, 'ENABLE CONFIGURATION;');
};

describe('replication of the broker configuration', () => {
  it('TEMOIN — the primary shows its own configuration', () => {
    configured();
    expect(dgmgrl(lab.prod, 'SHOW CONFIGURATION;')).toContain('Configuration - lumiere_dg');
  });

  it('the standby shows the same configuration, name and members', () => {
    configured();
    const out = dgmgrl(lab.dr, 'SHOW CONFIGURATION;');
    expect(out).toContain('Configuration - lumiere_dg');
    expect(out).toMatch(/ORCL - Primary database/);
    expect(out).toMatch(/ORCL_STB - Physical standby database/);
    expect(out).not.toContain('ORA-16532');
  });

  it('a change made on the primary reaches the standby: LogXptMode SYNC', () => {
    configured();
    dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';");
    expect(dgmgrl(lab.dr, "SHOW DATABASE 'ORCL_STB';")).toContain('Log Transport Mode: SYNC');
  });

  it('the protection mode reaches the standby', () => {
    configured();
    dgmgrl(lab.prod, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';", 'EDIT CONFIGURATION SET PROTECTION MODE AS MaxAvailability;');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('Protection Mode: MaxAvailability');
  });

  it('removing the configuration on the primary clears it on the standby (vacuously true before)', () => {
    configured();
    dgmgrl(lab.prod, 'REMOVE CONFIGURATION;');
    expect(dgmgrl(lab.dr, 'SHOW CONFIGURATION;')).toContain('ORA-16532');
  });

  it('a change typed on the standby is routed to the primary, applied there and replicated back', () => {
    configured();
    const out = dgmgrl(lab.dr, "EDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';");
    expect(out).toContain('Property "logxptmode" updated');
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toContain('Log Transport Mode: SYNC');
    expect(dgmgrl(lab.dr, "SHOW DATABASE 'ORCL_STB';")).toContain('Log Transport Mode: SYNC');
  });

  it('a session connected to an address nobody serves fails instead of silently running on the local database', () => {
    configured();
    const out = lab.sh(lab.prod, `dgmgrl sys/oracle@10.99.99.99:1521/ORCL <<'EOF'\nSHOW CONFIGURATION;\nEOF`);
    expect(out).not.toContain('Configuration - lumiere_dg');
    expect(out).toContain('Error:');
  });

  it('TEMOIN — a session connected to a remote database reaches it and gets the same answers', () => {
    configured();
    const out = lab.sh(lab.prod, `dgmgrl sys/oracle@${lab.drIp}:1521/ORCL <<'EOF'\nEDIT DATABASE 'ORCL_STB' SET PROPERTY LogXptMode='SYNC';\nSHOW CONFIGURATION;\nEOF`);
    expect(out).toContain('Property "logxptmode" updated');
    expect(out).toContain('Configuration - lumiere_dg');
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL_STB';")).toContain('Log Transport Mode: SYNC');
  });

  it('after a SWITCHOVER both members list the new primary and the former one as a member', () => {
    configured();
    dgmgrl(lab.prod, "SWITCHOVER TO 'ORCL_STB';");
    for (const device of [lab.prod, lab.dr]) {
      const out = dgmgrl(device, 'SHOW CONFIGURATION;');
      expect(out).toMatch(/ORCL_STB - Primary database/);
      expect(out).toMatch(/ORCL - Physical standby database/);
    }
  });

  it('the new primary can change the configuration and the former primary receives it', () => {
    configured();
    dgmgrl(lab.prod, "SWITCHOVER TO 'ORCL_STB';");
    dgmgrl(lab.dr, "EDIT DATABASE 'ORCL' SET PROPERTY LogXptMode='SYNC';");
    expect(dgmgrl(lab.prod, "SHOW DATABASE 'ORCL';")).toContain('Log Transport Mode: SYNC');
  });

  it('after a FAILOVER the promoted standby lists itself as the primary and drops the lost one', () => {
    configured();
    lab.sql(lab.prod, 'SHUTDOWN ABORT;');
    dgmgrl(lab.dr, "FAILOVER TO 'ORCL_STB';");
    const out = dgmgrl(lab.dr, 'SHOW CONFIGURATION;');
    expect(out).toMatch(/ORCL_STB - Primary database/);
    expect(out).not.toMatch(/ORCL - /);
  });
});
