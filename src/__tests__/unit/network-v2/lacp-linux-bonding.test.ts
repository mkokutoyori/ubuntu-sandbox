/**
 * Le bonding Linux, mesure contre la source du noyau : `bond_procfs.c`
 * pour le rendu de `/proc/net/bonding`, `bond_main.c` pour les messages,
 * `bond_options.c` pour les noms de modes et de politiques de hachage.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import {
  renderProcNetBonding, defaultBondOptions, BOND_MODES, XMIT_HASH_POLICIES,
  bondModeDescription, modeUsesXmitHash, LinuxBond,
} from '@/network/devices/linux/net/LinuxBonding';

interface Cmd { executeCommand(cmd: string): Promise<string> }
async function taper(d: Cmd, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = await d.executeCommand(c);
  return last;
}

const SW_PORTS = ['FastEthernet0/1', 'FastEthernet0/2'];
const LACP_PERIODIC_MS = 35_000;

async function laboBond(mode = '802.3ad', nbNics = 2) {
  const srv = new LinuxServer('linux-server', 'srv', 0, 0);
  const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
  const nics = srv.getPorts().slice(0, nbNics).map((p) => p.getName());
  const cables = nics.map((n, i) => {
    const c = new Cable(`c${i}`);
    c.connect(srv.getPort(n)!, sw.getPort(SW_PORTS[i])!);
    return c;
  });
  await taper(sw, ['enable', 'configure terminal']);
  for (const n of SW_PORTS.slice(0, nbNics)) {
    await taper(sw, [`interface ${n}`, 'channel-group 1 mode active', 'exit']);
  }
  await sw.executeCommand('end');
  await taper(srv, ['ip link add bond0 type bond',
    `ip link set bond0 type bond mode ${mode} miimon 100`]);
  for (const n of nics) await srv.executeCommand(`ip link set ${n} master bond0`);
  await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
  return { srv, sw, nics, cables };
}

describe('le module bonding est celui de l\'image', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('`modprobe bonding` reussit', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    expect(await srv.executeCommand('modprobe bonding')).toBe('');
  });

  it('`lsmod` le montre avec sa taille', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await srv.executeCommand('modprobe bonding');
    expect(await srv.executeCommand('lsmod')).toMatch(/^bonding\s+\d+/m);
  });

  it('`modinfo bonding` decrit le pilote et ses parametres', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const out = await srv.executeCommand('modinfo bonding');
    expect(out).toContain('Ethernet Channel Bonding Driver');
    expect(out).toContain('parm:');
    expect(out).toMatch(/mode:.*802\.3ad/);
  });

  it('`ip link add … type bond` charge le module tout seul', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    expect(await srv.executeCommand('ip link add bond0 type bond')).toBe('');
    expect(await srv.executeCommand('lsmod')).toContain('bonding');
  });

  it('creer deux fois le meme bond echoue comme le noyau', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await srv.executeCommand('ip link add bond0 type bond');
    expect(await srv.executeCommand('ip link add bond0 type bond'))
      .toBe('RTNETLINK answers: File exists');
  });
});

describe('les options du bond suivent bond_options.c', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  });

  it('les sept modes du pilote sont acceptes par leur nom', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await srv.executeCommand('ip link add bond0 type bond');
    for (const m of BOND_MODES) {
      expect(await srv.executeCommand(`ip link set bond0 type bond mode ${m}`), m).toBe('');
    }
  });

  it('les modes sont aussi acceptes par leur numero, dans l\'ordre du pilote', () => {
    const bond = new LinuxBond('bond0');
    expect(bond.setOption('mode', '4')).toBe(true);
    expect(bond.options.mode).toBe('802.3ad');
    expect(bond.setOption('mode', '1')).toBe(true);
    expect(bond.options.mode).toBe('active-backup');
  });

  it('un mode inconnu est refuse', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await srv.executeCommand('ip link add bond0 type bond');
    expect(await srv.executeCommand('ip link set bond0 type bond mode zorglub'))
      .toContain('is wrong');
  });

  it('les six politiques de hachage du pilote sont acceptees', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await srv.executeCommand('ip link add bond0 type bond');
    for (const p of XMIT_HASH_POLICIES) {
      expect(await srv.executeCommand(
        `ip link set bond0 type bond xmit_hash_policy ${p}`), p).toBe('');
    }
  });

  it('`lacp_rate` accepte fast et slow, et refuse le reste', () => {
    const bond = new LinuxBond('bond0');
    expect(bond.setOption('lacp_rate', 'fast')).toBe(true);
    expect(bond.options.lacpRate).toBe('fast');
    expect(bond.setOption('lacp_rate', 'slow')).toBe(true);
    expect(bond.setOption('lacp_rate', 'rapide')).toBe(false);
  });
});

describe('/proc/net/bonding rend ce que bond_procfs.c ecrit', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('l\'en-tete porte la version du NOYAU, pas une constante', async () => {
    const { srv } = await laboBond();
    const release = (await srv.executeCommand('uname -r')).trim();
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain(`Ethernet Channel Bonding Driver: v${release}`);
  }, 30_000);

  it('le mode est rendu par sa description longue', async () => {
    const { srv } = await laboBond();
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Bonding Mode: IEEE 802.3ad Dynamic link aggregation');
  }, 30_000);

  it('la politique de hachage porte son index, comme le pilote', async () => {
    const { srv } = await laboBond();
    await srv.executeCommand('ip link set bond0 type bond xmit_hash_policy layer3+4');
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('Transmit Hash Policy: layer3+4 (1)');
  }, 30_000);

  it('le bloc 802.3ad porte les six champs du pilote', async () => {
    const { srv } = await laboBond();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out).toContain('802.3ad info');
    expect(out).toContain('LACP active: on');
    expect(out).toMatch(/LACP rate: (slow|fast)/);
    expect(out).toContain('Min links: 0');
    expect(out).toContain('Aggregator selection policy (ad_select): stable');
    expect(out).toMatch(/System priority: \d+/);
    expect(out).toMatch(/System MAC address: ([0-9a-f]{2}:){5}[0-9a-f]{2}/);
  }, 30_000);

  it('chaque esclave porte les champs de bond_info_show_slave', async () => {
    const { srv, nics } = await laboBond();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    for (const n of nics) {
      expect(out, n).toContain(`Slave Interface: ${n}`);
    }
    expect(out).toMatch(/MII Status: up/);
    expect(out).toMatch(/Speed: \d+ Mbps/);
    expect(out).toMatch(/Duplex: (full|half)/);
    expect(out).toContain('Link Failure Count: 0');
    expect(out).toMatch(/Permanent HW addr: ([0-9a-f]{2}:){5}[0-9a-f]{2}/);
    expect(out).toContain('Slave queue ID: 0');
  }, 30_000);

  it('un bond sans esclave n\'a pas d\'agregateur, et le DIT', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode 802.3ad']);
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('bond bond0 has no active aggregator');
  });

  it('un mode sans hachage ne rend PAS la ligne de politique', () => {
    const vue = renderProcNetBonding({
      name: 'bond0',
      options: { ...defaultBondOptions(), mode: 'active-backup' },
      carrier: true, systemMac: '00:11:22:33:44:55', aggregator: null, slaves: [],
    }, '6.1.0');
    expect(vue).not.toContain('Transmit Hash Policy');
    expect(vue).toContain('Bonding Mode: fault-tolerance (active-backup)');
  });

  it('les descriptions de mode sont celles de bond_mode_name', () => {
    expect(bondModeDescription('balance-rr')).toBe('load balancing (round-robin)');
    expect(bondModeDescription('802.3ad')).toBe('IEEE 802.3ad Dynamic link aggregation');
    expect(bondModeDescription('balance-alb')).toBe('adaptive load balancing');
    expect(modeUsesXmitHash('802.3ad')).toBe(true);
    expect(modeUsesXmitHash('active-backup')).toBe(false);
  });
});

describe('un bond Linux negocie VRAIMENT avec un switch Cisco', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('le switch bundle les deux liens face au serveur', async () => {
    const { sw } = await laboBond();
    const out = await sw.executeCommand('show etherchannel summary');
    expect(out).toContain('Fa0/1(P)');
    expect(out).toContain('Fa0/2(P)');
  }, 30_000);

  it('le serveur nomme le switch comme partenaire de son agregateur', async () => {
    const { srv, sw } = await laboBond();
    const sysIdSw = (await sw.executeCommand('show lacp sys-id')).split(',')[1].trim();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out).toContain('Active Aggregator Info:');
    expect(out).toContain('\tNumber of ports: 2');
    expect(out).toContain(`\tPartner Mac Address: ${sysIdSw}`);
  }, 30_000);

  it('chaque esclave porte son bloc actor ET son bloc partner', async () => {
    const { srv } = await laboBond();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out).toContain('details actor lacp pdu:');
    expect(out).toContain('details partner lacp pdu:');
    expect(out).toMatch(/details partner lacp pdu:\n {4}system priority: \d+/);
  }, 30_000);

  it('l\'etat de port annonce est 61 — Activity|Timeout|Aggregation|Sync|Collecting|Distributing', async () => {
    const { srv } = await laboBond();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out).toMatch(/details actor lacp pdu:[\s\S]*?port state: 61/);
  }, 30_000);

  it('un esclave agrege porte un Aggregator ID, pas N/A', async () => {
    const { srv } = await laboBond();
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out).not.toContain('Aggregator ID: N/A');
    expect(out).toMatch(/Aggregator ID: \d+/);
  }, 30_000);

  it('en mode active-backup le serveur n\'emet AUCUNE LACPDU', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    const sw = new CiscoSwitch('switch-cisco', 'SW', 24, 300, 0);
    const nics = srv.getPorts().slice(0, 2).map((p) => p.getName());
    nics.forEach((n, i) => {
      new Cable(`c${i}`).connect(srv.getPort(n)!, sw.getPort(SW_PORTS[i])!);
    });
    let emises = 0;
    srv.getBus().subscribe('port.frame.tx-requested', (e: unknown) => {
      const f = (e as { payload?: { frame?: { payload?: { type?: string } } } })
        .payload?.frame;
      if (f?.payload?.type === 'lacp') emises += 1;
    });
    await taper(srv, ['ip link add bond0 type bond',
      'ip link set bond0 type bond mode active-backup miimon 100']);
    for (const n of nics) await srv.executeCommand(`ip link set ${n} master bond0`);
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    expect(emises).toBe(0);
  }, 30_000);
});

describe('le bond vit : esclaves, porteuse, journal', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('`ip link show` marque chaque esclave `master bond0`', async () => {
    const { srv, nics } = await laboBond();
    const out = await srv.executeCommand('ip link show');
    for (const n of nics) {
      expect(out, n).toMatch(new RegExp(`${n}:.*master bond0`));
    }
  }, 30_000);

  it('le journal du noyau porte le message d\'asservissement du pilote', async () => {
    const { srv, nics } = await laboBond();
    const out = await srv.executeCommand('dmesg');
    expect(out).toContain(`bond0: (slave ${nics[0]}): Enslaving as an active interface with an up link`);
    expect(out).toContain(`bond0: (slave ${nics[1]}): Enslaving as a backup interface with an up link`);
  }, 30_000);

  it('`ip link set … nomaster` retire l\'esclave et le journalise', async () => {
    const { srv, nics } = await laboBond();
    expect(await srv.executeCommand(`ip link set ${nics[0]} nomaster`)).toBe('');
    expect(await srv.executeCommand('ip link show'))
      .not.toMatch(new RegExp(`${nics[0]}:.*master bond0`));
    expect(await srv.executeCommand('dmesg'))
      .toContain(`bond0: (slave ${nics[0]}): Releasing backup interface`);
  }, 30_000);

  it('un esclave retire quitte aussi /proc/net/bonding', async () => {
    const { srv, nics } = await laboBond();
    await srv.executeCommand(`ip link set ${nics[0]} nomaster`);
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .not.toContain(`Slave Interface: ${nics[0]}`);
  }, 30_000);

  it('asservir deux fois la meme carte est refuse', async () => {
    const { srv, nics } = await laboBond();
    expect(await srv.executeCommand(`ip link set ${nics[0]} master bond0`))
      .toContain('Device already enslaved');
  }, 30_000);

  it('asservir a un bond qui n\'existe pas est refuse', async () => {
    const srv = new LinuxServer('linux-server', 'srv', 0, 0);
    expect(await srv.executeCommand('ip link set eth0 master bond9'))
      .toContain('Not a valid bond');
  });

  it('couper un cable laisse le bond porteur par l\'autre lien', async () => {
    const { srv, cables } = await laboBond();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await srv.executeCommand('cat /proc/net/bonding/bond0'))
      .toContain('MII Status: up');
  }, 30_000);

  it('couper TOUS les cables fait tomber la porteuse du bond', async () => {
    const { srv, cables } = await laboBond();
    for (const c of cables) c.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    const out = await srv.executeCommand('cat /proc/net/bonding/bond0');
    expect(out.split('\n').find((l) => l.startsWith('MII Status:'))).toBe('MII Status: down');
  }, 30_000);
});

describe('un bond PORTE le trafic', () => {
  beforeEach(() => {
    resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  async function laboAvecPair() {
    const { srv, sw, nics, cables } = await laboBond();
    const pair = new LinuxPC('linux-pc', 'pair', 0, 0);
    pair.powerOn();
    const c = new Cable('cpair');
    c.connect(pair.getPorts()[0], sw.getPort('FastEthernet0/5')!);
    await srv.executeCommand('ip addr add 10.9.0.1/24 dev bond0');
    await pair.executeCommand('ip addr add 10.9.0.2/24 dev eth0');
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    return { srv, sw, pair, nics, cables };
  }

  it('un ping traverse le bond', async () => {
    const { srv } = await laboAvecPair();
    vi.useRealTimers();
    expect(await srv.executeCommand('ping -c 2 10.9.0.2')).toMatch(/, 0% packet loss/);
  }, 30_000);

  it('la trame sort par un MEMBRE, jamais par le bond lui-meme', async () => {
    const { srv, nics } = await laboAvecPair();
    const vus: string[] = [];
    srv.attachCapture((t) => { if (t.direction === 'out') vus.push(t.iface); });
    vi.useRealTimers();
    await srv.executeCommand('ping -c 2 10.9.0.2');
    expect(vus.length).toBeGreaterThan(0);
    expect(vus).not.toContain('bond0');
    expect(vus.every((n) => nics.includes(n))).toBe(true);
  }, 30_000);

  it('la reponse arrivee sur un membre est LIVREE au bond', async () => {
    const { srv, pair } = await laboAvecPair();
    vi.useRealTimers();
    expect(await pair.executeCommand('ping -c 2 10.9.0.1')).toMatch(/, 0% packet loss/);
    expect(await srv.executeCommand('ip neigh')).toContain('10.9.0.2');
  }, 30_000);

  it('un seul lien survivant porte encore le trafic', async () => {
    const { srv, cables } = await laboAvecPair();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(LACP_PERIODIC_MS);
    vi.useRealTimers();
    expect(await srv.executeCommand('ping -c 2 10.9.0.2')).toMatch(/, 0% packet loss/);
  }, 30_000);

  it('un esclave porte l\'adresse du bond, comme le fait bond_enslave', async () => {
    const { srv, nics } = await laboBond();
    const bond = srv.getPort('bond0')!.getMAC().toString();
    for (const n of nics) expect(srv.getPort(n)!.getMAC().toString()).toBe(bond);
  }, 30_000);

  it('liberer un esclave lui rend son adresse d\'usine', async () => {
    const { srv, nics } = await laboBond();
    const avant = srv.getPort(nics[1])!.getMAC().toString();
    await srv.executeCommand(`ip link set ${nics[1]} nomaster`);
    expect(srv.getPort(nics[1])!.getMAC().toString()).not.toBe(avant);
    expect(srv.getPort(nics[1])!.getMAC().toString())
      .not.toBe(srv.getPort('bond0')!.getMAC().toString());
  }, 30_000);

  it('le noyau journalise la chute d\'un lien avec ses propres mots', async () => {
    const { srv, cables } = await laboBond();
    cables[0].disconnect();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await srv.executeCommand('dmesg'))
      .toContain('bond0: (slave eth0): link status definitely down, disabling slave');
  }, 30_000);
});
