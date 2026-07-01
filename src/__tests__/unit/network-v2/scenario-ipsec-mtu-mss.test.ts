import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { TcpMssClamper, computeIpsecOverheadBytes, effectiveInnerMtu } from '@/network/ipsec/TcpMssClamper';
import type { TcpMssCarrier } from '@/network/ipsec/TcpMssClamper';

function synWithMss(mss: number | null): TcpMssCarrier {
  return {
    flags: { syn: true, ack: false, fin: false, rst: false, psh: false, urg: false },
    options: mss === null ? [] : [{ kind: 'mss', value: mss }],
  };
}

function ackNoMss(): TcpMssCarrier {
  return {
    flags: { syn: false, ack: true, fin: false, rst: false, psh: false, urg: false },
    options: [{ kind: 'mss', value: 1460 }],
  };
}

describe('Scénario 12 — MTU effectif IPsec + MSS clamping', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
  });

  describe('Overhead ESP/AH — calcul documenté', () => {
    it('ESP tunnel mode : overhead = en-tête IP externe (20) + ESP (50)', () => {
      const overhead = computeIpsecOverheadBytes({ hasESP: true, hasAH: false });
      expect(overhead).toBe(70);
    });

    it('AH tunnel mode : overhead = 20 + 24', () => {
      const overhead = computeIpsecOverheadBytes({ hasESP: false, hasAH: true });
      expect(overhead).toBe(44);
    });

    it('ESP + AH : overhead cumulé', () => {
      const overhead = computeIpsecOverheadBytes({ hasESP: true, hasAH: true });
      expect(overhead).toBe(94);
    });

    it("MTU intérieur effectif = pathMTU - overhead (1500 → 1430 en ESP)", () => {
      expect(effectiveInnerMtu(1500, { hasESP: true, hasAH: false })).toBe(1430);
    });

    it('avec un lien à MTU 1400 (ex. PPPoE), le MTU intérieur tombe à 1330', () => {
      expect(effectiveInnerMtu(1400, { hasESP: true, hasAH: false })).toBe(1330);
    });

    it("n'accepte pas un pathMTU inférieur au minimum IPv4 (576)", () => {
      expect(() => effectiveInnerMtu(500, { hasESP: true, hasAH: false }))
        .toThrow(/MTU.*below.*minimum|below minimum|576/i);
    });
  });

  describe('TcpMssClamper — sémantique', () => {
    it('un SYN avec MSS 1460 est ramené à la valeur du clamp (1390)', () => {
      const seg = synWithMss(1460);
      const r = TcpMssClamper.clamp(seg, 1390);
      expect(r.modified).toBe(true);
      expect(r.before).toBe(1460);
      expect(r.after).toBe(1390);
      const opt = seg.options?.find(o => o.kind === 'mss') as { kind: 'mss'; value: number };
      expect(opt.value).toBe(1390);
    });

    it("un SYN avec MSS déjà ≤ clamp n'est pas modifié", () => {
      const seg = synWithMss(1200);
      const r = TcpMssClamper.clamp(seg, 1390);
      expect(r.modified).toBe(false);
      expect(r.reason).toBe('already-lower');
    });

    it('un SYN sans option MSS voit une option MSS insérée', () => {
      const seg = synWithMss(null);
      const r = TcpMssClamper.clamp(seg, 1390);
      expect(r.modified).toBe(true);
      expect(r.reason).toBe('inserted');
      const opt = seg.options?.find(o => o.kind === 'mss') as { kind: 'mss'; value: number };
      expect(opt.value).toBe(1390);
    });

    it('un segment non-SYN (data / ACK) reste intact', () => {
      const seg = ackNoMss();
      const r = TcpMssClamper.clamp(seg, 1390);
      expect(r.modified).toBe(false);
      expect(r.reason).toBe('not-syn');
      const opt = seg.options?.find(o => o.kind === 'mss') as { kind: 'mss'; value: number };
      expect(opt.value).toBe(1460);
    });

    it('un maxMss invalide (≤ 0) lève une erreur explicite', () => {
      expect(() => TcpMssClamper.clamp(synWithMss(1460), 0)).toThrow(/maxMss/i);
    });
  });

  describe('Intégration Cisco IOS — ip tcp adjust-mss', () => {
    async function makeRouter(): Promise<CiscoRouter> {
      const r = new CiscoRouter('R1');
      for (const cmd of [
        'enable', 'configure terminal',
        'interface GigabitEthernet0/1',
        'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit', 'end',
      ]) await r.executeCommand(cmd);
      return r;
    }

    it('ip tcp adjust-mss <value> stocke la valeur sur l\'interface', async () => {
      const r = await makeRouter();
      for (const cmd of [
        'enable', 'configure terminal',
        'interface GigabitEthernet0/1',
        'ip tcp adjust-mss 1390', 'exit', 'end',
      ]) await r.executeCommand(cmd);
      expect(r.getInterfaceTcpAdjustMss('GigabitEthernet0/1')).toBe(1390);
    });

    it('sans ip tcp adjust-mss, la valeur retournée est null', async () => {
      const r = await makeRouter();
      expect(r.getInterfaceTcpAdjustMss('GigabitEthernet0/1')).toBeNull();
    });

    it('applyTcpMssClamp modifie uniquement les SYN sortants sur une interface configurée', async () => {
      const r = await makeRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/1');
      await r.executeCommand('ip tcp adjust-mss 1390');
      await r.executeCommand('end');
      const syn = synWithMss(1460);
      const rApplied = r.applyTcpMssClamp(syn, 'GigabitEthernet0/1');
      expect(rApplied.modified).toBe(true);
      expect(rApplied.after).toBe(1390);
      const ack = ackNoMss();
      const rAck = r.applyTcpMssClamp(ack, 'GigabitEthernet0/1');
      expect(rAck.modified).toBe(false);
    });

    it("sur une interface sans clamp configuré, applyTcpMssClamp est un no-op", async () => {
      const r = await makeRouter();
      const syn = synWithMss(1460);
      const rApplied = r.applyTcpMssClamp(syn, 'GigabitEthernet0/1');
      expect(rApplied.modified).toBe(false);
      expect(rApplied.reason).toBe('no-config');
    });

    it('no ip tcp adjust-mss efface la configuration', async () => {
      const r = await makeRouter();
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/1');
      await r.executeCommand('ip tcp adjust-mss 1390');
      await r.executeCommand('no ip tcp adjust-mss');
      await r.executeCommand('end');
      expect(r.getInterfaceTcpAdjustMss('GigabitEthernet0/1')).toBeNull();
    });
  });

  describe('Compatibilité et non-régression IPsec', () => {
    it("effectiveInnerMtu(1500, ESP) est cohérent avec le pipeline IPsec (1430)", async () => {
      const mtu = effectiveInnerMtu(1500, { hasESP: true, hasAH: false });
      expect(mtu).toBeGreaterThanOrEqual(1418);
      expect(mtu).toBeLessThanOrEqual(1440);
    });

    it("le MSS TCP recommandé sous ESP = pathMTU - overhead - 40 (headers TCP/IP)", () => {
      const inner = effectiveInnerMtu(1500, { hasESP: true, hasAH: false });
      const suggestedMss = TcpMssClamper.recommendedMssForTunnel(1500, { hasESP: true, hasAH: false });
      expect(suggestedMss).toBe(inner - 40);
      expect(suggestedMss).toBe(1390);
    });
  });
});
