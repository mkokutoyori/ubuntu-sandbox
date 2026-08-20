/**
 * Une vue appartient a la SESSION, pas a la machine.
 *
 * Defaut mesure (audit §2.5, C7) : `activeParserView` etait un champ du
 * SHELL, absent de `VtySnapshot` — donc ni enregistre par
 * `snapshotVtyState()` ni restaure par `applyVtyState()` — et
 * `fermerSessionExec()` remettait le niveau, le mode et l'historique
 * SANS y toucher.
 *
 * La console etait donc laissee ENFERMEE dans la vue de l'utilisateur
 * precedent, et ne pouvait meme pas demander dans laquelle elle se
 * trouvait. C'est le meme defaut que celui deja corrige pour
 * `terminal monitor` : un etat de session loge sur un objet partage par
 * toutes les sessions.
 *
 * Le sens du correctif compte dans les DEUX directions, et une seule des
 * deux aurait paru suffisante : une vue qui SURVIT confine un operateur
 * qui n'a rien demande, et une vue qui FUIT vers une autre session donne
 * a celle-ci un role qu'elle n'a pas presente.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const SECRET_VUE = 'Vue@Noc2026';

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

/** Un routeur avec une vue NOC et un compte qui la porte. */
async function lab(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, [
    'enable', 'configure terminal', 'aaa new-model',
    'parser view NOC', `secret ${SECRET_VUE}`,
    'commands exec include show version', 'exit',
    'username noc view NOC secret noc',
    'end',
  ]);
  return r;
}

const vueCourante = (r: CiscoRouter) => r.executeCommand('show parser view');

describe('C7 — la vue ne survit pas a la session', () => {
  it('apres `exit`, la session suivante n est pas confinee', async () => {
    const r = await lab();
    expect(await r.loginAs('noc', 'noc')).toBe(true);
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    expect(await r.executeCommand('exit')).toContain('Connection closed');

    // La session suivante commence a la racine, au niveau 1, et voit
    // l'arbre utilisateur — pas celui du role precedent.
    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    expect(await r.executeCommand('show ip route')).not.toContain('% Invalid input');
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('apres `exit`, on peut de nouveau demander ou l on est', async () => {
    const r = await lab();
    await r.loginAs('noc', 'noc');
    await r.executeCommand('exit');
    await r.executeCommand('enable');
    expect(await vueCourante(r)).toBe("Current view is 'root'");
  });

  it('un redemarrage remet la session a la racine', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_VUE });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    // `reload` n'est pas dans la vue : on revient a la racine pour le
    // taper, ce qui est precisement ce qu'un operateur doit faire.
    await r.executeCommand('enable view');
    await r.executeCommand('reload', { confirmInput: 'yes' });

    expect(await r.executeCommand('show privilege')).toContain('level is 1');
    expect(await r.executeCommand('show ip route')).not.toContain('% Invalid input');
  });

  it('la vue voyage dans l instantane de session', async () => {
    const r = await lab();
    const shell = (r as unknown as {
      shell: {
        snapshotVtyState: () => Record<string, unknown>;
        applyVtyState: (s: Record<string, unknown>) => void;
      };
    }).shell;

    await r.executeCommand('enable view NOC', { passwordInput: SECRET_VUE });
    const dansLaVue = shell.snapshotVtyState();
    expect(dansLaVue.activeParserView).toBe('NOC');

    await r.executeCommand('enable view');
    const aLaRacine = shell.snapshotVtyState();
    expect(aLaRacine.activeParserView).toBeNull();

    // Restaurer l'instantane de la vue remet la session dans son role :
    // sans ce champ, une session vty relisant son etat en sortait.
    shell.applyVtyState(dansLaVue);
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    shell.applyVtyState(aLaRacine);
    expect(await vueCourante(r)).toBe("Current view is 'root'");
  });

  /**
   * Trouve en rendant la vue per-session, et corrige avec elle.
   *
   * `InteractionPlanContext.view` etait DECLARE et rempli par personne :
   * le planificateur jugeait donc la visibilite sur la vue du SHELL. Tant
   * que celle-ci etait globale, l'oubli ne se voyait pas ; des qu'une vue
   * voyage avec sa session, une commande absente de la vue ouvrait quand
   * meme son dialogue — `reload` demandait confirmation a un operateur
   * qui n'a pas le droit de recharger.
   */
  it('une commande a CONFIRMATION absente de la vue n ouvre pas son dialogue', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_VUE });
    for (const attaque of ['reload', 'write erase', 'erase startup-config']) {
      expect(await r.executeCommand(attaque, { confirmInput: 'yes' }), attaque)
        .toContain('% Invalid input');
    }
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");
  });

  it('une session ouverte SANS vue n herite pas de celle d avant', async () => {
    const r = await lab();
    await r.loginAs('noc', 'noc');
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");
    await r.executeCommand('exit');

    await jouer(r, ['enable', 'configure terminal', 'username libre privilege 15 secret libre', 'end', 'exit']);
    expect(await r.loginAs('libre', 'libre')).toBe(true);
    expect(await vueCourante(r)).toBe("Current view is 'root'");
    expect(await r.executeCommand('show ip route')).not.toContain('% Invalid input');
  });
});
