/**
 * L'ordre des drapeaux TCP est celui de `tcpdump`, et un segment sans
 * drapeau se dit `none`.
 *
 * Trouve en ecrivant `--scanflags` : un segment portant SYN et FIN
 * ensemble ressortait `Flags [SF]` alors que le vrai `tcpdump` ecrit
 * `[FS]`. Le rendu n'etait faux qu'a partir du moment ou un balayage a pu
 * composer ses drapeaux — c'est pourquoi le defaut n'avait jamais paru.
 *
 * Reference : `the-tcpdump-group/tcpdump`, `print-tcp.c:105`. La table
 * `tcp_flag_values` est parcourue TELLE QUELLE par `bittok2str_nosep`
 * (ligne 273), et son ordre est FIN, SYN, RST, PSH, ACK, URG, ECE, CWR.
 * Deux points ne se devinent pas : l'ACK se note `.` et se place AVANT
 * l'URG, et le FIN passe AVANT le SYN. Le troisieme argument de
 * `bittok2str_nosep` est la chaine rendue quand aucun bit ne correspond,
 * et c'est `"none"` — la ou ce simulateur rendait `.`, c'est-a-dire le
 * signe de l'ACK, pour un segment qui n'en porte pas.
 *
 * Deux bits etaient perdus AVANT meme le rendu : `CaptureTcpFlags` ne
 * portait ni ECE ni CWR alors que `TcpFlags` les porte, et
 * `tcpFlagsByte` — qui fabrique l'octet 13 de l'en-tete que lisent les
 * filtres a tranche d'octets — les mettait donc a zero.
 */

import { describe, it, expect } from 'vitest';
import { tcpFlagToken } from '@/network/devices/linux/network/tcpdump/TcpdumpFormat';
import type { CaptureFrame, CaptureTcpFlags } from '@/network/devices/linux/network/tcpdump/CaptureFrame';

function frame(set: Partial<CaptureTcpFlags>): CaptureFrame {
  const flags: CaptureTcpFlags = {
    syn: false, ack: false, fin: false, rst: false, psh: false, urg: false,
    ...set,
  };
  return { l4: 'tcp', tcpFlags: flags } as CaptureFrame;
}

describe('l ordre est celui de tcp_flag_values', () => {
  it('le FIN passe avant le SYN', () => {
    expect(tcpFlagToken(frame({ syn: true, fin: true }))).toBe('FS');
  });

  it('l ACK se note `.` et passe avant l URG', () => {
    expect(tcpFlagToken(frame({ ack: true, urg: true }))).toBe('.U');
  });

  it('les combinaisons courantes ne bougent pas', () => {
    expect(tcpFlagToken(frame({ syn: true }))).toBe('S');
    expect(tcpFlagToken(frame({ syn: true, ack: true }))).toBe('S.');
    expect(tcpFlagToken(frame({ rst: true, ack: true }))).toBe('R.');
    expect(tcpFlagToken(frame({ fin: true, ack: true }))).toBe('F.');
    expect(tcpFlagToken(frame({ psh: true, ack: true }))).toBe('P.');
    expect(tcpFlagToken(frame({ fin: true, psh: true, urg: true }))).toBe('FPU');
  });

  it('ECE et CWR sont rendus, et en dernier', () => {
    expect(tcpFlagToken(frame({ syn: true, ece: true, cwr: true }))).toBe('SEW');
  });

  it('la table entiere se rend dans l ordre', () => {
    expect(tcpFlagToken(frame({
      fin: true, syn: true, rst: true, psh: true,
      ack: true, urg: true, ece: true, cwr: true,
    }))).toBe('FSRP.UEW');
  });
});

describe('un segment sans aucun drapeau se dit `none`', () => {
  it('le balayage NULL rend `none`, pas le signe de l ACK', () => {
    expect(tcpFlagToken(frame({}))).toBe('none');
  });

  it('une trame sans en-tete TCP du tout aussi', () => {
    expect(tcpFlagToken({ l4: 'tcp' } as CaptureFrame)).toBe('none');
  });
});
