/**
 * Probe — impstats formats "prometheus" and "zabbix" and the log.file.overwrite parameter, ported from
 * runtime/statsobj.c (emitPrometheusForObject, encodePrometheusMetricName) and plugins/impstats/impstats.c
 * (generateZabbixStats, runInput) of rsyslog 8.2608.0.
 *
 * Measured against the base commit (git stash of src/network): 6 of the 8 cases fall - the parameter
 * log.file.overwrite is refused as unknown and the two formats are answered "invalid format". Two pass in both
 * states: the WITNESS (append mode) and the refusal of an unknown format (non-regression).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { prometheusMetricName } from '@/network/rsyslog/engine/Statistics';
import { LabHost, LabNetwork, lines, startRsyslog } from './_helpers/rsyslogLab';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const TRADITIONAL = '$ActionFileDefaultTemplate RSYSLOG_TraditionalFileFormat\n';

function rig(config: string): { host: LabHost; lab: ReturnType<typeof startRsyslog> } {
  const host = new LabHost('10.0.0.1', new LabNetwork());
  return { host, lab: startRsyslog(host, config) };
}

const statsFile = (host: LabHost): string[] => lines(host.fileSystem.get('/var/log/stats.log') ?? null);

describe('impstats formats and overwrite', () => {
  it('witness: append mode keeps every report in the file', () => {
    const { host } = rig(`module(load="impstats" interval="60" log.file="/var/log/stats.log" log.syslog="off")`);
    host.advance(120_000);
    expect(statsFile(host).filter((line) => line.includes('resource-usage:')).length).toBe(2);
  });

  it('overwrite keeps only the report of the last interval', () => {
    const { host } = rig(`module(load="impstats" interval="60" log.file="/var/log/stats.log" log.file.overwrite="on" log.syslog="off")`);
    host.advance(180_000);
    expect(statsFile(host).filter((line) => line.includes('resource-usage:')).length).toBe(1);
  });

  it('prometheus emits HELP, TYPE and the sample as one multi-line message per counter', () => {
    const { host } = rig(`${TRADITIONAL}module(load="impstats" interval="60" format="prometheus")\n*.* /var/log/x.log`);
    host.advance(60_000);
    const text = (host.fileSystem.get('/var/log/x.log') ?? '');
    expect(text).toContain('# TYPE U__resource_2D_usage__utime__total counter\nU__resource_2D_usage__utime__total 0\n');
  });

  it('prometheus encodes names that are not legacy-safe with the reversible U__ prefix', () => {
    expect(prometheusMetricName('main Q_size_total')).toBe('U__main_20_Q__size__total');
    expect(prometheusMetricName('imudp(w0)_submitted_total')).toBe('U__imudp_28_w0_29___submitted__total');
    expect(prometheusMetricName('a.b_total')).toBe('U__a_2E_b__total');
  });

  it('prometheus leaves legacy-safe names unchanged and encodes a name that starts with U__', () => {
    expect(prometheusMetricName('imuxsock_submitted_total')).toBe('imuxsock_submitted_total');
    expect(prometheusMetricName('U__x')).toBe('U__U____x');
  });

  it('zabbix groups the objects by origin into one object per report', () => {
    const { host } = rig(`module(load="impstats" interval="60" format="zabbix" log.file="/var/log/stats.log" log.syslog="off")\n*.* /var/log/x.log`);
    host.advance(60_000);
    const [line] = statsFile(host);
    expect(line).toMatch(/: \{ "timedate": "\w{3} \w{3} \d{2} [\d:]{8} \d{4}", "stats_dynstats": \[\{ "name": "global"/);
    expect(line).toContain('"stats_core_queue": [{ "name": "main Q"');
    expect(line).toContain('"stats_impstats": [{ "name": "resource-usage"');
    expect(line.endsWith(']}')).toBe(true);
  });

  it('zabbix with log.syslog on and no log.file warns about truncation', () => {
    const { lab } = rig(`module(load="impstats" interval="60" format="zabbix")`);
    expect(lab.loader.log.lines().some((line) => line.includes('format set to "zabbix" without log.file set'))).toBe(true);
  });

  it('an unknown format is still refused', () => {
    const { lab } = rig(`module(load="impstats" format="yaml")`);
    expect(lab.loader.log.lines().some((line) => line.includes('impstats: invalid format yaml'))).toBe(true);
  });
});
