/**
 * Le journal de Dynamic ARP Inspection (`show logging`, lignes `*<horodatage>: %SW_DAI-4-...`) est date par le
 * commutateur. Mesure de depart : `appendLog` prenait l'heure globale du simulateur, si bien qu'apres `clock set` les
 * violations portaient l'heure d'origine alors que `show clock` disait la date posee. ArpInspectionHost expose
 * maintenant `nowMs()` et Switch le branche sur l'horloge de l'equipement ; les traces `debug spanning-tree events`
 * lisent la meme horloge.
 *
 * Discrimine par `git stash` sur src/network : 1 des 2 cas tombe avant (l'horodatage apres `clock set`). Le TEMOIN
 * (horloge intacte, la violation est journalisee) passe des deux cotes.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, IPAddress, ETHERTYPE_ARP, type ARPPacket } from '@/network/core/types';

const HOST1_MAC = '00:11:22:33:44:01';
const HOST2_MAC = '00:11:22:33:44:02';

function violate(sw: CiscoSwitch): void {
  const arp: ARPPacket = {
    type: 'arp', operation: 'request',
    senderMAC: new MACAddress(HOST1_MAC), senderIP: new IPAddress('10.0.0.5'),
    targetMAC: new MACAddress('00:00:00:00:00:00'), targetIP: new IPAddress('10.0.0.9'),
  };
  const frame = {
    srcMAC: new MACAddress(HOST2_MAC), dstMAC: new MACAddress('ff:ff:ff:ff:ff:ff'),
    etherType: ETHERTYPE_ARP, payload: arp,
  };
  (sw as unknown as { handleFrame(port: string, f: typeof frame): void }).handleFrame('FastEthernet0/1', frame);
}

async function loggedStamp(setClock: string | null): Promise<string> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  for (const name of sw.getPortNames()) sw.getPort(name)!.setUp(true);
  await sw.executeCommand('enable');
  if (setClock !== null) await sw.executeCommand(setClock);
  const cfg = sw._getArpInspectionConfig();
  cfg.vlans.add(1);
  cfg.validate.srcMac = true;
  violate(sw);
  const line = sw._getSnoopingLog().find((l) => l.startsWith('*'));
  expect(line, 'no DAI log line').toBeDefined();
  return line as string;
}

describe('le journal DAI suit l horloge du commutateur', () => {
  it('TEMOIN — horloge intacte, la violation est journalisee avec un horodatage ISO', async () => {
    expect(await loggedStamp(null)).toMatch(/^\*\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  });

  it('apres clock set, la ligne porte la date posee', async () => {
    expect(await loggedStamp('clock set 10:00:00 5 January 2027')).toMatch(/^\*2027-01-05T10:00:/);
  });
});
