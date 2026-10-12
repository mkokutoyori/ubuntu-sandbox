/*
 * Sur une ligne vty IOS, `no access-class` et `no exec-timeout` etaient acceptes et ne retiraient rien.
 *
 * Mesure de depart (routeur et commutateur Cisco, `line vty 0 4` portant `exec-timeout 5 0`
 * et `access-class VTY-IN in`) : apres `no exec-timeout` et `no access-class VTY-IN in`,
 * `show running-config | section line vty` rendait encore les deux lignes, et le filtre d'acces
 * continuait de refuser le deuxieme poste. Le mode
 * ligne connaissait `no login`, `no password`, `no history`, `no absolute-timeout`... mais pas les trois
 * directives dont depend le durcissement de l'acces d'administration : un auditeur qui demande de
 * « retirer le filtre » obtenait une commande acceptee et un filtre toujours en place.
 *
 * Corrige : le magasin de lignes sait RETIRER un champ (`unset`), et `no exec-timeout`,
 * `no access-class [acl] [in|out]`, `no session-timeout`, `no privilege level`,
 * `no login-timeout` et `no rotary` l'utilisent. Le commutateur ne consultait en outre jamais la source
 * d'une connexion SSH contre l'`access-class` de la ligne (seul le telnet le faisait) : le filtre etait
 * rendu par `show running-config` et ne filtrait rien.
 *
 * Discrimine contre l'etat d'avant (`git stash push -- src/network`) : 6 des 8 cas tombent (3 par
 * plateforme). Les 2 autres sont le TEMOIN de chaque plateforme : le filtre laisse entrer le poste qu'il
 * autorise, ce qui prouve que le refus du deuxieme poste vient de la regle et non du laboratoire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildMatrixLab, ADMIN, SECRET, type Kind } from './_helpers/sshMatrixLab';

interface Cli { executeCommand(command: string, input?: unknown): Promise<string> }

for (const kind of ['router-cisco', 'switch-cisco'] as Kind[]) {
  describe(kind, () => {
    let first: Cli;
    let second: Cli;
    let device: Cli;
    let address: string;

    beforeEach(async () => {
      const lab = await buildMatrixLab(['linux-pc', 'linux-server', kind]);
      [first, second, device] = lab.nodes.map((n) => n.device as unknown as Cli);
      address = lab.nodes[2].ip;
      for (const line of ['enable', 'configure terminal', 'ip access-list standard VTY-IN', `permit ${lab.nodes[0].ip}`, 'exit']) {
        await device.executeCommand(line);
      }
      await device.executeCommand('end');
    });

    const line = async (...commands: string[]) => {
      for (const command of ['configure terminal', 'line vty 0 4', ...commands, 'end']) await device.executeCommand(command);
    };
    const section = () => device.executeCommand('show running-config | section line vty');
    const connect = (from: Cli) =>
      from.executeCommand(`sshpass -p ${SECRET} ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 ${ADMIN}@${address} "show clock"`);

    it('`no exec-timeout` retire la ligne et laisse les autres', async () => {
      await line('exec-timeout 5 0', 'session-timeout 20');
      expect(await section()).toContain('exec-timeout 5 0');
      await line('no exec-timeout');
      const out = await section();
      expect(out).not.toContain('exec-timeout');
      expect(out).toContain('session-timeout 20');
    });

    it('`no access-class` rouvre la porte au poste que le filtre refusait', async () => {
      await line('access-class VTY-IN in');
      expect(await connect(second)).toContain('Connection refused');
      await line('no access-class VTY-IN in');
      expect(await section()).not.toContain('access-class');
      expect(await connect(second)).toContain('UTC');
    });

    it('temoin : le filtre laisse entrer le poste qu\'il autorise', async () => {
      await line('access-class VTY-IN in');
      expect(await connect(first)).toContain('UTC');
    });

    it('`no privilege level` et `no session-timeout` retirent leur champ', async () => {
      await line('privilege level 15', 'session-timeout 20');
      expect(await section()).toContain('privilege level 15');
      await line('no privilege level', 'no session-timeout');
      const out = await section();
      expect(out).not.toContain('privilege level');
      expect(out).not.toContain('session-timeout');
    });
  });
}
