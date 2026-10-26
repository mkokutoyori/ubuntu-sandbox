/**
 * Mesure (CiscoRouter, Gi0/1 en 203.0.113.2) de `no ip nat inside source static tcp|udp …`.
 *
 * - `no ip nat inside source static tcp 192.168.20.4 22 interface GigabitEthernet0/1 22` ne supprimait RIEN : la forme `interface` etait lue comme
 *   `tcp <local> <lport> <global> <gport>`, donc l'adresse globale devenait le mot « interface » ; la commande rendait une ligne vide et
 *   la ligne restait dans la configuration.
 * - `no ip nat inside source static tcp 192.168.20.4 443 203.0.113.2 443` supprimait TOUTES les entrees partageant le couple (local, global), donc
 *   aussi les redirections 22 et 80 du meme serveur, et un `no ip nat inside source static <local> <global>` (1:1) emportait de meme les redirections de port.
 *
 * Corrige : une seule lecture de la forme tcp|udp (`parseStaticPortMapping`) sert a l'ajout ET a la suppression ; l'entree de la forme
 * `interface` retient l'interface qu'elle nomme ; la suppression ne retire que l'entree designee (protocole, ports, interface ou adresse globale, vrf).
 *
 * Discrimine par `git stash push -- src/network` : 4 cas sur 6 tombent. Passent des deux cotes, TEMOINS : l'ajout des quatre formes et la suppression de la
 * forme a adresse globale explicite (qui marchait, au prix de l'exces).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let router: CiscoRouter;

const LINES = {
  ssh: 'ip nat inside source static tcp 192.168.20.4 22 interface GigabitEthernet0/1 22',
  http: 'ip nat inside source static tcp 192.168.20.4 80 interface GigabitEthernet0/1 80',
  https: 'ip nat inside source static tcp 192.168.20.4 443 203.0.113.2 443',
  dns: 'ip nat inside source static udp 192.168.20.4 53 interface GigabitEthernet0/1 53',
  oneToOne: 'ip nat inside source static 192.168.20.9 203.0.113.9',
};

async function config(...commands: string[]): Promise<string[]> {
  const out: string[] = [];
  await router.executeCommand('configure terminal');
  for (const command of commands) out.push(String(await router.executeCommand(command)));
  await router.executeCommand('end');
  return out;
}

async function staticLines(): Promise<string[]> {
  const running = String(await router.executeCommand('show running-config | include ip nat inside source static'));
  return running.split('\n').map(l => l.trim()).filter(l => l.startsWith('ip nat inside source static'));
}

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  EquipmentRegistry.resetInstance();
  router = new CiscoRouter('router', 0, 0);
  await router.executeCommand('enable');
  await config('interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.0', 'ip nat outside', 'no shutdown', 'exit');
  await config(LINES.ssh, LINES.http, LINES.https, LINES.dns, LINES.oneToOne);
});

describe('no ip nat inside source static tcp|udp', () => {
  it('TEMOIN — les quatre formes sont ajoutees', async () => {
    expect(await staticLines()).toEqual([LINES.ssh, LINES.http, LINES.https, LINES.dns, LINES.oneToOne]);
  });

  it('la forme « interface » est supprimee', async () => {
    await config(`no ${LINES.ssh}`);
    expect(await staticLines()).not.toContain(LINES.ssh);
  });

  it('la suppression de la forme « interface » laisse les autres redirections du meme serveur', async () => {
    await config(`no ${LINES.ssh}`);
    expect(await staticLines()).toEqual([LINES.http, LINES.https, LINES.dns, LINES.oneToOne]);
  });

  it('la forme udp « interface » est supprimee sans toucher la forme tcp du meme port', async () => {
    await config('ip nat inside source static tcp 192.168.20.4 53 interface GigabitEthernet0/1 53', `no ${LINES.dns}`);
    const lines = await staticLines();
    expect(lines).not.toContain(LINES.dns);
    expect(lines).toContain('ip nat inside source static tcp 192.168.20.4 53 interface GigabitEthernet0/1 53');
  });

  it('TEMOIN — la forme a adresse globale explicite est supprimee', async () => {
    await config(`no ${LINES.https}`);
    expect(await staticLines()).not.toContain(LINES.https);
  });

  it('la suppression d\'une redirection de port laisse les autres et le NAT 1:1', async () => {
    await config(`no ${LINES.https}`);
    expect(await staticLines()).toEqual([LINES.ssh, LINES.http, LINES.dns, LINES.oneToOne]);
    await config(`no ${LINES.oneToOne}`);
    expect(await staticLines()).toEqual([LINES.ssh, LINES.http, LINES.dns]);
  });
});
