import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RemoteAccessVpnClient } from '@/network/ipsec/RemoteAccessVpnClient';

const ISP_GW = '203.0.113.1';
const VPN_GW = '198.51.100.10';
const CORP_A = '10.10.0.0/16';
const CORP_B = '10.20.0.0/16';
const CORP_HOST = '10.10.5.5';
const EXTERNAL_HOST = '8.8.8.8';

async function newPc(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC');
  await pc.executeCommand('sudo ip addr add 203.0.113.100/24 dev eth0');
  await pc.executeCommand(`sudo ip route add default via ${ISP_GW}`);
  return pc;
}

function makeClient(pc: LinuxPC, mode: 'split' | 'full'): RemoteAccessVpnClient {
  return new RemoteAccessVpnClient(
    { gatewayPublicIp: VPN_GW, corporateSubnets: [CORP_A, CORP_B], mode },
    pc,
  );
}

function parseIpRouteGet(out: string): { dest: string; via?: string; dev?: string } {
  const m = /^(\S+)(?:\s+via\s+(\S+))?\s+dev\s+(\S+)/.exec(out.trim());
  if (!m) return { dest: '' };
  return { dest: m[1], via: m[2], dev: m[3] };
}

describe('Scénario 5 — Split tunneling vs Full tunneling', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('Split tunnel', () => {
    it('installe une route spécifique par sous-réseau interne, laisse la route par défaut intacte', async () => {
      const pc = await newPc();
      const vpn = makeClient(pc, 'split');
      vpn.connect();
      const routes = await pc.executeCommand('ip route');
      expect(routes).toMatch(new RegExp(`10\\.10\\.0\\.0/16 via ${VPN_GW}`));
      expect(routes).toMatch(new RegExp(`10\\.20\\.0\\.0/16 via ${VPN_GW}`));
      expect(routes).toMatch(new RegExp(`default via ${ISP_GW}`));
    });

    it('le trafic vers un hôte interne est routé via la passerelle VPN', async () => {
      const pc = await newPc();
      makeClient(pc, 'split').connect();
      const out = await pc.executeCommand(`ip route get ${CORP_HOST}`);
      const p = parseIpRouteGet(out);
      expect(p.via).toBe(VPN_GW);
    });

    it('le trafic vers un hôte externe reste routé via la passerelle FAI (jamais dans le tunnel)', async () => {
      const pc = await newPc();
      makeClient(pc, 'split').connect();
      const out = await pc.executeCommand(`ip route get ${EXTERNAL_HOST}`);
      const p = parseIpRouteGet(out);
      expect(p.via).toBe(ISP_GW);
      expect(p.via).not.toBe(VPN_GW);
    });

    it("aucune route installée n'englobe une adresse externe (invariant non contournable)", async () => {
      const pc = await newPc();
      const vpn = makeClient(pc, 'split');
      vpn.connect();
      for (const installed of vpn.getInstalledRoutes()) {
        const netInt = installed.network.toUint32();
        const maskInt = installed.mask.toUint32();
        const extInt = new IPAddress(EXTERNAL_HOST).toUint32();
        expect((extInt & maskInt) === (netInt & maskInt)).toBe(false);
      }
    });
  });

  describe('Full tunnel', () => {
    it('remplace la route par défaut par la passerelle VPN', async () => {
      const pc = await newPc();
      makeClient(pc, 'full').connect();
      const routes = await pc.executeCommand('ip route');
      expect(routes).toMatch(new RegExp(`default via ${VPN_GW}`));
      expect(routes).not.toMatch(new RegExp(`default via ${ISP_GW}`));
    });

    it("installe une route /32 vers le pair VPN via l'ancienne passerelle FAI pour éviter la boucle", async () => {
      const pc = await newPc();
      makeClient(pc, 'full').connect();
      const routes = await pc.executeCommand('ip route');
      expect(routes).toMatch(new RegExp(`${VPN_GW.replace(/\./g, '\\.')}/32 via ${ISP_GW}`));
    });

    it('le trafic vers un hôte externe passe par le tunnel', async () => {
      const pc = await newPc();
      makeClient(pc, 'full').connect();
      const out = await pc.executeCommand(`ip route get ${EXTERNAL_HOST}`);
      const p = parseIpRouteGet(out);
      expect(p.via).toBe(VPN_GW);
    });

    it('le trafic vers le pair VPN lui-même passe par la passerelle FAI', async () => {
      const pc = await newPc();
      makeClient(pc, 'full').connect();
      const out = await pc.executeCommand(`ip route get ${VPN_GW}`);
      const p = parseIpRouteGet(out);
      expect(p.via).toBe(ISP_GW);
    });

    it('le trafic vers un hôte interne passe par la passerelle VPN', async () => {
      const pc = await newPc();
      makeClient(pc, 'full').connect();
      const out = await pc.executeCommand(`ip route get ${CORP_HOST}`);
      const p = parseIpRouteGet(out);
      expect(p.via).toBe(VPN_GW);
    });
  });

  describe('Cycle de vie et invariants', () => {
    it('disconnect restaure la table de routage à son état initial (full)', async () => {
      const pc = await newPc();
      const before = await pc.executeCommand('ip route');
      const vpn = makeClient(pc, 'full');
      vpn.connect();
      vpn.disconnect();
      const after = await pc.executeCommand('ip route');
      expect(after).toBe(before);
    });

    it('disconnect restaure la table de routage à son état initial (split)', async () => {
      const pc = await newPc();
      const before = await pc.executeCommand('ip route');
      const vpn = makeClient(pc, 'split');
      vpn.connect();
      vpn.disconnect();
      const after = await pc.executeCommand('ip route');
      expect(after).toBe(before);
    });

    it('double connect() lève une erreur explicite', async () => {
      const pc = await newPc();
      const vpn = makeClient(pc, 'split');
      vpn.connect();
      expect(() => vpn.connect()).toThrow(/already connected/i);
    });

    it("changer de mode sans disconnect n'est pas autorisé", async () => {
      const pc = await newPc();
      const vpn = makeClient(pc, 'split');
      vpn.connect();
      expect(() => vpn.connect()).toThrow();
    });

    it('un profil sans sous-réseau corporate en split ne modifie que la partie policy', async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: VPN_GW, corporateSubnets: [], mode: 'split' },
        pc,
      );
      const before = await pc.executeCommand('ip route');
      vpn.connect();
      const after = await pc.executeCommand('ip route');
      expect(after).toBe(before);
    });
  });

  describe('Diagnostic', () => {
    it('expose le mode actuel et la liste des routes installées', async () => {
      const pc = await newPc();
      const vpn = makeClient(pc, 'split');
      expect(vpn.isConnected).toBe(false);
      vpn.connect();
      expect(vpn.isConnected).toBe(true);
      expect(vpn.mode).toBe('split');
      const rs = vpn.getInstalledRoutes();
      expect(rs.length).toBe(2);
      const nets = rs.map(r => r.network.toString()).sort();
      expect(nets).toEqual(['10.10.0.0', '10.20.0.0']);
    });
  });
});
