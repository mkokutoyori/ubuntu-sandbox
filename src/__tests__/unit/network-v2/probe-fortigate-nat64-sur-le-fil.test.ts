/**
 * FortiGate : NAT64 par politique (`set nat64 enable`, FortiOS 7.6.7 CLI Reference, firewall policy)
 * et par pool d'adresses (`set nat64 enable` de `config firewall ippool`), avec de vraies trames :
 * un hote IPv6 seul traverse le pare-feu jusqu'a un serveur IPv4 par le prefixe 64:ff9b::/96.
 *
 * Mesure avant correction : `nat64` etait declare « non evalue » dans la politique et absent du pool ;
 * la politique l'acceptait puis ne traduisait rien, le paquet IPv6 vers 64:ff9b::/96 n'avait pas de
 * route. Ce qui est evalue : la politique choisit (interfaces, adresses IPv6, service, action) et
 * porte `nat64` + `poolname` ; le pool porte `nat64` ; sans l'un des trois, le paquet est jete.
 *
 * Le prefixe est celui de `config system nat64` / `set nat64-prefix` (FortiOS 6.0 CLI Reference, seule
 * reference disponible ici qui le documente : « must be ::/96, default = 64:ff9b::/96 ») ; il vaut
 * 64:ff9b::/96 tant qu'il n'est pas change, et tout prefixe qui n'est pas un /96 est refuse. Le serveur
 * est dans 11.0.0.0/8 parce que le prefixe bien connu refuse de representer les plages de
 * documentation (RFC 6052 §3.1).
 *
 * Un echo de 3000 octets (fragments traduits dans les deux sens, refragmentes au retour pour tenir dans le
 * MTU IPv6) est ajoute ; il tombe avant.
 *
 * Prefixes secondaires (`secondary-prefix-status` et `config secondary-prefix`, memes pages de la reference
 * 6.0, longueurs libres) : 3 cas ajoutes, 2 tombent avant (traduction par le prefixe secondaire, et le
 * prefixe principal qui continue de servir a cote) ; le refus quand le statut est `disable` passe dans les
 * deux etats et est borne par le premier cas.
 *
 * Redefinir un `address6` existant (`edit NAT64NET` puis `set ip6`) ne changeait pas l'objet effectif : le
 * magasin refusait le doublon en silence, la politique continuait de viser l'ancien prefixe. Corrige par
 * `upsertAddress`, ce que le cas du prefixe configurable exerce.
 *
 * Cas ajoutes pour le prefixe configurable : 2 tombent avant (traduction vers un prefixe propre a
 * l'operateur, et le prefixe bien connu qui cesse de traduire une fois remplace) ; le refus d'un /64
 * passe dans les deux etats car la commande etait deja inconnue (temoin de refus, borne par le cas qui
 * traduit).
 *
 * Avec src remis avant la correction, les 2 cas de traduction tombent ; 4 passent dans les deux etats :
 * le temoin (le serveur repond en IPv4 a un hote du segment) et les trois refus (sans nat64 dans la
 * politique, pool qui n'est pas un pool NAT64, politique qui refuse), que l'absence de traduction
 * satisfait aussi ; ils bornent les cas qui traduisent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Nat64Prefix } from '@/network/nat/nat64/Nat64Prefix';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const SERVER_V6 = '64:ff9b::b01:105';

type Cli = { executeCommand(c: string): Promise<string> };

async function run(device: Cli, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

const ADDRESSES = [
  'config firewall address6', 'edit V6NET', 'set ip6 2001:db8:1::/64', 'next',
  'edit NAT64NET', 'set ip6 64:ff9b::/96', 'next', 'end',
];

const POOL = ['config firewall ippool', 'edit NAT64POOL', 'set type overload', 'set startip 11.1.1.8', 'set endip 11.1.1.8', 'set nat64 enable', 'next', 'end'];

const policy = (extra: readonly string[]) => [
  'config firewall policy', 'edit 1', 'set name nat64', 'set srcintf port1', 'set dstintf wan1', 'set action accept',
  'set srcaddr6 V6NET', 'set dstaddr6 NAT64NET', 'set service ALL', ...extra, 'next', 'end',
];

async function lab(config: readonly string[]) {
  const sw6 = new GenericSwitch('switch-generic', 'sw6', 8, 0, 0);
  const sw4 = new GenericSwitch('switch-generic', 'sw4', 8, 0, 0);
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli & { getPort(n: string): unknown };
  const pc = new LinuxPC('linux-pc', 'V6ONLY', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV4', 0, 0);
  new Cable('1').connect(pc.getPorts()[0], sw6.getPorts()[0]);
  new Cable('2').connect(sw6.getPorts()[7], fw.getPort('port1') as never);
  new Cable('3').connect(fw.getPort('wan1') as never, sw4.getPorts()[0]);
  new Cable('4').connect(srv.getPorts()[0], sw4.getPorts()[1]);
  srv.getPorts()[0].configureIP(new IPAddress('11.1.1.5'), new SubnetMask('255.255.255.240'));
  srv.setDefaultGateway(new IPAddress('11.1.1.2'));
  await srv.executeCommand('systemctl start nginx');
  await run(fw, [
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.9.9.1 255.255.255.0',
    'config ipv6', 'set ip6-address 2001:db8:1::1/64', 'end', 'next',
    'edit wan1', 'set mode static', 'set ip 11.1.1.2 255.255.255.240', 'set allowaccess ping', 'next', 'end',
    ...ADDRESSES, ...config,
  ]);
  await pc.executeCommand('ip -6 addr add 2001:db8:1::10/64 dev eth0');
  await pc.executeCommand('ip -6 route add default via 2001:db8:1::1');
  return { fw, pc, srv };
}

const fetch = (pc: Cli) => pc.executeCommand(`curl -s -m 5 'http://[${SERVER_V6}]/'`);

describe('FortiGate NAT64', () => {
  it('witness: the server answers a request that arrives in IPv4 on its own segment', async () => {
    const { fw } = await lab([]);
    expect(await fw.executeCommand('execute ping 11.1.1.5')).toMatch(/1 packets received|bytes from 11\.1\.1\.5/);
  });

  it('translates for a policy with nat64 and a nat64 pool: the page crosses the firewall', async () => {
    const { pc, srv } = await lab([...POOL, ...policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL'])]);
    expect(await fetch(pc)).toMatch(/nginx/i);
    expect(await srv.executeCommand('arp -n')).toContain('11.1.1.2');
  });

  it('answers a ping to the embedded address', async () => {
    const { pc } = await lab([...POOL, ...policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL'])]);
    expect(await pc.executeCommand(`ping -6 -c 2 ${SERVER_V6}`)).toContain('2 received');
  });

  it('answers an echo larger than the link MTU, fragmented in both directions', async () => {
    const { pc } = await lab([...POOL, ...policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL'])]);
    expect(await pc.executeCommand(`ping -6 -c 1 -s 3000 ${SERVER_V6}`)).toContain('1 received');
  }, 30000);

  it('drops the flow when the policy that matches does not carry nat64', async () => {
    const { pc } = await lab([...POOL, ...policy(['set ippool enable', 'set poolname NAT64POOL'])]);
    expect(await fetch(pc)).not.toMatch(/nginx/i);
  });

  it('drops the flow when the pool is not a nat64 pool', async () => {
    const plain = POOL.filter((line) => line !== 'set nat64 enable');
    const { pc } = await lab([...plain, ...policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL'])]);
    expect(await fetch(pc)).not.toMatch(/nginx/i);
  });

  it('drops the flow when the matching policy denies it', async () => {
    const { pc } = await lab([...POOL, ...policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL', 'set action deny'])]);
    expect(await fetch(pc)).not.toMatch(/nginx/i);
  });

  describe('system nat64 nat64-prefix', () => {
    const OPERATOR_PREFIX = '2001:db8:64::/96';
    const operatorServer = '2001:db8:64::b01:105';
    const carryingPolicy = policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL']);
    const operatorConfig = [
      'config system nat64', `set nat64-prefix ${OPERATOR_PREFIX}`, 'end',
      'config firewall address6', 'edit NAT64NET', `set ip6 ${OPERATOR_PREFIX}`, 'next', 'end',
    ];

    it('translates toward the configured prefix', async () => {
      const { pc } = await lab([...operatorConfig, ...POOL, ...carryingPolicy]);
      expect(await pc.executeCommand(`curl -s -m 5 'http://[${operatorServer}]/'`)).toMatch(/nginx/i);
    });

    it('no longer translates the well-known prefix once it is replaced', async () => {
      const { pc } = await lab([...operatorConfig, ...POOL, ...carryingPolicy]);
      expect(await fetch(pc)).not.toMatch(/nginx/i);
    });

    it('refuses a prefix that is not a /96', async () => {
      const { fw } = await lab([]);
      const out = await fw.executeCommand(['config system nat64', 'set nat64-prefix 2001:db8:64::/64', 'end'].join('\n'));
      const shown = await fw.executeCommand('show system nat64');
      expect(out + shown).not.toContain('2001:db8:64::/64\n');
    });
  });

  describe('secondary prefixes', () => {
    const SECONDARY = '2001:db8:ffff::/64';
    const secondaryServer = Nat64Prefix.parse(SECONDARY).synthesize(new IPAddress('11.1.1.5')).toString();
    const carryingPolicy = policy(['set nat64 enable', 'set ippool enable', 'set poolname NAT64POOL', 'set dstaddr6 NAT64NET SECNET']);
    const secondaryConfig = (status: 'enable' | 'disable') => [
      'config system nat64', `set secondary-prefix-status ${status}`,
      'config secondary-prefix', 'edit sec', `set nat64-prefix ${SECONDARY}`, 'next', 'end', 'end',
      'config firewall address6', 'edit SECNET', `set ip6 ${SECONDARY}`, 'next', 'end',
    ];

    it('translates toward a secondary prefix of another length', async () => {
      const { pc } = await lab([...secondaryConfig('enable'), ...POOL, ...carryingPolicy]);
      expect(await pc.executeCommand(`curl -s -m 5 'http://[${secondaryServer}]/'`)).toMatch(/nginx/i);
    }, 30000);

    it('keeps serving the primary prefix beside it', async () => {
      const { pc } = await lab([...secondaryConfig('enable'), ...POOL, ...carryingPolicy]);
      expect(await fetch(pc)).toMatch(/nginx/i);
    }, 30000);

    it('does not translate toward it while the secondary status is disabled', async () => {
      const { pc } = await lab([...secondaryConfig('disable'), ...POOL, ...carryingPolicy]);
      expect(await pc.executeCommand(`curl -s -m 5 'http://[${secondaryServer}]/'`)).not.toMatch(/nginx/i);
    }, 30000);
  });
});
