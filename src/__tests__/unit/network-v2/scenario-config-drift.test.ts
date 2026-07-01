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

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'srv', 0, 0);
  new Cable('a').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(server.getPorts()[0], sw.getPorts()[1]);
  const m = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), m);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), m);
  await server.executeCommand('iptables -A INPUT -i lo -j ACCEPT');
  await server.executeCommand('systemctl stop nginx');
  return { client, server };
}

function svcMgr(server: LinuxServer): {
  setPortOverride: (name: string, port: number, source: 'cli' | 'env' | 'config-reload', arg?: string) => { ok: boolean };
  getPortOverride: (name: string) => { port: number; source: string; cliArg?: string } | undefined;
  start: (name: string) => { ok: boolean };
  stop: (name: string) => { ok: boolean };
  status: (name: string) => { state: string; mainPid?: number } | null;
} {
  return (server as unknown as { executor: { serviceMgr: {
    setPortOverride: (name: string, port: number, source: 'cli' | 'env' | 'config-reload', arg?: string) => { ok: boolean };
    getPortOverride: (name: string) => { port: number; source: string; cliArg?: string } | undefined;
    start: (name: string) => { ok: boolean };
    stop: (name: string) => { ok: boolean };
    status: (name: string) => { state: string; mainPid?: number } | null;
  } } }).executor.serviceMgr;
}

function writeConfig(server: LinuxServer, port: number): Promise<string> {
  return server.executeCommand(`sh -c 'mkdir -p /etc/nginx && printf "http {\\n  server { listen ${port}; }\\n}\\n" > /etc/nginx/nginx.conf'`);
}

async function declaredPortFromConfig(server: LinuxServer): Promise<number | null> {
  const raw = await server.executeCommand('cat /etc/nginx/nginx.conf');
  const m = /listen\s+(\d+)/.exec(raw);
  return m ? Number(m[1]) : null;
}

describe('Scénario 12 — Dérive de configuration: port déclaré vs port bindé', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  it('sans override: port bindé = port déclaré dans le fichier de configuration', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 80);
    svcMgr(server).start('nginx');
    const declared = await declaredPortFromConfig(server);
    const ss = await server.executeCommand('ss -tlnp');
    expect(declared).toBe(80);
    expect(ss).toMatch(/:80/);
  });

  it('override CLI: le service bind le port CLI, pas celui du fichier', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).setPortOverride('nginx', 9090, 'cli', '-p 9090');
    svcMgr(server).start('nginx');
    const declared = await declaredPortFromConfig(server);
    const ss = await server.executeCommand('ss -tlnp');
    expect(declared).toBe(8080);
    expect(ss).toMatch(/:9090/);
    expect(ss).not.toMatch(/:8080/);
  });

  it('/proc/<pid>/cmdline reflète l\'argument CLI qui a prévalu sur le fichier', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).setPortOverride('nginx', 9090, 'cli', '-p 9090');
    svcMgr(server).start('nginx');
    const pid = svcMgr(server).status('nginx')?.mainPid;
    expect(pid).toBeGreaterThan(0);
    const cmd = await server.executeCommand(`cat /proc/${pid}/cmdline`);
    expect(cmd).toMatch(/9090/);
    expect(cmd).toMatch(/-p/);
  });

  it('/var/log/messages loggue la source de configuration effectivement appliquée (cli|env|config-reload)', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).setPortOverride('nginx', 9090, 'env', '-p 9090');
    svcMgr(server).start('nginx');
    const log = await server.executeCommand('cat /var/log/messages');
    expect(log).toMatch(/nginx\.service: bound port 9090 \(source: env\)/);
  });

  it('nc -zv sur le port déclaré (8080) échoue, sur le port réel (9090) réussit', async () => {
    const { client, server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).setPortOverride('nginx', 9090, 'cli', '-p 9090');
    svcMgr(server).start('nginx');
    server.getTcpStack().listen(9090, { onAccept: () => undefined });
    const ok = await client.executeCommand('nc -zv 10.0.0.20 9090');
    expect(ok).toMatch(/succeeded|open/i);
    const ko = await client.executeCommand('nc -zv 10.0.0.20 8080');
    expect(ko).toMatch(/refused|timed out/i);
  });

  it('config stale: modifier /etc/nginx/nginx.conf sans reload ne change PAS le port bindé', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).start('nginx');
    const ssBefore = await server.executeCommand('ss -tlnp');
    expect(ssBefore).toMatch(/:80/);
    await writeConfig(server, 8080);
    const declaredAfter = await declaredPortFromConfig(server);
    const ssAfter = await server.executeCommand('ss -tlnp');
    expect(declaredAfter).toBe(8080);
    expect(ssAfter).toMatch(/:80/);
    expect(ssAfter).not.toMatch(/:8080/);
  });

  it('la source du port peut être remontée à posteriori: getPortOverride() rend la source', async () => {
    const { server } = await buildLab();
    svcMgr(server).setPortOverride('nginx', 9090, 'cli', '-p 9090');
    svcMgr(server).start('nginx');
    const meta = svcMgr(server).getPortOverride('nginx');
    expect(meta).toBeDefined();
    expect(meta!.port).toBe(9090);
    expect(meta!.source).toBe('cli');
    expect(meta!.cliArg).toBe('-p 9090');
  });

  it('divergence audit: port déclaré ≠ port réel est détectable en croisant fichier de conf et ss -tlnp', async () => {
    const { server } = await buildLab();
    await writeConfig(server, 8080);
    svcMgr(server).setPortOverride('nginx', 9090, 'cli', '-p 9090');
    svcMgr(server).start('nginx');
    const declared = await declaredPortFromConfig(server);
    const ss = await server.executeCommand('ss -tlnp');
    const actualPorts = Array.from(ss.matchAll(/:(\d+)/g)).map(m => Number(m[1]));
    expect(actualPorts).toContain(9090);
    expect(declared).toBe(8080);
    expect(declared).not.toBe(9090);
  });
});
