/**
 * Banc — la couche fil NFSv3 tenue a son autorite.
 *
 * Ce n'est pas une sonde de correctif : NFS n'existait pas dans ce depot,
 * il n'y a donc aucun avant a discriminer par `git stash`. Le role de ce
 * banc est l'autre moitie du §7 — mesurer le fil contre une source, et
 * nommer laquelle.
 *
 * AUTORITE. Le §8 demande de choisir la reference avant de la citer. NFS
 * est un standard ouvert adopte : RFC 1813 (NFSv3), RFC 5531 (ONC RPC),
 * RFC 4506 (XDR), RFC 1833 (portmap), et le 2049 est une affectation
 * IANA. Le texte des RFC est INJOIGNABLE depuis cette machine — le
 * mandataire refuse rfc-editor.org, ietf.org, datatracker.ietf.org,
 * tools.ietf.org, et les miroirs hjp.at et freesoft.org. Plutot que de
 * deviner, les nombres viennent de l'implantation de reference, qui est
 * joignable et qui EST ce que le fil porte :
 *
 *   include/uapi/linux/nfs3.h      procedures 0..21, ftype3, createmode3,
 *                                  time_how, bits d'ACCESS, proprietes de
 *                                  systeme de fichiers, 2049, tailles
 *   include/uapi/linux/nfs.h       enum nfs_stat (les NFS3ERR_*), 100003,
 *                                  100005, NFS_MNT3_VERSION
 *   include/linux/sunrpc/msg_prot.h  RPC_VERSION 2, msg_type, reply_stat,
 *                                  accept_stat, reject_stat, auth_stat,
 *                                  saveurs d'authentification, marquage
 *                                  d'enregistrement (bit de poids fort +
 *                                  longueur sur 31 bits)
 *   fs/nfsd/nfs3xdr.c              la DISPOSITION : fattr3 tient en 21
 *                                  unites XDR, wcc_attr en 6, et l'ordre
 *                                  des champs de chaque resultat
 *
 * Les deux premiers cas ci-dessous sont les plus utiles du banc : ils
 * clouent les tailles que le noyau reserve explicitement. Un champ
 * oublie ou un hyper ecrit sur 32 bits les fait tomber tout de suite,
 * la ou un aller-retour encode/decode passerait sans rien voir.
 */

import { describe, it, expect } from 'vitest';
import { XdrReader, XdrWriter } from '@/network/nfs/wire/Xdr';
import {
  AUTH_NONE, RpcAcceptState, RpcAuthFlavor, RpcMessageType, RpcReplyState, RPC_LAST_FRAGMENT,
  decodeAuthSys, decodeRpcCall, decodeRpcReply, encodeAuthSys, encodeRpcCall, encodeRpcReply,
  frameRecord, readRecord,
} from '@/network/nfs/wire/RpcMessage';
import {
  Ftype3, NFS_PORT, NFS_PROGRAM, MOUNT_PROGRAM, NfsProcedure, NfsStatus, StableHow,
} from '@/network/nfs/wire/NfsConstants';
import * as codec from '@/network/nfs/wire/NfsCodec';
import type { Fattr3 } from '@/network/nfs/wire/NfsTypes';

const XDR_UNIT = 4;

const SAMPLE_ATTR: Fattr3 = {
  type: Ftype3.NF3REG,
  mode: 0o644,
  nlink: 1,
  uid: 1000,
  gid: 1000,
  size: 4_294_967_296n,
  used: 4_294_971_392n,
  rdev: { specdata1: 0, specdata2: 0 },
  fsid: 0x1234_5678_9abc_def0n,
  fileid: 424242n,
  atime: { seconds: 1_700_000_001, nseconds: 111 },
  mtime: { seconds: 1_700_000_002, nseconds: 222 },
  ctime: { seconds: 1_700_000_003, nseconds: 333 },
};

