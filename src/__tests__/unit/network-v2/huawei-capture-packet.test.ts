/**
 * `capture-packet interface … destination terminal` du routeur Huawei : la capture écoute les trames de l'interface par le point d'observation commun
 * (le même que tcpdump et l'Embedded Packet Capture de Cisco), s'arrête au nombre de paquets demandé, au délai `time-out` ou à Ctrl+C, et imprime
 * chaque paquet en hexadécimal. `acl N` filtre par la vraie ACL du routeur.
 *
 * MESURÉ avant correctif : `capture-packet` répondait « Unrecognized command found at '^' position » dans toutes les vues. Avant correctif
 * (git stash de src/network et src/terminal) 6 cas sur 7 tombent ; le témoin (le trafic traverse le routeur) passe dans les deux états.
 * La mise en page des paquets suit l'esprit de la documentation Huawei (en-tête puis octets), dont le texte exact n'est pas lisible depuis ce réseau ;
 * la destination `file` n'existe pas : ce VRP n'a ni `flash:` ni `dir`, la commande la refuse en le disant.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { TerminalManager } from '@/terminal/sessions/TerminalManager';
import type { HuaweiTerminalSession } from '@/terminal/sessions/HuaweiTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

const key = (k: string, ctrlKey = false): KeyEvent => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
const flush = () => new Promise<void>((r) => setTimeout(r, 5));
const run = (d: unknown, c: string) => (d as { executeCommand(c: string): Promise<string> }).executeCommand(c);

beforeEach(() => { EquipmentRegistry.resetInstance(); resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); });

async function lab() {
  const r1 = new HuaweiRouter('R1');
  const a = new LinuxPC('linux-pc', 'A');
  const b = new LinuxPC('linux-pc', 'B');
  const ports = r1.getPortNames() as string[];
  new Cable('ca').connect(a.getPort('eth0')!, r1.getPort(ports[0])!);
  new Cable('cb').connect(b.getPort('eth0')!, r1.getPort(ports[1])!);
  for (const c of ['system-view', `interface ${ports[0]}`, 'ip address 10.0.1.1 255.255.255.0', 'quit',
    `interface ${ports[1]}`, 'ip address 10.0.2.1 255.255.255.0', 'quit',
    'acl number 3000', 'rule permit icmp', 'quit', 'return']) await run(r1, c);
  await run(a, 'ip addr add 10.0.1.10/24 dev eth0'); await run(a, 'ip link set eth0 up'); await run(a, 'ip route add default via 10.0.1.1');
  await run(b, 'ip addr add 10.0.2.10/24 dev eth0'); await run(b, 'ip link set eth0 up'); await run(b, 'ip route add default via 10.0.2.1');
  const manager = new TerminalManager();
  const session = manager.getSession(manager.openTerminal(r1)!) as HuaweiTerminalSession;
  for (let i = 0; i < 30 && session.isBooting; i++) await new Promise((r) => setTimeout(r, 50));
  const type = async (line: string): Promise<void> => { session.setInput(line); session.handleKey(key('Enter')); await flush(); };
  const seen = (): string => session.lines.map((l) => l.text).join('\n');
  const settle = async (rounds = 20): Promise<void> => { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 20)); };
  return { r1, a, b, ports, session, type, seen, settle };
}

describe('Huawei capture-packet', () => {
  it('témoin : le trafic traverse le routeur', async () => {
    const { a } = await lab();
    expect(await run(a, 'ping -c 1 10.0.2.10')).toMatch(/1 received|0% packet loss/);
  });

  it('les paquets de l\'interface sont imprimés, la capture s\'arrête au packet-num', async () => {
    const { a, ports, type, seen, settle } = await lab();
    await type(`capture-packet interface ${ports[0]} destination terminal packet-num 2`);
    await run(a, 'ping -c 3 10.0.2.10');
    await settle();
    const shown = seen();
    expect(shown).toContain(`Capture started on ${ports[0]}`);
    expect(shown).toContain('Packet 1:');
    expect(shown).toContain('Packet 2:');
    expect(shown).not.toContain('Packet 3:');
    expect(shown).toContain('Capture finished, 2 packets captured.');
    expect(shown).toMatch(/^\s+0000\s+(ff|[0-9a-f]{2}) /m);
  });

  it('Ctrl+C arrête la capture', async () => {
    const { a, ports, session, type, seen, settle } = await lab();
    await type(`capture-packet interface ${ports[0]} destination terminal`);
    await run(a, 'ping -c 1 10.0.2.10');
    await settle(5);
    session.handleKey(key('c', true));
    await settle(5);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(seen()).toContain('Capture finished');
  });

  it('acl 3000 (rule permit icmp) ne retient que l\'ICMP : un ping est capturé, pas le reste', async () => {
    const { a, ports, type, seen, settle } = await lab();
    await type(`capture-packet interface ${ports[0]} acl 3000 destination terminal packet-num 1`);
    await run(a, 'ping -c 1 10.0.2.10');
    await settle();
    expect(seen()).toContain('Packet 1:');
  });

  it('time-out borne la durée', async () => {
    const { ports, session, type, seen, settle } = await lab();
    await type(`capture-packet interface ${ports[0]} destination terminal time-out 1`);
    expect(session.hasForegroundAsyncJob).toBe(true);
    await settle(200);
    expect(session.hasForegroundAsyncJob).toBe(false);
    expect(seen()).toMatch(/Capture finished, \d+ packets? captured\./);
  });

  it('une interface inconnue, une ACL absente et la destination file sont refusées', async () => {
    const { r1, ports } = await lab();
    expect(await run(r1, 'capture-packet interface Nope9/9/9 destination terminal')).toContain('Wrong parameter');
    expect(await run(r1, `capture-packet interface ${ports[0]} acl 3999 destination terminal`)).toContain('Wrong parameter');
    expect(await run(r1, `capture-packet interface ${ports[0]} destination file a.cap`)).toContain('Wrong parameter');
  });

  it('hors terminal interactif, la commande valide dit qu\'elle en demande un', async () => {
    const { r1, ports } = await lab();
    expect(await run(r1, `capture-packet interface ${ports[0]} destination terminal`)).toContain('needs an interactive session');
  });
});
