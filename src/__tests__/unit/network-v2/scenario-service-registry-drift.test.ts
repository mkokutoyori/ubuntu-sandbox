import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab { client: LinuxPC; server: LinuxServer }

const DECLARED_PORT = 8443;
const ACTUAL_PORT = 9443;

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const m = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  return { client, server };
}

async function declareService(client: LinuxPC, name: string, port: number): Promise<void> {
  const vfs = (client as unknown as { executor: { vfs: { readFile: (p: string) => string | null; writeFile: (p: string, c: string, uid: number, gid: number, umask: number) => void } } }).executor.vfs;
  const existing = vfs.readFile('/etc/services') ?? '';
  vfs.writeFile('/etc/services', `${existing}\n${name}\t\t${port}/tcp\n`, 0, 0, 0o022);
}

async function retagService(client: LinuxPC, name: string, port: number): Promise<void> {
  const vfs = (client as unknown as { executor: { vfs: { readFile: (p: string) => string | null; writeFile: (p: string, c: string, uid: number, gid: number, umask: number) => void } } }).executor.vfs;
  const existing = vfs.readFile('/etc/services') ?? '';
  const stripped = existing.split('\n').filter(l => !new RegExp(`^${name}\\s`).test(l)).join('\n');
  vfs.writeFile('/etc/services', `${stripped}\n${name}\t\t${port}/tcp\n`, 0, 0, 0o022);
}

function bindActual(server: LinuxServer, port: number): void {
  server.getTcpStack().listen(port, { onAccept: () => undefined });
  const st = (server as unknown as { executor: { socketTable: { bind: (p: 'tcp', a: string, port: number, pid?: number, name?: string) => unknown } } }).executor.socketTable;
  st.bind('tcp', '0.0.0.0', port, 4242, 'myservice');
}

async function baseFirewall(server: LinuxServer): Promise<void> {
  await server.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
}

describe('Scénario 16 — Dérive de registre de service (annonce vs réalité)', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('état 1 (cohérent): /etc/services annonce le port, le service écoute dessus, nc via nom de service réussit', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    await declareService(client, 'myapp', DECLARED_PORT);
    bindActual(server, DECLARED_PORT);
    const declared = await client.executeCommand('getent services myapp/tcp');
    expect(declared).toMatch(new RegExp(`myapp\\s+${DECLARED_PORT}/tcp`));
    const out = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(out).toMatch(/succeeded|open/i);
  });

  it('état 2 (annonce fausse — service reconfiguré, /etc/services non mis à jour): nc via nom échoue, nc direct sur port réel réussit', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    await declareService(client, 'myapp', DECLARED_PORT);
    bindActual(server, ACTUAL_PORT);
    const declared = await client.executeCommand('getent services myapp/tcp');
    expect(declared).toMatch(new RegExp(`${DECLARED_PORT}`));
    const viaName = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(viaName).toMatch(/refused|closed/i);
    const viaRealPort = await client.executeCommand(`nc -zv 10.0.0.20 ${ACTUAL_PORT}`);
    expect(viaRealPort).toMatch(/succeeded|open/i);
    const viaDeclaredPort = await client.executeCommand(`nc -zv 10.0.0.20 ${DECLARED_PORT}`);
    expect(viaDeclaredPort).toMatch(/refused|closed/i);
  });

  it('état 3 (annonce à jour, service stale — /etc/services corrigé mais processus non rechargé): nc via nom échoue toujours, nc direct sur ancien port réussit', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    const OLD = 8080;
    bindActual(server, OLD);
    await declareService(client, 'myapp', OLD);
    let viaName = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(viaName).toMatch(/succeeded|open/i);
    await retagService(client, 'myapp', ACTUAL_PORT);
    const nowDeclared = await client.executeCommand('getent services myapp/tcp');
    expect(nowDeclared).toMatch(new RegExp(`${ACTUAL_PORT}`));
    viaName = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(viaName).toMatch(/refused|closed/i);
    const viaOldPort = await client.executeCommand(`nc -zv 10.0.0.20 ${OLD}`);
    expect(viaOldPort).toMatch(/succeeded|open/i);
  });

  it('ss -tlnp sur le serveur expose la source de vérité: le port réellement actif', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    await declareService(client, 'myapp', DECLARED_PORT);
    bindActual(server, ACTUAL_PORT);
    const ss = await server.executeCommand('ss -tlnp');
    expect(ss).toMatch(new RegExp(`:${ACTUAL_PORT}`));
    expect(ss).not.toMatch(new RegExp(`:${DECLARED_PORT}\\b`));
    const declared = await client.executeCommand('getent services myapp/tcp');
    expect(declared).toMatch(new RegExp(`${DECLARED_PORT}`));
  });

  it('la signature réseau distingue les trois états: succès vs. refused vs. non-résolution', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    bindActual(server, ACTUAL_PORT);
    const noRegistry = await client.executeCommand(`nc -zv 10.0.0.20 unknownsvc`);
    expect(noRegistry).toMatch(/invalid|Name or service not known|port number invalid/i);
    await declareService(client, 'myapp', DECLARED_PORT);
    const refused = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(refused).toMatch(/refused|closed/i);
    await retagService(client, 'myapp', ACTUAL_PORT);
    const ok = await client.executeCommand(`nc -zv 10.0.0.20 myapp`);
    expect(ok).toMatch(/succeeded|open/i);
  });

  it('un audit croisé /etc/services vs ss -tlnp détecte la dérive sans ambiguïté', async () => {
    const { client, server } = await buildLab();
    await baseFirewall(server);
    await declareService(client, 'myapp', DECLARED_PORT);
    bindActual(server, ACTUAL_PORT);
    const declaredRaw = await client.executeCommand('getent services myapp/tcp');
    const declaredMatch = /myapp\s+(\d+)\/tcp/.exec(declaredRaw);
    expect(declaredMatch).not.toBeNull();
    const declared = Number(declaredMatch![1]);
    const ss = await server.executeCommand('ss -tlnp');
    const actualPorts = Array.from(ss.matchAll(/:(\d+)\b/g)).map(m => Number(m[1]));
    expect(actualPorts).toContain(ACTUAL_PORT);
    expect(actualPorts).not.toContain(declared);
    expect(declared).not.toBe(ACTUAL_PORT);
  });
});
