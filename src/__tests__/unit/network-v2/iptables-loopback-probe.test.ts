/**
 * Netfilter traite le trafic de bouclage comme tout autre : un paquet TCP d'un hôte vers lui-même (`curl 127.0.0.1`) traverse la chaîne OUTPUT
 * (interface de sortie `lo`) puis la chaîne INPUT (interface d'entrée `lo`), et c'est pourquoi toute politique INPUT DROP s'accompagne de
 * `-A INPUT -i lo -j ACCEPT`. Le chemin local du TCP du simulateur remettait le segment à la pile sans consulter ni l'une ni l'autre : une
 * politique DROP, un REJECT ou un compteur de règle n'avaient aucun effet sur `127.0.0.1`.
 *
 * MESURÉ avant correctif : après `iptables -P INPUT DROP`, `curl http://127.0.0.1/` répondait 200 et le compteur de la règle REJECT restait à 0. Avant
 * correctif (git stash de src/network) 3 cas sur 6 tombent ; trois témoins passent dans les deux états : le service répond sans règle, avec la
 * règle `-i lo -j ACCEPT` la politique DROP laisse passer le bouclage, et une règle sur un autre port ne touche pas le bouclage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const sh = (srv: LinuxServer, command: string): Promise<string> => srv.executeCommand(command);

async function web(name: string): Promise<LinuxServer> {
  const srv = new LinuxServer('linux-server', name); srv.powerOn();
  await sh(srv, 'systemctl start nginx');
  return srv;
}

const fetchLocal = (srv: LinuxServer): Promise<string> => sh(srv, 'curl -s -m 3 -o /dev/null -w "%{http_code}" http://127.0.0.1/; echo " rc=$?"');

describe('iptables sur le bouclage', () => {
  it('témoin : sans règle, le service local répond', async () => {
    const srv = await web('L1');
    expect(await fetchLocal(srv)).toMatch(/200\s+rc=0/);
  });

  it('INPUT policy DROP sans règle lo : le service local ne répond plus', async () => {
    const srv = await web('L2');
    await sh(srv, 'iptables -P INPUT DROP');
    expect(await fetchLocal(srv)).not.toContain('200');
  });

  it('témoin : INPUT policy DROP avec -i lo -j ACCEPT laisse passer le bouclage', async () => {
    const srv = await web('L3');
    await sh(srv, 'iptables -A INPUT -i lo -j ACCEPT');
    await sh(srv, 'iptables -P INPUT DROP');
    expect(await fetchLocal(srv)).toMatch(/200\s+rc=0/);
  });

  it('REJECT --reject-with tcp-reset sur INPUT : connexion refusée (code 7) et compteur incrémenté', async () => {
    const srv = await web('L4');
    await sh(srv, 'iptables -I INPUT -p tcp --dport 80 -j REJECT --reject-with tcp-reset');
    expect(await fetchLocal(srv)).toContain('rc=7');
    expect(await sh(srv, 'iptables -L INPUT -v -n')).not.toMatch(/^\s*0\s+0 REJECT/m);
  });

  it('DROP sur OUTPUT -o lo : le service local ne répond plus', async () => {
    const srv = await web('L5');
    await sh(srv, 'iptables -A OUTPUT -o lo -p tcp --dport 80 -j DROP');
    expect(await fetchLocal(srv)).not.toContain('200');
  });

  it("une règle sur un autre port n'affecte pas le bouclage", async () => {
    const srv = await web('L6');
    await sh(srv, 'iptables -I INPUT -p tcp --dport 8080 -j DROP');
    expect(await fetchLocal(srv)).toMatch(/200\s+rc=0/);
  });
});