describe('XDR — RFC 4506 par la disposition que le noyau reserve', () => {
  it('fattr3 occupe exactement 21 unites XDR', () => {
    const w = new XdrWriter();
    codec.writeFattr3(w, SAMPLE_ATTR);
    expect(w.length).toBe(XDR_UNIT * 21);
  });

  it('wcc_attr occupe exactement 6 unites XDR', () => {
    const w = new XdrWriter();
    codec.writeWccData(w, {
      before: { size: 10n, mtime: SAMPLE_ATTR.mtime, ctime: SAMPLE_ATTR.ctime },
      after: null,
    });
    expect(w.length).toBe(XDR_UNIT * (1 + 6 + 1));
  });

  it('un hyper traverse les 32 bits sans se tronquer', () => {
    const w = new XdrWriter().uint64(0xffff_ffff_ffff_fffen);
    expect(w.length).toBe(8);
    expect(new XdrReader(w.toBytes()).uint64()).toBe(0xffff_ffff_ffff_fffen);
  });

  it('une chaine est complee jusqu au multiple de quatre', () => {
    const w = new XdrWriter().string('abcde');
    expect(w.length).toBe(4 + 8);
    expect(new XdrReader(w.toBytes()).string()).toBe('abcde');
  });

  it('un entier est gros-boutiste', () => {
    expect(Array.from(new XdrWriter().uint32(0x01020304).toBytes())).toEqual([1, 2, 3, 4]);
  });

  it('une lecture au-dela de la fin est refusee au lieu de rendre du vide', () => {
    expect(() => new XdrReader(new Uint8Array(2)).uint32()).toThrow();
  });
});

describe('ONC RPC — RFC 5531 et le marquage d enregistrement', () => {
  it('le marquage porte le bit de dernier fragment et la longueur sur 31 bits', () => {
    const framed = frameRecord(Uint8Array.from([1, 2, 3, 4]));
    const header = new DataView(framed.buffer).getUint32(0);
    expect(header >>> 0).toBe((RPC_LAST_FRAGMENT | 4) >>> 0);
    expect(framed.length).toBe(8);
  });

  it('un enregistrement incomplet n est pas lu a moitie', () => {
    const framed = frameRecord(Uint8Array.from([1, 2, 3, 4]));
    expect(readRecord(framed.subarray(0, 6))).toBeNull();
    expect(readRecord(framed)?.consumed).toBe(8);
  });

  it('un appel porte xid, type, version, programme, version et procedure dans cet ordre', () => {
    const call = {
      xid: 0xdeadbeef,
      rpcVersion: 2,
      program: NFS_PROGRAM,
      programVersion: 3,
      procedure: NfsProcedure.GETATTR,
      credential: AUTH_NONE,
      verifier: AUTH_NONE,
      payload: new Uint8Array(0),
    };
    const r = new XdrReader(encodeRpcCall(call));
    expect(r.uint32()).toBe(0xdeadbeef);
    expect(r.enumeration()).toBe(RpcMessageType.CALL);
    expect(r.uint32()).toBe(2);
    expect(r.uint32()).toBe(100003);
    expect(r.uint32()).toBe(3);
    expect(r.uint32()).toBe(NfsProcedure.GETATTR);
    expect(decodeRpcCall(encodeRpcCall(call)).program).toBe(NFS_PROGRAM);
  });

  it('AUTH_SYS transporte la machine, l uid, le gid et les groupes', () => {
    const credential = encodeAuthSys({
      stamp: 7, machineName: 'ora-prod', uid: 54321, gid: 54321, gids: [54322, 54323],
    });
    expect(credential.flavor).toBe(RpcAuthFlavor.AUTH_SYS);
    const decoded = decodeAuthSys(credential);
    expect(decoded?.machineName).toBe('ora-prod');
    expect(decoded?.uid).toBe(54321);
    expect(decoded?.gids).toEqual([54322, 54323]);
  });

  it('AUTH_SYS refuse plus de seize groupes', () => {
    expect(() => encodeAuthSys({
      stamp: 0, machineName: 'h', uid: 0, gid: 0,
      gids: Array.from({ length: 17 }, (_, i) => i),
    })).toThrow();
  });

  it('une reponse refusee pour version se relit avec ses bornes', () => {
    const reply = encodeRpcReply({
      xid: 1,
      state: RpcReplyState.MSG_ACCEPTED,
      verifier: AUTH_NONE,
      acceptState: RpcAcceptState.PROG_MISMATCH,
      lowVersion: 3,
      highVersion: 3,
    });
    const decoded = decodeRpcReply(reply);
    expect(decoded.state).toBe(RpcReplyState.MSG_ACCEPTED);
    expect(decoded.state === RpcReplyState.MSG_ACCEPTED && decoded.acceptState)
      .toBe(RpcAcceptState.PROG_MISMATCH);
  });
});

