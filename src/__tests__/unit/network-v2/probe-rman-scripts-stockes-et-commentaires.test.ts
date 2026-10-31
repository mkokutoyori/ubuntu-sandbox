/**
 * Les scripts stockes de RMAN (`CREATE|REPLACE|PRINT|EXECUTE|DELETE SCRIPT`, `LIST SCRIPT NAMES`) etaient de purs
 * decors : CREATE ne retenait rien, PRINT imprimait toujours `BACKUP DATABASE;`, EXECUTE affichait « completed » sans
 * rien lancer, LIST disait « no scripts stored » apres une creation, et le corps sur plusieurs lignes du tutoriel
 * (`CREATE SCRIPT x {` ... `}`) etait refuse (« unexpected } outside RUN block »). Par ailleurs une commande suivie d'un
 * commentaire (`LIST BACKUP SUMMARY;  # ...`) etait rejetee (RMAN-01009), RMAN ne reconnaissant le `#` qu'en debut de ligne.
 * Corrige : le corps est garde dans le catalogue de l'equipement (il survit a la session), PRINT le relit, EXECUTE le
 * rejoue comme un bloc RUN, LIST le nomme, DELETE l'efface ; un `#` hors guillemets coupe la ligne.
 * Non source : le code d'erreur d'un script introuvable ou deja cree (RMAN-03002 ici, faute de catalogue de messages
 * lisible depuis ce reseau) ; voir TODO.md.
 *
 * Discrimine par `git stash` sur src/terminal : 5 des 8 cas tombent avant. Passent des deux cotes : une commande sans
 * commentaire (TEMOIN), un `#` entre guillemets qui n'est pas coupe (TEMOIN), et « le script survit a la session », dont
 * le PRINT d'avant imprimait en dur le meme `BACKUP DATABASE;` que le corps cree (coincidence, pas une preuve).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const rman = (...lines: string[]): string => lab.rman(lab.prod, ['CONNECT TARGET /;', ...lines].join('\n'));

describe('commentaires', () => {
  it('TEMOIN — une commande sans commentaire est executee', () => {
    expect(rman('LIST BACKUP SUMMARY;')).not.toContain('RMAN-01009');
  });

  it('un commentaire # apres la commande est ignore', () => {
    expect(rman('LIST BACKUP SUMMARY;  # liste courte')).not.toContain('RMAN-01009');
  });

  it('TEMOIN — un # entre guillemets reste dans la commande', () => {
    expect(rman("BACKUP DATABASE TAG 'A#B';")).toContain("tag=A#B");
  });
});

describe('scripts stockes', () => {
  it('un corps sur plusieurs lignes est enregistre, nomme et relu tel quel', () => {
    const out = rman('CREATE SCRIPT daily_backup {', '  BACKUP DATABASE;', '  DELETE NOPROMPT OBSOLETE;', '}',
      'LIST SCRIPT NAMES;', 'PRINT SCRIPT daily_backup;');
    expect(out).toContain('created script daily_backup');
    expect(out).toMatch(/List of Stored Scripts[\s\S]*\n {3}daily_backup/);
    expect(out).toContain('printing stored script: daily_backup\n{\n  BACKUP DATABASE;\n  DELETE NOPROMPT OBSOLETE;\n}');
  });

  it('EXECUTE rejoue vraiment le corps', () => {
    const out = rman('CREATE SCRIPT nightly { BACKUP DATABASE; }', 'EXECUTE SCRIPT nightly;');
    expect(out).toContain('executing script: nightly');
    expect(out).toContain('Finished backup');
  });

  it('le script survit a la session qui l a cree', () => {
    rman('CREATE SCRIPT keep { BACKUP DATABASE; }');
    expect(rman('PRINT SCRIPT keep;')).toContain('BACKUP DATABASE;');
  });

  it('REPLACE change le corps, DELETE l efface, un script absent est refuse', () => {
    const out = rman('CREATE SCRIPT s { BACKUP DATABASE; }', 'REPLACE SCRIPT s { LIST BACKUP SUMMARY; }', 'PRINT SCRIPT s;',
      'DELETE SCRIPT s;', 'PRINT SCRIPT s;');
    expect(out).toContain('replaced script s');
    expect(out).toContain('  LIST BACKUP SUMMARY;');
    expect(out).toContain('deleted script s');
    expect(out).toContain('script s not found');
  });

  it('CREATE sur un nom deja pris est refuse', () => {
    expect(rman('CREATE SCRIPT dup { BACKUP DATABASE; }', 'CREATE SCRIPT dup { BACKUP DATABASE; }')).toContain('script dup already exists');
  });
});
