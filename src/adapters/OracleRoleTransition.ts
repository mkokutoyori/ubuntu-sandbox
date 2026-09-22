/**
 * OracleRoleTransition — la bascule, sur le fil.
 *
 * Quand le primaire demande un switchover, l'ordre part vers la standby
 * par la meme voie que le redo : l'identifiant TNS de sa destination se
 * resout, une session Oracle Net s'ouvre, et c'est la standby qui decide
 * si elle peut prendre le role. Rien ne va chercher la reponse sur
 * l'objet du pair.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
import type { Equipment } from '@/network/equipment/Equipment';
import type { OracleDatabase } from '@/database/oracle/OracleDatabase';
import type { HostCapableDevice } from '@/network';
import { readArchiveDestinations } from '@/database/oracle/dataguard/ArchiveDestination';
import { OracleNetCallStatus } from '@/network/oracle-net/wire/OracleNetCall';
import { executeOverOracleNet, logonOverOracleNet } from '@/network/oracle-net/OracleNetSqlClient';

export interface OracleRoleTransitionCtx {
  resolveDevice(deviceId: string): Equipment | null;
  resolveDatabase(deviceId: string): OracleDatabase | null;
  dial(local: HostCapableDevice, identifier: string): {
    ok: boolean;
    session?: { call(p: Uint8Array): Uint8Array | null; isOpen(): boolean; close(): void };
    error?: string;
  };
}

const IDENTITY = {
  osUser: 'oracle', osGroup: 'dba', hostname: 'primary',
  terminal: 'unknown', program: 'oracle',
};

export class OracleRoleTransition {
  private subs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly ctx: OracleRoleTransitionCtx,
  ) {}

  start(): void {
    this.subs.push(
      this.bus.subscribe('oracle.dataguard.switchover-requested', (e) => {
        e.payload.accept(this.basculer(e.payload.deviceId, e.payload.target));
      }),
    );
  }

  stop(): void {
    for (const u of this.subs) u();
    this.subs = [];
  }

  private basculer(deviceId: string, target: string): string {
    const db = this.ctx.resolveDatabase(deviceId);
    const local = this.ctx.resolveDevice(deviceId);
    if (!db || !local) return 'ORA-16664: unable to receive the result from a member';
    const destination = readArchiveDestinations(db.instance.getAllParameters())
      .find(d => d.kind === 'SERVICE' && (d.dbUniqueName ?? d.target) === target);
    if (!destination) return `ORA-16642: db_unique_name ${target} mismatch`;

    const ouverture = this.ctx.dial(local as unknown as HostCapableDevice, destination.target);
    if (!ouverture.ok || !ouverture.session) {
      return ouverture.error ?? 'ORA-16664: unable to receive the result from a member';
    }
    const session = ouverture.session as never;
    const entree = logonOverOracleNet(session, {
      username: 'SYS', password: 'oracle', asSysdba: true, identity: IDENTITY,
    });
    if (entree.status === OracleNetCallStatus.Error) {
      ouverture.session.close();
      return entree.error;
    }
    const reponse = executeOverOracleNet(session, 'ALTER DATABASE SWITCHOVER TO PRIMARY');
    ouverture.session.close();
    if (reponse.status === OracleNetCallStatus.Error) return reponse.error;
    const message = reponse.result?.message ?? '';
    return message.startsWith('ORA-') ? message : 'Database altered.';
  }
}
