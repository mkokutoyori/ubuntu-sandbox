/**
 * Probes — 802.1X sur la CLI Cisco.
 *
 * `Dot1xAgent` est réel depuis longtemps : vraies rondes EAP, dorsale
 * RADIUS, et surtout `CiscoSwitch.handleFrame` qui refuse déjà de
 * commuter une trame venant d'un port non autorisé. Ce qui manquait
 * n'était pas le moteur, c'était la porte : le switch Cisco construisait
 * l'agent et n'offrait aucune commande pour l'atteindre, si bien que
 * chaque ligne `dot1x` d'un TP Catalyst revenait en `% Invalid input`.
 * La CLI Huawei, elle, le pilotait déjà.
 *
 * Ces probes tiennent les deux moitiés : la commande existe, **et** elle
 * change ce qui passe sur le fil.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

async function conf(sw: CiscoSwitch, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const l of lines) out.push(await sw.executeCommand(l));
  return out;
}

/** Deux postes sur un même switch, l'un derrière le port surveillé. */
async function lab(): Promise<{ sw: CiscoSwitch; pc1: LinuxPC; pc2: LinuxPC }> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc1 = new LinuxPC('linux-pc', 'pc1', 0, 0);
  const pc2 = new LinuxPC('linux-pc', 'pc2', 0, 0);
  pc1.powerOn(); pc2.powerOn();
  new Cable('c1').connect(sw.getPort('FastEthernet0/1')!, pc1.getPort('eth0')!);
  new Cable('c2').connect(sw.getPort('FastEthernet0/2')!, pc2.getPort('eth0')!);
  await pc1.executeCommand('sudo ip addr add 10.0.0.1/24 dev eth0');
  await pc2.executeCommand('sudo ip addr add 10.0.0.2/24 dev eth0');
  await sw.executeCommand('enable');
  return { sw, pc1, pc2 };
}

describe('Scénario 1 — la commande existe et atteint l\'agent', () => {
  it('`dot1x system-auth-control` bascule l\'état global', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show dot1x')).toContain('Sysauthcontrol              Disabled');

    await conf(sw, ['configure terminal', 'dot1x system-auth-control', 'end']);
    expect(await sw.executeCommand('show dot1x')).toContain('Sysauthcontrol              Enabled');

    await conf(sw, ['configure terminal', 'no dot1x system-auth-control', 'end']);
    expect(await sw.executeCommand('show dot1x')).toContain('Sysauthcontrol              Disabled');
  });

  it('`dot1x port-control` se lit dans `show dot1x interface`', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await conf(sw, ['configure terminal', 'dot1x system-auth-control',
      'interface FastEthernet0/1', 'dot1x pae authenticator', 'dot1x port-control auto', 'end']);

    const out = await sw.executeCommand('show dot1x interface FastEthernet0/1');
    expect(out).toContain('PortControl               = AUTO');
    expect(out).toContain('Authorized                = NO');
  });

  it('`dot1x timeout quiet-period` change réellement la temporisation du port', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    await conf(sw, ['configure terminal', 'interface FastEthernet0/1',
      'dot1x pae authenticator', 'dot1x timeout quiet-period 45', 'end']);

    // La valeur n'est pas seulement affichée : c'est celle que l'agent
    // tient pour ce port.
    expect(sw.getDot1xAgent().getPortRuntime('FastEthernet0/1')?.holdMs).toBe(45_000);
    expect(await sw.executeCommand('show dot1x interface FastEthernet0/1'))
      .toContain('QuietPeriod               = 45');
  });

  it('un port jamais configuré n\'est pas inventé', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    expect(await sw.executeCommand('show dot1x interface FastEthernet0/7'))
      .toContain('Dot1x is not enabled on the specified interface');
  });
});

describe('Scénario 2 — ce que la commande change sur le fil', () => {
  it('`port-control auto` bloque le trafic du poste non authentifié', async () => {
    const { sw, pc1 } = await lab();
    expect(await pc1.executeCommand('ping -c 1 10.0.0.2')).toContain('1 received');

    await conf(sw, ['configure terminal', 'dot1x system-auth-control',
      'interface FastEthernet0/1', 'dot1x pae authenticator', 'dot1x port-control auto', 'end']);

    // Le switch refusait déjà de commuter une trame venant d'un port non
    // autorisé ; il n'y avait simplement aucun moyen de le lui demander.
    expect(await pc1.executeCommand('ping -c 1 10.0.0.2')).toContain('0 received');
  }, 30_000);

  it('`force-authorized` laisse passer, `force-unauthorized` coupe', async () => {
    const { sw, pc1 } = await lab();
    await conf(sw, ['configure terminal', 'dot1x system-auth-control',
      'interface FastEthernet0/1', 'dot1x pae authenticator',
      'dot1x port-control force-unauthorized', 'end']);
    expect(await pc1.executeCommand('ping -c 1 10.0.0.2')).toContain('0 received');

    await conf(sw, ['configure terminal', 'interface FastEthernet0/1',
      'dot1x port-control force-authorized', 'end']);
    expect(await pc1.executeCommand('ping -c 1 10.0.0.2')).toContain('1 received');
  }, 30_000);
});

describe('Scénario 3 — ce que l\'agent ne modélise pas est refusé, pas avalé', () => {
  it('`host-mode` est refusé en nommant la raison', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    const [, , out] = await conf(sw,
      ['configure terminal', 'interface FastEthernet0/1', 'dot1x host-mode multi-host']);
    expect(out).toContain('single supplicant');
    expect(out).not.toContain('Invalid input');
  });

  it('`reauthentication` est refusée : il n\'existe pas de cycle périodique', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    const [, , out] = await conf(sw,
      ['configure terminal', 'interface FastEthernet0/1', 'dot1x reauthentication']);
    expect(out).toContain('not supported');
  });

  it('un timer inexistant est nommé plutôt que silencieusement accepté', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    const [, , out] = await conf(sw,
      ['configure terminal', 'interface FastEthernet0/1', 'dot1x timeout reauth-period 3600']);
    expect(out).toContain('reauth-period');
    expect(out).toContain('no');
  });

  it('le rôle supplicant est refusé, l\'authenticator accepté', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    const [, , sup, auth] = await conf(sw, ['configure terminal', 'interface FastEthernet0/1',
      'dot1x pae supplicant', 'dot1x pae authenticator']);
    expect(sup).toContain('authenticator role');
    expect(auth).toBe('');
  });

  it('un mode de port inconnu reste une erreur de syntaxe IOS', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
    await sw.executeCommand('enable');
    const [, , out] = await conf(sw,
      ['configure terminal', 'interface FastEthernet0/1', 'dot1x port-control bidon']);
    expect(out).toContain('% Invalid input');
  });
});
