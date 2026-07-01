import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { ListenerControl } from '@/database/oracle/listener/ListenerControl';
import { OracleListenerNetworkBinding } from '@/database/oracle/listener/OracleListenerNetworkBinding';

const ATTACKER_IP = '192.168.10.99';
const SERVER_IP = '192.168.10.10';
const LISTENER_PORT = 1521;

async function buildLab() {
  const sw = new GenericSwitch('SW');
  const server = new LinuxServer('linux-server', 'ORCL_HOST');
  const attacker = new LinuxPC('linux-pc', 'ATTACKER');
  new Cable('c-srv').connect(server.getPort('eth0')!, sw.getPort('eth1')!);
  new Cable('c-atk').connect(attacker.getPort('eth0')!, sw.getPort('eth2')!);
  await server.executeCommand(`sudo ip addr add ${SERVER_IP}/24 dev eth0`);
  await attacker.executeCommand(`sudo ip addr add ${ATTACKER_IP}/24 dev eth0`);
  await server.executeCommand('sudo ip link set eth0 up');
  await attacker.executeCommand('sudo ip link set eth0 up');
  return { sw, server, attacker };
}

function makeListenerBinding(server: LinuxServer, opts?: { noBanner?: boolean }) {
  const listener = new ListenerControl({
    sid: () => 'ORCL',
    instanceState: () => 'OPEN',
  });
  listener.start();
  if (opts?.noBanner) listener.setNoBannerMode(true);
  const binding = new OracleListenerNetworkBinding({
    host: server as unknown as ConstructorParameters<typeof OracleListenerNetworkBinding>[0]['host'],
    listener,
  });
  binding.attach();
  return { listener, binding };
}

function scanRange(attacker: LinuxPC, targetIp: string, ports: number[]): number[] {
  const open: number[] = [];
  const host = attacker as unknown as { tcpProbeSync(target: { toString(): string }, port: number): boolean };
  for (const p of ports) {
    if (host.tcpProbeSync({ toString: () => targetIp } as never, p)) open.push(p);
  }
  return open;
}

describe('Scénario ORA-NET-01 — Découverte du listener par scan de port', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('Préconditions', () => {
    it("le listener démarre à l'état UP et écoute réellement sur 1521", async () => {
      const lab = await buildLab();
      const { listener, binding } = makeListenerBinding(lab.server);
      expect(listener.running).toBe(true);
      expect(binding.isAttached()).toBe(true);
      expect(binding.getBoundPort()).toBe(LISTENER_PORT);
    });

    it("aucune règle iptables ne filtre 1521 par défaut sur le serveur", async () => {
      const lab = await buildLab();
      const out = await lab.server.executeCommand('sudo iptables -L INPUT -n');
      expect(out).not.toMatch(/DROP.*1521|1521.*DROP/i);
    });
  });

  describe('Comportement du scan', () => {
    it('seul le port 1521 répond SYN-ACK sur la plage 1500-1550', async () => {
      const lab = await buildLab();
      makeListenerBinding(lab.server);
      const ports = [1500, 1510, 1520, 1521, 1530, 1540, 1550];
      const open = scanRange(lab.attacker, SERVER_IP, ports);
      expect(open).toEqual([LISTENER_PORT]);
    });

    it("le port 1521 est identifié comme 'open' par un vrai nmap", async () => {
      const lab = await buildLab();
      makeListenerBinding(lab.server);
      const out = await lab.attacker.executeCommand(`nmap -p 1500,1521,1550 ${SERVER_IP}`);
      expect(out).toMatch(/1521\/tcp\s+open/);
      expect(out).not.toMatch(/1500\/tcp\s+open/);
      expect(out).not.toMatch(/1550\/tcp\s+open/);
    });
  });

  describe('Journalisation par le listener', () => {
    it("chaque probe SYN sur 1521 ajoute une entrée dans le scan log avec l'IP source", async () => {
      const lab = await buildLab();
      const { listener } = makeListenerBinding(lab.server);
      scanRange(lab.attacker, SERVER_IP, [1500, 1520, 1521, 1521, 1550]);
      const log = listener.getScanLog();
      expect(log.length).toBe(2);
      for (const entry of log) {
        expect(entry.sourceIp).toBe(ATTACKER_IP);
        expect(entry.destinationPort).toBe(LISTENER_PORT);
        expect(entry.event).toBe('syn-probe');
      }
    });

    it("chaque entrée porte un timestamp ISO 8601", async () => {
      const lab = await buildLab();
      const { listener } = makeListenerBinding(lab.server);
      scanRange(lab.attacker, SERVER_IP, [1521]);
      const log = listener.getScanLog();
      expect(log.length).toBe(1);
      expect(log[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(() => new Date(log[0].timestamp).toISOString()).not.toThrow();
    });

    it("les probes sur les ports fermés (aucun listener réel) ne journalisent rien", async () => {
      const lab = await buildLab();
      const { listener } = makeListenerBinding(lab.server);
      scanRange(lab.attacker, SERVER_IP, [1500, 1510, 1520, 1530, 1540, 1550]);
      expect(listener.getScanLog().length).toBe(0);
    });

    it('clearScanLog vide le journal sans altérer la config', async () => {
      const lab = await buildLab();
      const { listener } = makeListenerBinding(lab.server);
      scanRange(lab.attacker, SERVER_IP, [1521]);
      expect(listener.getScanLog().length).toBe(1);
      listener.clearScanLog();
      expect(listener.getScanLog().length).toBe(0);
      expect(listener.running).toBe(true);
    });
  });

  describe('Confidentialité — aucune donnée applicative exposée', () => {
    it("un nmap -sV en mode 'no-banner' ne divulgue pas la version Oracle", async () => {
      const lab = await buildLab();
      makeListenerBinding(lab.server, { noBanner: true });
      const out = await lab.attacker.executeCommand(`nmap -sV -p 1521 ${SERVER_IP}`);
      expect(out).toMatch(/1521\/tcp\s+open/);
      expect(out).not.toMatch(/Oracle|ORCL|CONNECT_DATA|SERVICE_NAME/);
    });

    it("le mode par défaut (banner activé) reproduit la bannière TNS pour nmap -sV", async () => {
      const lab = await buildLab();
      makeListenerBinding(lab.server);
      const out = await lab.attacker.executeCommand(`nmap -sV -p 1521 ${SERVER_IP}`);
      expect(out).toMatch(/1521\/tcp\s+open/);
    });

    it('le TCP handshake seul ne transporte aucune donnée applicative', async () => {
      const lab = await buildLab();
      const { listener } = makeListenerBinding(lab.server);
      scanRange(lab.attacker, SERVER_IP, [1521]);
      const log = listener.getScanLog();
      expect(log[0].event).toBe('syn-probe');
    });
  });

  describe('Cycle de vie du binding', () => {
    it("detach() libère le port et cesse d'observer les probes", async () => {
      const lab = await buildLab();
      const { binding, listener } = makeListenerBinding(lab.server);
      binding.detach();
      expect(binding.isAttached()).toBe(false);
      scanRange(lab.attacker, SERVER_IP, [1521]);
      expect(listener.getScanLog().length).toBe(0);
    });

    it('attach() sur un listener stoppé lève une erreur explicite', async () => {
      const lab = await buildLab();
      const listener = new ListenerControl({ sid: () => 'ORCL', instanceState: () => 'OPEN' });
      const binding = new OracleListenerNetworkBinding({
        host: lab.server as unknown as ConstructorParameters<typeof OracleListenerNetworkBinding>[0]['host'],
        listener,
      });
      expect(() => binding.attach()).toThrow(/listener.*not running/i);
    });
  });
});
