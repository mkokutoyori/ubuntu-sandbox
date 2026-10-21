/**
 * Tuto NAT / PAT sur Cisco, partie 14 : `ip nat log translations syslog`.
 *
 * Mesure avant correction (lab du tuto, PAT sur Gi0/1) : la commande etait acceptee et rangee dans un
 * champ prive du routeur (`_ciscoNatLogTranslations`) que rien ne lisait ; `show running-config`
 * ne la rendait pas et `show logging` ne contenait jamais de ligne %IPNAT. Tombent avant la
 * correction : 3 cas sur 4 (journal de creation et de suppression, rendu et forme no, expiration).
 * Passe dans les deux etats : le temoin du laboratoire (le PAT traduit et le journal est vide sans
 * la commande).
 *
 * Format : %IPNAT-6-CREATED / %IPNAT-6-DELETED, puis protocole, inside local, inside global, outside
 * local, outside global, tel que donne par le tuto (« format indicatif ») ; la documentation IOS
 * du NAT ne fait pas partie de official_docs/cisco, la source est donc ce transcript.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { tutoNatLab, runLines } from './_helpers/tutoNatLab';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); });

const PAT = ['ip nat inside source list 1 interface GigabitEthernet0/1 overload'];

describe('ip nat log translations syslog', () => {
  it('journalises the creation and the deletion of a translation, with the ports of the translation table', async () => {
    const { r, lin } = await tutoNatLab([...PAT, 'ip nat log translations syslog']);
    expect(await lin.executeCommand('curl -s -o /dev/null http://198.51.100.10/')).toBe('');
    const table = await r.executeCommand('show ip nat translations');
    const row = table.split('\n').find((l) => l.startsWith('tcp'))!;
    const [, global, local, outsideLocal, outsideGlobal] = row.trim().split(/\s+/);
    const created = await r.executeCommand('show logging | include IPNAT');
    expect(created).toContain(`%IPNAT-6-CREATED: tcp ${local} ${global} ${outsideLocal} ${outsideGlobal}`);
    expect(created).not.toContain('DELETED');
    await runLines(r, ['clear ip nat translation *']);
    expect(await r.executeCommand('show logging | include IPNAT'))
      .toContain(`%IPNAT-6-DELETED: tcp ${local} ${global} ${outsideLocal} ${outsideGlobal}`);
  });

  it('witness: without the command the translation exists and the journal holds no %IPNAT line', async () => {
    const { r, lin } = await tutoNatLab(PAT);
    await lin.executeCommand('curl -s -o /dev/null http://198.51.100.10/');
    expect(await r.executeCommand('show ip nat translations')).toMatch(/^tcp /m);
    expect(await r.executeCommand('show logging | include IPNAT')).not.toContain('IPNAT');
  });

  it('is rendered in the running-config and its no form stops the journal', async () => {
    const { r, lin } = await tutoNatLab([...PAT, 'ip nat log translations syslog']);
    expect(await r.executeCommand('show running-config | include ip nat log')).toContain('ip nat log translations syslog');
    await runLines(r, ['configure terminal', 'no ip nat log translations syslog', 'end']);
    expect(await r.executeCommand('show running-config | include ip nat log')).not.toContain('ip nat log');
    await lin.executeCommand('curl -s -o /dev/null http://198.51.100.10/');
    expect(await r.executeCommand('show logging | include IPNAT')).not.toContain('IPNAT');
  });

  it('journalises expiry as a deletion', async () => {
    const { r, lin } = await tutoNatLab([...PAT, 'ip nat log translations syslog', 'ip nat translation tcp-timeout 1']);
    await lin.executeCommand('curl -s -o /dev/null http://198.51.100.10/');
    r._getNATEngine().purgeStale(0);
    expect(await r.executeCommand('show logging | include IPNAT')).toContain('%IPNAT-6-DELETED: tcp');
  });
});
