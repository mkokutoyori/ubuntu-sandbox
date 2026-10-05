/*
 * `certutil -hashfile`, `-encode` et `-decode`.
 *
 * Mesure de depart : `certutil -hashfile f SHA256` repondait « CertUtil
 * usage: CertUtil [-submit] -template <template> -subject <subject> » — une
 * ligne qui n'est pas celle de certutil, pour un outil dont `-submit` etait
 * le seul verbe — et `-encode` et `-decode` ne faisaient rien non plus. Or
 * `certutil -hashfile` est la facon courante, sous Windows, de verifier
 * l'empreinte d'un fichier, et `-encode`/`-decode` celle de passer un
 * fichier en base64 : ce sont les trois verbes qu'un laboratoire utilise.
 *
 * L'AUTORITE — l'aide de `certutil -?` et la page certutil de Microsoft,
 * LUES DE MEMOIRE (aucune transcription n'est atteignable d'ici) :
 * `-hashfile fichier [algorithme]` (SHA1 par defaut ; MD2, MD4, MD5, SHA1,
 * SHA256, SHA384, SHA512), l'en-tete « SHA256 hash of fichier: », l'empreinte
 * en hexadecimal minuscule sans espaces (Windows 10), le pied « CertUtil:
 * -hashfile command completed successfully. », et, sur un echec, « CertUtil:
 * -verbe command FAILED: 0x… (…) » suivi du texte de l'erreur, avec le
 * HRESULT pour code retour. `-encode` ecrit un fichier base64 entre
 * `-----BEGIN CERTIFICATE-----` et `-----END CERTIFICATE-----`, lignes de 64
 * caracteres, et annonce « Input Length » et « Output Length » ; `-decode`
 * fait l'inverse. MD2 n'est pas calcule ici (l'implementation de RFC 1319 et
 * sa table n'existent pas dans ce depot) : il est refuse comme un algorithme
 * inconnu, ce que le vrai certutil ne fait pas. Les empreintes sont les
 * vecteurs de test publies de MD4, MD5, SHA-1, SHA-2 sur « abc » et la
 * chaine vide, deja verifies par les tests de `src/crypto`.
 *
 * Ecrite a l'aveugle, sur `executeCmdCommand`. 9 des 10 cas tombent avant
 * (git stash push -- src/network src/powershell src/crypto). Le seul qui passe
 * des deux cotes est un TEMOIN : `certreq -submit` incomplet, que le
 * deplacement de `certutil` dans son propre module ne doit pas changer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function lab(): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', 'WIN-CU');
  pc.setCurrentUser('Administrator');
  const fs = pc.getFileSystem();
  fs.mkdirp('C:\\lab');
  fs.createFile('C:\\lab\\abc.txt', 'abc');
  fs.createFile('C:\\lab\\empty.txt', '');
  await pc.executeCmdCommand('cd C:\\lab');
  return pc;
}

const lines = (out: string): string[] => (out === '' ? [] : out.split('\n'));
const level = async (pc: WindowsPC): Promise<string> => pc.executeCmdCommand('echo %errorlevel%');

describe('-hashfile', () => {
  it('prints the digest of a file under a header naming the algorithm, and the completion line', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('certutil -hashfile abc.txt SHA256'))).toEqual([
      'SHA256 hash of abc.txt:',
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      'CertUtil: -hashfile command completed successfully.',
    ]);
    expect(await level(pc)).toBe('0');
  });

  it('knows MD4, MD5, SHA1, SHA384 and SHA512, and takes SHA1 when no algorithm is given', async () => {
    const pc = await lab();
    const digest = async (algorithm: string): Promise<string> =>
      lines(await pc.executeCmdCommand(`certutil -hashfile abc.txt ${algorithm}`))[1];

    expect(await digest('MD4')).toBe('a448017aaf21d8525fc10ae87aa6729d');
    expect(await digest('MD5')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(await digest('sha1')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(await digest('SHA384')).toBe('cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7');
    expect(await digest('SHA512')).toBe('ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f');
    expect(lines(await pc.executeCmdCommand('certutil -hashfile abc.txt'))[0]).toBe('SHA1 hash of abc.txt:');
  });

  it('hashes an empty file', async () => {
    const pc = await lab();

    expect(lines(await pc.executeCmdCommand('certutil -hashfile empty.txt MD5'))[1]).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });

  it('fails like certutil on a file that is not there, an algorithm it does not know, and a missing file name', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('certutil -hashfile nosuch.txt SHA256')).toBe(
      'CertUtil: -hashfile command FAILED: 0x80070002 (WIN32: 2 ERROR_FILE_NOT_FOUND)\nCertUtil: The system cannot find the file specified.');
    expect(await level(pc)).toBe('-2147024894');
    expect(await pc.executeCmdCommand('certutil -hashfile abc.txt NOPE')).toBe(
      'CertUtil: -hashfile command FAILED: 0x80090008 (-2146893816 NTE_BAD_ALGID)\nCertUtil: Invalid algorithm specified.');
    expect(await pc.executeCmdCommand('certutil -hashfile')).toBe(
      'CertUtil: -hashfile command FAILED: 0x80070057 (WIN32: 87 ERROR_INVALID_PARAMETER)\nCertUtil: The parameter is incorrect.');
  });

  it('agrees with Get-FileHash, which now takes SHA384 too', async () => {
    const pc = await lab();
    const { subShell } = PowerShellSubShell.create(pc);
    const viaPowerShell = (await subShell.processLine('(Get-FileHash C:\\lab\\abc.txt -Algorithm SHA384).Hash')).output[0];

    expect(viaPowerShell.toLowerCase()).toBe(lines(await pc.executeCmdCommand('certutil -hashfile abc.txt SHA384'))[1]);
  });
});

describe('-encode and -decode', () => {
  it('writes base64 between the certificate markers, in lines of 64, and says how long', async () => {
    const pc = await lab();
    const out = lines(await pc.executeCmdCommand('certutil -encode abc.txt abc.b64'));
    const written = await pc.executeCmdCommand('type abc.b64');

    expect(written.split(/\r?\n/).filter(line => line !== '')).toEqual(['-----BEGIN CERTIFICATE-----', 'YWJj', '-----END CERTIFICATE-----']);
    expect(out).toEqual(['Input Length = 3', 'Output Length = 62', 'CertUtil: -encode command completed successfully.']);
  });

  it('wraps long input at 64 characters', async () => {
    const pc = await lab();
    pc.getFileSystem().createFile('C:\\lab\\long.txt', 'x'.repeat(100));
    await pc.executeCmdCommand('certutil -encode long.txt long.b64');
    const body = (await pc.executeCmdCommand('type long.b64')).split(/\r?\n/).filter(line => line !== '' && !line.startsWith('-----'));

    expect(body.map(line => line.length)).toEqual([64, 64, 8].slice(0, body.length));
    expect(body.length).toBe(3);
  });

  it('decodes what it encoded', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('certutil -encode abc.txt abc.b64');
    const out = lines(await pc.executeCmdCommand('certutil -decode abc.b64 back.txt'));

    expect(await pc.executeCmdCommand('type back.txt')).toBe('abc');
    expect(out[out.length - 1]).toBe('CertUtil: -decode command completed successfully.');
    expect(out[1]).toBe('Output Length = 3');
  });

  it('fails on a missing file and on data that is not base64', async () => {
    const pc = await lab();
    await pc.executeCmdCommand('echo ***not base64***> junk.b64');

    expect(await pc.executeCmdCommand('certutil -encode nosuch.txt x.b64')).toContain('FAILED: 0x80070002');
    expect(await pc.executeCmdCommand('certutil -decode junk.b64 x.txt')).toBe(
      'CertUtil: -decode command FAILED: 0x8007000d (WIN32: 13 ERROR_INVALID_DATA)\nCertUtil: The data is invalid.');
  });
});

describe('what already worked', () => {
  it('keeps certreq refusing an incomplete -submit — WITNESS', async () => {
    const pc = await lab();

    expect(await pc.executeCmdCommand('certreq -submit')).toContain('CertReq');
  });
});
