import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function routeur() {
  const r = new CiscoRouter('R', 0, 0);
  for (const c of [
    'enable', 'configure terminal', 'interface GigabitEthernet0/1',
    'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'end',
  ]) await r.executeCommand(c);
  return r;
}

const surIface = async (r: CiscoRouter, cmds: string[]) => {
  for (const c of ['configure terminal', 'interface GigabitEthernet0/1', ...cmds, 'end']) {
    await r.executeCommand(c);
  }
};

const pimIfaces = async (r: CiscoRouter) =>
  (await r.executeCommand('show ip pim interface'))
    .split('\n').filter((l) => /GigabitEthernet/.test(l));

describe('PIM — `no ip pim …` sort bien l\'interface du protocole', () => {
  it('n\'affiche aucune interface tant que PIM n\'est pas activé', async () => {
    expect(await pimIfaces(await routeur())).toHaveLength(0);
  });

  it('affiche l\'interface une fois PIM activé', async () => {
    const r = await routeur();
    await surIface(r, ['ip pim sparse-mode']);
    const lignes = await pimIfaces(r);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('v2/sparse');
  });

  it('la retire sur `no ip pim sparse-mode`', async () => {
    const r = await routeur();
    await surIface(r, ['ip pim sparse-mode']);
    await surIface(r, ['no ip pim sparse-mode']);
    expect(await pimIfaces(r)).toHaveLength(0);
  });

  it('la retire sur `no ip pim dense-mode` et `no ip pim`', async () => {
    const dense = await routeur();
    await surIface(dense, ['ip pim dense-mode']);
    await surIface(dense, ['no ip pim dense-mode']);
    expect(await pimIfaces(dense)).toHaveLength(0);

    const nu = await routeur();
    await surIface(nu, ['ip pim sparse-dense-mode']);
    await surIface(nu, ['no ip pim']);
    expect(await pimIfaces(nu)).toHaveLength(0);
  });

  it('ne laisse pas la note « dense » derrière une interface désactivée', async () => {
    const r = await routeur();
    await surIface(r, ['ip pim dense-mode']);
    expect(await r.executeCommand('show ip pim interface')).toContain('dense mode is displayed');
    await surIface(r, ['no ip pim dense-mode']);
    expect(await r.executeCommand('show ip pim interface')).not.toContain('dense mode is displayed');
  });

  it('réactive proprement après une désactivation', async () => {
    const r = await routeur();
    await surIface(r, ['ip pim sparse-mode']);
    await surIface(r, ['no ip pim sparse-mode']);
    await surIface(r, ['ip pim sparse-mode']);
    const lignes = await pimIfaces(r);
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toContain('v2/sparse');
  });
});