describe('NFSv3 — les nombres de l implantation de reference', () => {
  it('les numeros de programme et le port sont ceux que le noyau declare', () => {
    expect(NFS_PROGRAM).toBe(100003);
    expect(MOUNT_PROGRAM).toBe(100005);
    expect(NFS_PORT).toBe(2049);
  });

  it('les vingt-deux procedures sont numerotees de NULL a COMMIT', () => {
    expect(NfsProcedure.NULL).toBe(0);
    expect(NfsProcedure.LOOKUP).toBe(3);
    expect(NfsProcedure.READ).toBe(6);
    expect(NfsProcedure.WRITE).toBe(7);
    expect(NfsProcedure.READDIRPLUS).toBe(17);
    expect(NfsProcedure.COMMIT).toBe(21);
  });

  it('les codes d erreur POSIX et les codes propres a la version 3 coexistent', () => {
    expect(NfsStatus.NFS3ERR_NOENT).toBe(2);
    expect(NfsStatus.NFS3ERR_ACCES).toBe(13);
    expect(NfsStatus.NFS3ERR_ROFS).toBe(30);
    expect(NfsStatus.NFS3ERR_STALE).toBe(70);
    expect(NfsStatus.NFS3ERR_BADHANDLE).toBe(10001);
    expect(NfsStatus.NFS3ERR_JUKEBOX).toBe(10008);
  });
});

