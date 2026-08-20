/**
 * PRD-Windows-Server.md §5 P9 — NPS (RADIUS) role: `Install-WindowsFeature
 * NPAS` hosts the real RADIUS engine over genuine UDP 1812/1813. Covers
 * the `New/Get/Remove-NpsRadiusClient` + `New/Get/Remove-NpsNetworkPolicy`
 * cmdlets, `netsh nps` (NAS clients), the Security event log (accepts/
 * rejects), and the PRD's target scenario: Cisco switch 802.1X → NPS on
 * Windows Server → dynamic VLAN.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress, type EthernetFrame } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EventBus } from '@/events/EventBus';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { ETHERTYPE_EAPOL, EAPOL_PAE_GROUP_MAC, type EapolPacket } from '@/network/dot1x/types';
import { computeEapMd5Response, type EapPacket } from '@/network/radius/eap';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLab() {
  const nps = new WindowsServer('NPS1');
  const nas = new CiscoRouter('NAS');
  new Cable('a').connect(nas.getPort('GigabitEthernet0/0')!, nps.getPorts()[0]);
  nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  nps.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
  nps.setCurrentUser('Administrator');
  return { nps, nas };
}

describe('Install-WindowsFeature NPAS', () => {
  it('NPS cmdlets are "not recognized" before the role is installed', async () => {
    const { nps } = await buildLab();
    const out = await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.1 -SharedSecret shared');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('New-NpsRadiusClient / Get-NpsRadiusClient', () => {
  async function installed() {
    const lab = await buildLab();
    await run(ps(lab.nps), 'Install-WindowsFeature NPAS');
    return lab;
  }

  it('adds a NAS client and reads it back', async () => {
    const { nps } = await installed();
    await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.1 -SharedSecret shared');
    const out = await run(ps(nps), 'Get-NpsRadiusClient');
    expect(out).toContain('NAS');
    expect(out).toContain('10.0.0.1');
  });

  it('refuses a duplicate NAS client name', async () => {
    const { nps } = await installed();
    await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.1 -SharedSecret shared');
    const out = await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.99 -SharedSecret other');
    expect(out).toMatch(/already exists/i);
  });
});

describe('New-NpsNetworkPolicy / Get-NpsNetworkPolicy', () => {
  it('adds a policy and reads it back', async () => {
    const { nps } = await buildLab();
    await run(ps(nps), 'Install-WindowsFeature NPAS');
    await run(ps(nps), 'New-NpsNetworkPolicy -Name SalesPolicy -Group Sales -VlanId 200 -SessionTimeout 3600');
    const out = await run(ps(nps), 'Get-NpsNetworkPolicy');
    expect(out).toContain('SalesPolicy');
    expect(out).toContain('200');
  });
});

describe('netsh nps — NAS clients', () => {
  it('add client / show clients', async () => {
    const { nps } = await buildLab();
    await run(ps(nps), 'Install-WindowsFeature NPAS');
    const add = await nps.executeCmdCommand('netsh nps add client name="NAS" address="10.0.0.1" secret="shared"');
    expect(add).toMatch(/completed successfully/i);
    const show = await nps.executeCmdCommand('netsh nps show clients');
    expect(show).toContain('NAS');
    expect(show).toContain('10.0.0.1');
  });
});

describe('Security event log — NPS accepts/rejects (Get-WinEvent)', () => {
  it('logs Event 6272 (granted) for an accepted RADIUS authentication', async () => {
    const { nps, nas } = await buildLab();
    await run(ps(nps), 'Install-WindowsFeature NPAS');
    await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.1 -SharedSecret shared');
    await run(ps(nps), 'New-LocalUser -Name npsuser -Password "N3twork!Pass"');
    await run(ps(nps), 'New-LocalGroup -Name Sales');
    await run(ps(nps), 'Add-LocalGroupMember -Group Sales -Member npsuser');
    await run(ps(nps), 'New-NpsNetworkPolicy -Name SalesPolicy -Group Sales -VlanId 200');

    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });
    const accepted = await nas.getRadiusClient().authenticate('npsuser', 'N3twork!Pass');
    expect(accepted).toBe(true);

    const log = await run(ps(nps), 'Get-WinEvent -LogName Security | Where-Object { $_.Id -eq 6272 }');
    expect(log).toContain('6272');
  });
});

describe('PRD target scenario — Cisco switch 802.1X → NPS on Windows Server → dynamic VLAN', () => {
  function buildEapolStart(srcMac: string): EthernetFrame {
    const payload: EapolPacket = { type: 'eapol', version: 2, packetType: 'eapol-start' };
    return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
  }
  function buildEapResponseIdentity(srcMac: string, identifier: number, identity: string): EthernetFrame {
    const payload: EapolPacket = {
      type: 'eapol', version: 2, packetType: 'eap-packet',
      eap: { type: 'eap', code: 'response', identifier, eapType: 'identity', payload: identity },
    };
    return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
  }
  function buildEapResponseMd5(srcMac: string, identifier: number, responseHex: string): EthernetFrame {
    const payload: EapolPacket = {
      type: 'eapol', version: 2, packetType: 'eap-packet',
      eap: { type: 'eap', code: 'response', identifier, eapType: 'md5-challenge', md5Response: responseHex },
    };
    return { srcMAC: new MACAddress(srcMac), dstMAC: new MACAddress(EAPOL_PAE_GROUP_MAC), etherType: ETHERTYPE_EAPOL, payload };
  }
  async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('authorizes the 802.1X port and assigns the VLAN NPS returns for the user\'s group', async () => {
    const bus = new EventBus();
    const sw = new CiscoSwitch('switch-cisco', 'SW', 4);
    const supplicantSw = new CiscoSwitch('switch-cisco', 'SUP', 4);
    const nas = new CiscoRouter('NAS');
    const nps = new WindowsServer('NPS1');
    sw.setEventBus(bus); supplicantSw.setEventBus(bus); nas.setEventBus(bus); nps.setEventBus(bus);
    nps.setCurrentUser('Administrator');

    const supplicantCable = new Cable('c');
    supplicantCable.setEventBus(bus);
    supplicantCable.connect(sw.getPort('FastEthernet0/1')!, supplicantSw.getPort('FastEthernet0/1')!);
    new Cable('d').connect(nas.getPort('GigabitEthernet0/0')!, nps.getPorts()[0]);
    nas.getPort('GigabitEthernet0/0')!.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    nps.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));

    await run(ps(nps), 'Install-WindowsFeature NPAS');
    await run(ps(nps), 'New-NpsRadiusClient -Name NAS -Address 10.0.0.1 -SharedSecret shared');
    await run(ps(nps), 'New-LocalUser -Name dot1xuser -Password "D0t1xP@ss"');
    await run(ps(nps), 'New-LocalGroup -Name Sales');
    await run(ps(nps), 'Add-LocalGroupMember -Group Sales -Member dot1xuser');
    await run(ps(nps), 'New-NpsNetworkPolicy -Name SalesPolicy -Group Sales -VlanId 200');

    sw.getDot1xAgent().setSystemAuthControl(true);
    sw.getDot1xAgent().setPortMode('FastEthernet0/1', 'auto');
    sw.getDot1xAgent().setRadiusBackend(nas.getRadiusClient());
    nas.getRadiusClient().addServer('10.0.0.2', 'shared', { timeoutMs: 200, retransmit: 0 });

    const outcomes: Array<{ accepted: boolean; vlanId?: number }> = [];
    bus.subscribe('dot1x.auth.outcome', (e) => outcomes.push(e.payload));

    const supplicantMac = supplicantSw.getPort('FastEthernet0/1')!.getMAC().toString();
    let challengeEap: EapPacket | null = null;
    const unsub = bus.subscribe('cable.frame.dispatched', (e) => {
      const frame = e.payload.frame as EthernetFrame;
      if (frame.etherType !== ETHERTYPE_EAPOL) return;
      const eapol = frame.payload as EapolPacket;
      if (eapol.eap?.eapType === 'md5-challenge' && eapol.eap.code === 'request') challengeEap = eapol.eap;
    });

    supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapolStart(supplicantMac));
    const rt = sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')!;
    supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseIdentity(supplicantMac, rt.pendingEapId!, 'dot1xuser'));
    await flushMicrotasks();
    unsub();
    expect(challengeEap).not.toBeNull();
    const eap = challengeEap as unknown as EapPacket;
    const response = computeEapMd5Response(eap.identifier, 'D0t1xP@ss', eap.md5Challenge!);
    supplicantSw.getPort('FastEthernet0/1')!.sendFrame(buildEapResponseMd5(supplicantMac, eap.identifier, response));
    await flushMicrotasks();

    expect(sw.getDot1xAgent().isPortAuthorized('FastEthernet0/1')).toBe(true);
    const last = outcomes[outcomes.length - 1];
    expect(last.accepted).toBe(true);
    expect(last.vlanId).toBe(200);
  });
});
