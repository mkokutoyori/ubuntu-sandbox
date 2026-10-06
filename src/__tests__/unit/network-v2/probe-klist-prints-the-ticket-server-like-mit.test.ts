/**
 * Sonde : `klist` imprime la ligne « Ticket server: » quand le principal de
 * service sous lequel le cache a range l'identifiant n'est pas celui que porte
 * le billet — le cas d'un billet obtenu pour un nom de service d'hote sans
 * royaume (`ldap/vm@`), que le KDC a emis pour `ldap/vm@CORP.LOCAL`.
 *
 * Autorite : le vrai `klist` de MIT Kerberos 1.20.1 (Ubuntu 24.04) lisant le
 * cache que le vrai `ldapsearch -Y GSSAPI` a laisse (TGT puis billet de
 * service), avec chacune des options d'affichage : la ligne vient en dernier,
 * apres les lignes de renouvellement, d'options, de types de chiffrement et
 * d'adresses. Le cache est celui du corpus `openldap-ldapsearch-gssapi-corpus`.
 *
 * Mesure avant correction : le simulateur n'imprimait jamais cette ligne, les
 * 7 cas tombent. Temoin : « a ticket granting ticket prints no ticket server »
 * passe avant et apres (la ligne n'existe que pour un nom different).
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { loadJson } from './openldap-replay-support';
import type { GssapiCorpus } from './openldap-gssapi-replay-support';

const corpus = loadJson<GssapiCorpus>('openldap-ldapsearch-gssapi-corpus.json');
const HEADER = 'Ticket cache: FILE:/tmp/warm.cc\nDefault principal: alice@CORP.LOCAL\n\nValid starting     Expires            Service principal\n';
const TGT = '10/06/26 21:23:50  10/07/26 07:23:50  krbtgt/CORP.LOCAL@CORP.LOCAL\n';
const SERVICE = '10/06/26 21:23:50  10/07/26 07:23:50  ldap/vm@\n';
const ETYPE = 'Etype (skey, tkt): aes256-cts-hmac-sha1-96, aes256-cts-hmac-sha1-96 ';
const SERVER = '\tTicket server: ldap/vm@CORP.LOCAL\n';

const EXPECTED: Readonly<Record<string, string>> = {
  '': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50\n${SERVICE}\trenew until 10/07/26 21:23:50\n${SERVER}`,
  '-f': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50, Flags: RI\n${SERVICE}\trenew until 10/07/26 21:23:50, Flags: RT\n${SERVER}`,
  '-e': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50, ${ETYPE}\n${SERVICE}\trenew until 10/07/26 21:23:50, ${ETYPE}\n${SERVER}`,
  '-a': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50\n\tAddresses: (none)\n${SERVICE}\trenew until 10/07/26 21:23:50\n\tAddresses: (none)\n${SERVER}`,
  '-fe': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50, Flags: RI\n\t${ETYPE}\n${SERVICE}\trenew until 10/07/26 21:23:50, Flags: RT\n\t${ETYPE}\n${SERVER}`,
  '-fea': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50, Flags: RI\n\t${ETYPE}\n\tAddresses: (none)\n${SERVICE}\trenew until 10/07/26 21:23:50, Flags: RT\n\t${ETYPE}\n\tAddresses: (none)\n${SERVER}`,
  '-d': `${HEADER}${TGT}\trenew until 10/07/26 21:23:50, AD types: \n${SERVICE}\trenew until 10/07/26 21:23:50, AD types: \n${SERVER}`,
};

function machineHolding(cache: Uint8Array): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1');
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/warm.cc', Buffer.from(cache).toString('latin1'), 1000, 1000, 0o077);
  return pc;
}

const warm = Uint8Array.from(Buffer.from(corpus.caches.warm, 'hex'));

describe('klist prints the ticket server like the real tool', () => {
  for (const [options, expected] of Object.entries(EXPECTED)) {
    it(`klist ${options} prints the ticket server last`, async () => {
      const pc = machineHolding(warm);
      expect(await pc.executeCommand(`KRB5CCNAME=FILE:/tmp/warm.cc klist ${options}`)).toBe(expected.replace(/\n$/, ''));
    });
  }

  it('a ticket granting ticket prints no ticket server', async () => {
    const pc = machineHolding(Uint8Array.from(Buffer.from(corpus.caches.base, 'hex')));
    expect(await pc.executeCommand('KRB5CCNAME=FILE:/tmp/warm.cc klist')).not.toContain('Ticket server');
  });
});
