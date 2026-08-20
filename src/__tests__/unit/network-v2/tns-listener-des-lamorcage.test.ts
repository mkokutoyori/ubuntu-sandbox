/**
 * docs/PRD-Manquements.md §M1 — le listener TNS écoute dès l'amorçage.
 *
 * Le défaut que ce fichier retient est un défaut d'ORDRE, et c'est ce
 * qui le rendait invisible : le port 1521 était joignable ou non selon
 * qu'une commande Oracle avait été tapée **sur la console du serveur**
 * avant que le client n'essaie. Un TP fait dans un sens marchait, le
 * même TP fait dans l'autre échouait, et les trois vues locales
 * (`ss`, `lsnrctl status`, `ps`) affirmaient pendant ce temps que tout
 * allait bien.
 *
 * Les cas « AVANT » ci-dessous ne touchent donc JAMAIS le serveur —
 * c'est toute leur valeur.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SRV = '10.91.0.10';
const CLI = '10.91.0.20';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function lab() {
  const server = new LinuxServer('linux-server', 'ORA');
  const client = new LinuxPC('linux-pc', 'CLI');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV), mask);
  client.getPorts()[0].configureIP(new IPAddress(CLI), mask);
  server.powerOn();
  client.powerOn();
  return { server, client };
}

describe('§M1 — le 1521 répond avant toute commande locale', () => {
  it('nc depuis une autre machine réussit sans que le serveur ait rien fait', async () => {
    const { client } = lab();

    const out = await client.executeCommand(`nc -zv ${SRV} 1521`);

    expect(out).toMatch(/succeeded|open/i);
    expect(out).not.toMatch(/refused/i);
  });

  it('nmap voit le port ouvert, sans commande locale préalable', async () => {
    const { client } = lab();

    const out = await client.executeCommand(`nmap -p 1520,1521,1522 ${SRV}`);

    expect(out).toMatch(/1521\/tcp\s+open/);
    expect(out).not.toMatch(/1520\/tcp\s+open/);
  });

  it('l\'écoute existe sur les deux familles, comme la table l\'annonce', () => {
    const { server } = lab();

    const servies = server.getTcpStack().listListeners()
      .filter((l) => l.localPort === 1521)
      .map((l) => l.localIp)
      .sort();

    expect(servies).toEqual(['0.0.0.0', '::']);
  });

  it('la ligne de ss porte le processus et la bannière, sans bind manuel', () => {
    const { server } = lab();

    const lignes = server.getSocketTable().getListening()
      .filter((e) => e.protocol === 'tcp' && e.localPort === 1521);

    expect(lignes).toHaveLength(2);
    for (const l of lignes) {
      expect(l.processName).toBe('tnslsnr');
      expect(l.pid).toBe(2001);
      expect(l.banner).toContain('SERVICE_NAME=ORCL');
    }
  });

  it('ce que ss affiche et ce que nc obtient s\'accordent, dans cet ordre-ci', async () => {
    const { server, client } = lab();

    // La question de l'apprenant, posée des deux côtés du câble.
    const ss = await server.executeCommand('ss -ltn');
    const nc = await client.executeCommand(`nc -zv ${SRV} 1521`);

    expect(ss).toContain(':1521');
    expect(nc).toMatch(/succeeded|open/i);
  });
});

describe('§M1 — la reprise du port par la base, puis lsnrctl stop', () => {
  it('une commande Oracle locale ne casse pas l\'écoute déjà en place', async () => {
    const { server, client } = lab();

    // C'est ici que le binding reprend le port : sans la fermeture
    // préalable, `listen()` lèverait EADDRINUSE et la base démarrerait
    // sans jamais enregistrer ses sondes.
    await server.executeCommand('lsnrctl status');

    expect(await client.executeCommand(`nc -zv ${SRV} 1521`)).toMatch(/succeeded|open/i);
    expect(server.getTcpStack().listListeners().filter((l) => l.localPort === 1521))
      .toHaveLength(2);
  });

  it('`lsnrctl stop` ferme le port pour de bon, et ss cesse de l\'annoncer', async () => {
    const { server, client } = lab();
    await server.executeCommand('lsnrctl start');

    await server.executeCommand('lsnrctl stop');

    // Un listener arrêté n'est ni joignable ni affiché : c'est le même
    // fait, vu des deux côtés.
    expect(await client.executeCommand(`nc -zv ${SRV} 1521`)).toMatch(/refused|timed out/i);
    expect(await server.executeCommand('ss -ltn')).not.toContain(':1521');
  });
});
