import { describe, it, expect } from 'vitest';
import { DatabaseAvailabilityGroup } from '@/network/devices/windows/server/exchange/DatabaseAvailabilityGroup';

describe('DatabaseAvailabilityGroup (docs/PRD-Exchange.md §4.5, P11)', () => {
  it('addServer() fails for a duplicate member', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    expect(dag.addServer('SRV1').ok).toBe(true);
    expect(dag.addServer('SRV1').ok).toBe(false);
  });

  it('addDatabaseCopy() requires the server to already be a DAG member', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    const res = dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not a member');
  });

  it('a freshly-added copy starts Healthy with zero queue length', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV2');
    dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);
    const status = dag.getCopyStatus('MailboxDatabase1', 'SRV2');
    expect(status).toEqual({ database: 'MailboxDatabase1', server: 'SRV2', status: 'Healthy', copyQueueLength: 0, lastSyncedAt: 1000 });
  });

  it('recordChange() increases copyQueueLength for every existing copy until synced', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV2');
    dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);

    dag.recordChange();
    dag.recordChange();
    const status = dag.getCopyStatus('MailboxDatabase1', 'SRV2')!;
    expect(status.copyQueueLength).toBe(2);
    expect(status.status).toBe('Resynchronizing');

    dag.updateCopy('MailboxDatabase1', 'SRV2', 2000);
    const synced = dag.getCopyStatus('MailboxDatabase1', 'SRV2')!;
    expect(synced.copyQueueLength).toBe(0);
    expect(synced.status).toBe('Healthy');
    expect(synced.lastSyncedAt).toBe(2000);
  });

  it('a copy added after some changes already happened only lags behind changes recorded afterwards', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV2');
    dag.recordChange();
    dag.recordChange();
    dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);
    expect(dag.getCopyStatus('MailboxDatabase1', 'SRV2')!.copyQueueLength).toBe(0);
    dag.recordChange();
    expect(dag.getCopyStatus('MailboxDatabase1', 'SRV2')!.copyQueueLength).toBe(1);
  });

  it('adding a second DAG member with no database copy does not create any copy record', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV1');
    dag.addServer('SRV2');
    expect(dag.listCopyStatuses()).toEqual([]);
  });

  it('listCopyStatuses(database) filters to just that database', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV2');
    dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);
    dag.addDatabaseCopy('MailboxDatabase2', 'SRV2', 1000);
    expect(dag.listCopyStatuses('MailboxDatabase1')).toHaveLength(1);
    expect(dag.listCopyStatuses()).toHaveLength(2);
  });

  it('updateCopy() fails cleanly for a copy that does not exist', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    const res = dag.updateCopy('MailboxDatabase1', 'SRV2', 1000);
    expect(res.ok).toBe(false);
  });

  it('addDatabaseCopy() fails cleanly for a duplicate copy', () => {
    const dag = new DatabaseAvailabilityGroup('DAG1');
    dag.addServer('SRV2');
    dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 1000);
    const res = dag.addDatabaseCopy('MailboxDatabase1', 'SRV2', 2000);
    expect(res.ok).toBe(false);
  });
});