describe('NFSv3 — chaque procedure se relit comme elle s ecrit', () => {
  it('LOOKUP rend la poignee puis les attributs de l objet puis ceux du repertoire', () => {
    const object = Uint8Array.from([9, 8, 7, 6]);
    const encoded = codec.encodeLookupResult({
      status: NfsStatus.NFS3_OK, object, objectAttributes: SAMPLE_ATTR, dirAttributes: null,
    });
    const decoded = codec.decodeLookupResult(encoded);
    expect(decoded.status).toBe(NfsStatus.NFS3_OK);
    expect(decoded.status === NfsStatus.NFS3_OK && Array.from(decoded.object))
      .toEqual([9, 8, 7, 6]);
    expect(decoded.dirAttributes).toBeNull();
  });

  it('LOOKUP en echec ne porte QUE les attributs du repertoire', () => {
    const decoded = codec.decodeLookupResult(codec.encodeLookupResult({
      status: NfsStatus.NFS3ERR_NOENT, dirAttributes: SAMPLE_ATTR,
    }));
    expect(decoded.status).toBe(NfsStatus.NFS3ERR_NOENT);
    expect(decoded.dirAttributes?.fileid).toBe(424242n);
  });

  it('READ porte son compte, son drapeau de fin et ses octets', () => {
    const data = Uint8Array.from([0, 255, 128, 1, 2]);
    const decoded = codec.decodeReadResult(codec.encodeReadResult({
      status: NfsStatus.NFS3_OK, fileAttributes: SAMPLE_ATTR, count: 5, eof: true, data,
    }));
    expect(decoded.status === NfsStatus.NFS3_OK && decoded.eof).toBe(true);
    expect(decoded.status === NfsStatus.NFS3_OK && Array.from(decoded.data))
      .toEqual([0, 255, 128, 1, 2]);
  });

  it('WRITE porte le wcc, le compte, le mode de validation et le verificateur', () => {
    const verifier = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const decoded = codec.decodeWriteResult(codec.encodeWriteResult({
      status: NfsStatus.NFS3_OK,
      fileWcc: { before: { size: 0n, mtime: SAMPLE_ATTR.mtime, ctime: SAMPLE_ATTR.ctime }, after: SAMPLE_ATTR },
      count: 4096,
      committed: StableHow.FILE_SYNC,
      verifier,
    }));
    expect(decoded.status === NfsStatus.NFS3_OK && decoded.count).toBe(4096);
    expect(decoded.status === NfsStatus.NFS3_OK && decoded.committed).toBe(StableHow.FILE_SYNC);
    expect(decoded.fileWcc.before?.size).toBe(0n);
  });

  it('WRITE transporte ses octets sans les traduire', () => {
    const data = Uint8Array.from([0, 1, 127, 128, 200, 255]);
    const decoded = codec.decodeWriteArgs(codec.encodeWriteArgs({
      file: Uint8Array.from([1]), offset: 8589934592n, count: data.length,
      stable: StableHow.UNSTABLE, data,
    }));
    expect(decoded.offset).toBe(8589934592n);
    expect(Array.from(decoded.data)).toEqual([0, 1, 127, 128, 200, 255]);
  });

  it('READDIR encode ses entrees en liste chainee terminee par un faux', () => {
    const decoded = codec.decodeReadDirResult(codec.encodeReadDirResult({
      status: NfsStatus.NFS3_OK,
      dirAttributes: null,
      cookieVerifier: new Uint8Array(8),
      entries: [
        { fileid: 1n, name: '.', cookie: 1n },
        { fileid: 2n, name: '..', cookie: 2n },
        { fileid: 3n, name: 'backup.bkp', cookie: 3n },
      ],
      eof: true,
    }));
    expect(decoded.status === NfsStatus.NFS3_OK && decoded.entries.map((e) => e.name))
      .toEqual(['.', '..', 'backup.bkp']);
    expect(decoded.status === NfsStatus.NFS3_OK && decoded.eof).toBe(true);
  });

  it('CREATE en mode EXCLUSIVE porte un verificateur, pas des attributs', () => {
    const verifier = Uint8Array.from([8, 7, 6, 5, 4, 3, 2, 1]);
    const decoded = codec.decodeCreateArgs(codec.encodeCreateArgs({
      where: { dir: Uint8Array.from([1]), name: 'x' },
      how: { mode: 2, verifier },
    }));
    expect(decoded.how.mode).toBe(2);
    expect(decoded.how.mode === 2 && Array.from(decoded.how.verifier))
      .toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('SETATTR distingue un champ absent d un champ mis a zero', () => {
    const decoded = codec.decodeSetAttrArgs(codec.encodeSetAttrArgs({
      object: Uint8Array.from([1]),
      newAttributes: { mode: 0, size: 0n },
      guardCtime: null,
    }));
    expect(decoded.newAttributes.mode).toBe(0);
    expect(decoded.newAttributes.size).toBe(0n);
    expect(decoded.newAttributes.uid).toBeUndefined();
    expect(decoded.guardCtime).toBeNull();
  });

  it('FSINFO et PATHCONF se relisent champ pour champ', () => {
    const fsinfo = codec.decodeFsInfoResult(codec.encodeFsInfoResult({
      status: NfsStatus.NFS3_OK, objectAttributes: null,
      readMax: 32768, readPreferred: 32768, readMultiple: 4096,
      writeMax: 32768, writePreferred: 32768, writeMultiple: 4096,
      readDirPreferred: 4096, maxFileSize: 0xffffffffffffn,
      timeDelta: { seconds: 0, nseconds: 1000 }, properties: 0x1b,
    }));
    expect(fsinfo.status === NfsStatus.NFS3_OK && fsinfo.maxFileSize).toBe(0xffffffffffffn);
    const pathconf = codec.decodePathConfResult(codec.encodePathConfResult({
      status: NfsStatus.NFS3_OK, objectAttributes: null,
      linkMax: 32000, nameMax: 255, noTrunc: true,
      chownRestricted: true, caseInsensitive: false, casePreserving: true,
    }));
    expect(pathconf.status === NfsStatus.NFS3_OK && pathconf.nameMax).toBe(255);
    expect(pathconf.status === NfsStatus.NFS3_OK && pathconf.caseInsensitive).toBe(false);
  });

  it('la liste des exports se relit avec ses groupes', () => {
    const decoded = codec.decodeExportList(codec.encodeExportList([
      { directory: '/srv/backup', groups: ['10.10.20.0/24', 'dr.example.com'] },
      { directory: '/srv/pub', groups: ['*'] },
    ]));
    expect(decoded.map((e) => e.directory)).toEqual(['/srv/backup', '/srv/pub']);
    expect(decoded[0].groups).toEqual(['10.10.20.0/24', 'dr.example.com']);
  });
});
