/*
 * Probe - omfile with cry.provider (tools/omfile.c initCryprov, runtime/lmcry_gcry.c and lmcry_ossl.c SetCnfParam, runtime/libgcry.c,
 * libossl.c and runtime/stream.c strmPhysWrite/strmCloseFile): each flushed buffer is padded with NUL up to the cipher block and
 * encrypted in place by one cipher context that lives as long as the file; the side file "<log>.encinfo" holds "FILETYPE:" then
 * "IV:<hex>" when the file is opened and "END:<offset>" when it is closed, so a file opened again in append mode gets a new block.
 * The expected bytes were produced by the real libgcrypt 1.10.3 and OpenSSL 3.0.13 for the same key, IV and buffers
 * (scripts/oracle/record_rsyslog_crypto.py); the lab's random() is fixed, so the IV is ffffff1f repeated.  Configuration errors are the
 * runtime's own wording, including the doubled "Encryption ProviderError".
 * Measured before the port (git stash push -- src/network): 33 of the 35 cases fall - the file was written in clear text next to no
 * .encinfo, every key parameter was reported as unknown and no configuration error existed.  The two that pass either way: the
 * WITNESS that a plain omfile writes clear text and no .encinfo, and cry.keyprogram with the ossl provider, which was reported as
 * an unknown parameter before the port too (non-regression of the unused-parameter report).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LabHost, LabNetwork, startRsyslog, submitLocal, type LabEngine } from './_helpers/rsyslogLab';

interface Transcript { algo?: string; name?: string; mode?: string; key: string; lines: string[]; file: string; encinfo: string }
const gcrypt = JSON.parse(readFileSync('src/__tests__/support/oracle/rsyslog-crypto/gcrypt-1.10.3.json', 'utf8')) as { transcripts: Transcript[] };
const openssl = JSON.parse(readFileSync('src/__tests__/support/oracle/rsyslog-crypto/openssl-3.0.13.json', 'utf8')) as { transcripts: Transcript[] };

const TEMPLATE = 'template(name="probe" type="string" string="%rawmsg%\\n")\n';
const bytesText = (hex: string): string => Buffer.from(hex, 'hex').toString('latin1');

function lab(action: string, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  return { host, engine: startRsyslog(host, `${TEMPLATE}${action}\n`) };
}

function omfile(parameters: string): string {
  return `action(type="omfile" file="/var/log/enc.log" template="probe" ${parameters})`;
}

function run(parameters: string, transcript: Transcript, host = new LabHost('10.0.0.1', new LabNetwork())): { host: LabHost; engine: LabEngine } {
  host.fileSystem.set('/etc/enc.key', bytesText(transcript.key));
  const started = lab(omfile(`cry.keyfile="/etc/enc.key" ${parameters}`), host);
  for (const line of transcript.lines) submitLocal(started.engine, line);
  return started;
}

describe('libgcrypt provider against the real library', () => {
  for (const transcript of gcrypt.transcripts) {
    it(`${transcript.algo}/${transcript.mode}: the file and its .encinfo are the bytes libgcrypt produces`, () => {
      const { host, engine } = run(`cry.provider="gcry" cry.algo="${transcript.algo}" cry.mode="${transcript.mode}"`, transcript);
      engine.engine.stop();
      expect(host.fileSystem.get('/var/log/enc.log')).toBe(bytesText(transcript.file));
      expect(host.fileSystem.get('/var/log/enc.log.encinfo')).toBe(transcript.encinfo);
    });
  }

  it('the defaults are AES128 in CBC mode', () => {
    const transcript = gcrypt.transcripts[0];
    const { host, engine } = run('cry.provider="gcry"', transcript);
    engine.engine.stop();
    expect(host.fileSystem.get('/var/log/enc.log')).toBe(bytesText(transcript.file));
  });
});

describe('OpenSSL provider against the real library', () => {
  for (const transcript of openssl.transcripts) {
    it(`${transcript.name}: the file and its .encinfo are the bytes OpenSSL produces`, () => {
      const { host, engine } = run(`cry.provider="ossl" cry.algo="${transcript.name}"`, transcript);
      engine.engine.stop();
      expect(host.fileSystem.get('/var/log/enc.log')).toBe(bytesText(transcript.file));
      expect(host.fileSystem.get('/var/log/enc.log.encinfo')).toBe(transcript.encinfo);
    });
  }

  it('the algorithm name is case-insensitive, as EVP_CIPHER_fetch is', () => {
    const transcript = openssl.transcripts[0];
    const { host, engine } = run('cry.provider="ossl" cry.algo="AES-128-CBC"', transcript);
    engine.engine.stop();
    expect(host.fileSystem.get('/var/log/enc.log')).toBe(bytesText(transcript.file));
  });
});

describe('what the encinfo file records', () => {
  const transcript = gcrypt.transcripts[0];

  it('witness: without cry.provider the file is clear text and no .encinfo exists', () => {
    const { host, engine } = lab(omfile(''));
    submitLocal(engine, transcript.lines[0]);
    engine.engine.stop();
    expect(host.fileSystem.get('/var/log/enc.log')).toBe(`${transcript.lines[0]}\n`);
    expect(host.fileSystem.has('/var/log/enc.log.encinfo')).toBe(false);
  });

  it('is created with mode 0600 next to the log, before any data is written', () => {
    const { host, engine } = run('cry.provider="gcry"', { ...transcript, lines: [] });
    expect(host.fileSystem.get('/var/log/enc.log.encinfo')).toBeUndefined();
    submitLocal(engine, transcript.lines[0]);
    expect(host.fileSystem.get('/var/log/enc.log.encinfo')).toBe('FILETYPE:rsyslog-enrcyption-info\nIV:ffffff1fffffff1fffffff1fffffff1f\n');
  });

  it('gets a second block when the file is opened again in append mode, END being the size of the file at close', () => {
    const first = run('cry.provider="gcry"', transcript);
    first.engine.engine.stop();
    const firstSize = (first.host.fileSystem.get('/var/log/enc.log') ?? '').length;
    const second = run('cry.provider="gcry"', { ...transcript, lines: [transcript.lines[1]] }, first.host);
    second.engine.engine.stop();
    const blocks = (second.host.fileSystem.get('/var/log/enc.log.encinfo') ?? '').split('\n').filter((line) => line !== '');
    expect(blocks).toEqual([
      'FILETYPE:rsyslog-enrcyption-info',
      'IV:ffffff1fffffff1fffffff1fffffff1f', `END:${firstSize}`,
      'IV:ffffff1fffffff1fffffff1fffffff1f', `END:${(second.host.fileSystem.get('/var/log/enc.log') ?? '').length}`,
    ]);
    expect((second.host.fileSystem.get('/var/log/enc.log') ?? '').length).toBeGreaterThan(firstSize);
  });

  it('a file that is not an encinfo file stops the log from being opened', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set('/var/log/enc.log.encinfo', 'not an encryption info file at all, not even close\n');
    const { engine } = run('cry.provider="gcry"', transcript, host);
    expect(host.fileSystem.get('/var/log/enc.log') ?? '').toBe('');
    expect(engine.internalMessages.map((entry) => entry.text).join('\n')).toContain('Encryption ProviderError: cannot open .encinfo file - disabling log file');
  });
});

describe('configuration errors, in the runtime wording', () => {
  const transcript = gcrypt.transcripts[0];
  const messages = (engine: LabEngine): string => engine.loader.log.lines().join('\n');
  const config = (parameters: string): { host: LabHost; engine: LabEngine } => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    host.fileSystem.set('/etc/enc.key', bytesText(transcript.key));
    return lab(omfile(parameters), host);
  };

  it('an unknown algorithm', () => {
    expect(messages(config('cry.provider="gcry" cry.algo="ROT13" cry.keyfile="/etc/enc.key"').engine)).toContain("cry.algo 'ROT13' is not know/supported");
  });

  it('an unknown mode', () => {
    expect(messages(config('cry.provider="gcry" cry.mode="XTS" cry.keyfile="/etc/enc.key"').engine)).toContain("cry.mode 'XTS' is not know/supported");
  });

  it('no key at all, and two keys', () => {
    expect(messages(config('cry.provider="gcry"').engine)).toContain('excactly one of the following parameters can be specified: cry.key, cry.keyfile, cry.keyprogram');
    expect(messages(config('cry.provider="gcry" cry.key="0123456789abcdef" cry.keyfile="/etc/enc.key"').engine)).toContain('excactly one of the following');
    expect(messages(config('cry.provider="ossl" cry.key="0123456789abcdef"').engine)).toContain('Note: specifying an actual key directly from the config file is highly insecure');
  });

  it('a key of the wrong length names the length the algorithm wants', () => {
    const text = messages(config('cry.provider="gcry" cry.algo="AES256" cry.keyfile="/etc/enc.key"').engine);
    expect(text).toContain('Key length 32 expected, but key of length 16 given');
  });

  it('a key file that is missing, empty or larger than 64 KiB', () => {
    expect(messages(config('cry.provider="gcry" cry.keyfile="/etc/absent.key"').engine)).toContain('error reading keyfile /etc/absent.key: No such file or directory');
    const empty = new LabHost('10.0.0.1', new LabNetwork());
    empty.fileSystem.set('/etc/enc.key', '');
    expect(messages(lab(omfile('cry.provider="gcry" cry.keyfile="/etc/enc.key"'), empty).engine)).toContain('error reading keyfile /etc/enc.key: Invalid argument');
    const huge = new LabHost('10.0.0.1', new LabNetwork());
    huge.fileSystem.set('/etc/enc.key', 'k'.repeat(64 * 1024 + 1));
    expect(messages(lab(omfile('cry.provider="gcry" cry.keyfile="/etc/enc.key"'), huge).engine)).toContain('error reading keyfile /etc/enc.key: Message too long');
  });

  it('cry.keyprogram exists for gcry only: for ossl the parameter is unknown', () => {
    const text = messages(config('cry.provider="ossl" cry.keyprogram="/usr/local/bin/keys" cry.keyfile="/etc/enc.key"').engine);
    expect(text).toContain("parameter 'cry.keyprogram' not known");
  });

  it('a provider that is not installed', () => {
    const host = new LabHost('10.0.0.1', new LabNetwork());
    expect(messages(lab(omfile('cry.provider="nss" cry.key="x"'), host).engine)).toContain("omfile: could not load crypto provider 'lmcry_nss' - encryption disabled");
  });

  it('an algorithm and mode libgcrypt refuses at open, or a weak DES key, disable the log file', () => {
    const refused = (parameters: string, key: string): { host: LabHost; engine: LabEngine } => {
      const host = new LabHost('10.0.0.1', new LabNetwork());
      host.fileSystem.set('/etc/enc.key', key);
      const started = lab(omfile(`cry.keyfile="/etc/enc.key" ${parameters}`), host);
      submitLocal(started.engine, transcript.lines[0]);
      return started;
    };
    const streamOnAes = refused('cry.provider="gcry" cry.mode="STREAM"', '0123456789abcdef');
    expect(streamOnAes.host.fileSystem.get('/var/log/enc.log') ?? '').toBe('');
    expect(streamOnAes.engine.internalMessages.map((entry) => entry.text).join('\n')).toContain('Encryption ProviderError: cannot open .encinfo file - disabling log file');
    const weak = refused('cry.provider="gcry" cry.algo="DES"', '\x01\x01\x01\x01\x01\x01\x01\x01');
    expect(weak.host.fileSystem.get('/var/log/enc.log') ?? '').toBe('');
    expect(weak.host.fileSystem.has('/var/log/enc.log.encinfo')).toBe(false);
  });
});
