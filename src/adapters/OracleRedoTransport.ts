/**
 * OracleRedoTransport — le LNS du primaire.
 *
 * Chaque `LOG_ARCHIVE_DEST_n` de la forme `SERVICE=<tns>` dont l'etat
 * est ENABLE recoit, a chaque journal archive, ce journal SUR LE FIL :
 * l'identifiant TNS se resout comme celui d'un sqlplus, une session
 * Oracle Net s'ouvre vraiment, et l'appel ShipRedo la traverse. C'est
 * le RFS de la standby qui ecrit le fichier sur SON disque.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { HostCapableDevice } from '@/network';
import { readArchiveDestinations } from '@/database/oracle/dataguard/ArchiveDestination';
import { OracleNetCallStatus } from '@/network/oracle-net/wire/OracleNetCall';
import { shipRedoOverOracleNet } from '@/network/oracle-net/OracleNetSqlClient';

export interface OracleRedoTransportCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
  /** Ouvre une session Oracle Net vers un identifiant TNS, comme sqlplus. */
  dial(local: HostCapableDevice, identifier: string): {
    ok: boolean; session?: { call(p: Uint8Array): Uint8Array | null; isOpen(): boolean; close(): void };
    error?: string;
  };
}

export class OracleRedoTransport {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleRedoTransportCtx,
  ) {}

  start(): void {
    this.subs.push(
      this.bus.subscribe('oracle.archive-log.created', (e) => {
        if ((e.payload.origin ?? 'SWITCH') !== 'SWITCH') return;
        this.expedier(e.payload.deviceId, {
          name: e.payload.path,
          sequence: e.payload.sequence,
          scn: e.payload.scn,
        });
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }

  private expedier(
    deviceId: string, journal: { name: string; sequence: number; scn: number },
  ): void {
    const db = this.ctx.resolveDatabase(deviceId);
    const local = this.ctx.resolveDevice(deviceId);
    if (!db || !local) return;
    const instance = db.instance;
    const destinations = readArchiveDestinations(instance.getAllParameters())
      .filter(d => d.kind === 'SERVICE' && d.state === 'ENABLE');
    if (destinations.length === 0) return;
    const corps = this.corpsDuJournal(local, journal.name);
    if (corps === null) return;

    for (const dest of destinations) {
      const ouverture = this.ctx.dial(local as unknown as HostCapableDevice, dest.target);
      if (!ouverture.ok || !ouverture.session) {
        instance.recordTransportFailure(dest.destId,
          ouverture.error ?? 'ORA-12154: TNS:could not resolve the connect identifier specified');
        continue;
      }
      const reponse = shipRedoOverOracleNet(ouverture.session as never, {
        thread: 1,
        sequence: journal.sequence,
        name: journal.name,
        scn: journal.scn,
        body: corps,
        fromDbUniqueName: instance.config.sid.toUpperCase(),
      });
      ouverture.session.close();
      if (reponse.status === OracleNetCallStatus.Error) {
        instance.recordTransportFailure(dest.destId, reponse.error);
        continue;
      }
      instance.recordTransportSuccess(dest.destId, journal.sequence, dest.dbUniqueName ?? dest.target);
    }
  }

  private corpsDuJournal(local: Equipment, path: string): string | null {
    const dev = local as unknown as {
      readFileForEditor?(p: string): string | null;
      readFile?(p: string): string | null;
    };
    return dev.readFileForEditor?.(path) ?? dev.readFile?.(path) ?? null;
  }
}
