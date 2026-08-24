import { resolveFortiTimezone } from '../schema/timezones';
import { FortiMessages } from '../FortiMessages';
import type { Firewall } from '../../../Firewall';
import type { AntivirusFailopen } from '../../../health/SystemLoad';
import type { FortiCommitDevice, FortiSchemaEnvironment } from '../schema/types';
import {
  makeSchedule, makeOnetimeSchedule, makeScheduleGroup,
} from '../../../model/ScheduleObject';
import { vipAddress } from '../../../model/AddressObject';
import { identityCommitHandlers } from '../commit/identityCommits';
import { vpnCommitHandlers } from '../commit/vpnCommits';
import {
  applyBalancedVipToFirewall, applyCentralSnatToFirewall, applyFqdnVipToFirewall,
  applyVipToFirewall, categoryEntry,
  centralSnatRuleId,
  filterTable, urlEntry, utmAction, vipRuleId,
} from '../commit/objectCommits';
import type { PolicyRoutePrefix } from '../../../l3/PolicyRouteTable';
import { makeIpPool, type IpPoolType } from '../../../nat/IpPool';
import { proxyOwnerKey } from '../../../Firewall';
import { passwordHistoryRefusal, passwordHistoryThreshold } from '../schema/passwordPolicy';

export function buildCommitDevice(
  fw: Firewall, environment: FortiSchemaEnvironment,
): FortiCommitDevice {
  return {
      applyInterface(name, patch) {
        if (patch.vdom) fw.assignInterfaceToVdom(name, patch.vdom);
        if (patch.ip && patch.mask) fw.configureInterface(name, { ip: patch.ip, mask: patch.mask });
        if (patch.up !== undefined) fw.setInterfaceUp(name, patch.up);
        if (patch.allowAccess) fw.setAllowedAccess(name, patch.allowAccess);
        fw.setInterfaceMtu(name, patch.mtu);
      },
      applyZone(name, members, intrazone) {
        const zones = fw.getZoneTable();
        if (!zones.getZone(name)) {
          zones.createZone(name, { intraZoneAction: intrazone === 'allow' ? 'allow' : 'deny' });
        }
        for (const member of members) zones.assignInterface(name, member);
      },
      removeZone(name) {
        fw.getZoneTable().deleteZone(name);
      },
      applyStaticRoute(route) {
        fw.applySdwanStaticRoute(route);
      },
      applySdwan(patch) {
        return fw.applySdwan(patch);
      },
      applyHa(patch) {
        return fw.applyHa(patch);
      },
      hasInterface(name) {
        return fw.getPort(name) !== undefined;
      },
      applyRip(patch) {
        return fw.getRouting().applyRip(patch);
      },
      applyOspf(patch) {
        return fw.getRouting().applyOspf(patch);
      },
      applyBgp(patch) {
        return fw.getRouting().applyBgp(patch);
      },
      applyDhcpScope(scope) {
        fw.getDhcp().upsertScope(scope);
      },
      removeDhcpScope(id) {
        fw.getDhcp().removeScope(id);
      },
      acquireDhcpLease(iface) {
        fw.getDhcp().acquireLease(iface);
      },
      removeStaticRoute(id) {
        fw.forgetSdwanStaticRoute(id);
        fw.getRouteTable().removeStaticsBySource(id);
        fw.getRouteTable().removeStaticById(id);
      },
      applySchedule(schedule) {
        const built = makeSchedule(schedule.name, schedule.days, schedule.start, schedule.end);
        if (built) fw.setSchedule(built);
      },
      removeSchedule(name) {
        fw.getScheduleStore().remove(name);
      },
      applyOnetimeSchedule(schedule) {
        const built = makeOnetimeSchedule(schedule.name, schedule.start, schedule.end);
        if (!built) return 'start and end must read hh:mm yyyy/mm/dd, end after start.';
        fw.setSchedule(built);
      },
      applyScheduleGroup(group) {
        const store = fw.getScheduleStore();
        const unknown = group.members.filter(member => store.get(member) === undefined);
        if (unknown.length > 0) return `unknown schedule ${unknown[0]}.`;
        fw.setSchedule(makeScheduleGroup(group.name, group.members));
      },
      applyNtp(settings) {
        return fw.getNtp().apply(settings);
      },
      applyVdomSettings(settings) {
        fw.setCentralNat(settings.centralNat);
        fw.setOperationMode(settings.opmode);
        if (settings.manageIP && settings.manageIP !== '0.0.0.0') {
          fw.setManagementAddress(settings.manageIP,
            settings.manageMask ?? '255.255.255.0', settings.gateway);
        }
      },
      applyDnsSettings(settings) {
        fw.getDnsClient().applySettings(settings);
      },
      resolveFqdnNow(fqdn) {
        fw.getDnsClient().forget(fqdn);
        fw.getDnsClient().query(fqdn);
        fw.refreshFqdnVips();
      },
      applyDnsServerInterface(entry) {
        fw.getDnsServer().applyInterface(entry);
      },
      removeDnsServerInterface(iface) {
        fw.getDnsServer().removeInterface(iface);
      },
      applyDnsZone(zone) {
        fw.getDnsServer().applyZone(zone);
      },
      removeDnsZone(name) {
        fw.getDnsServer().removeZone(name);
      },
      applyConsoleSettings(settings) {
        fw.getConsoleSettings().apply(settings);
      },
      applyHostname(hostname) {
        if (hostname.length > 0) fw.setName(hostname);
      },
      applyGlobalSettings(settings) {
        if (settings.hostname !== undefined && settings.hostname.length > 0) {
          fw.setName(settings.hostname);
        }
        const zone = settings.timezone === undefined
          ? null : resolveFortiTimezone(settings.timezone);
        if (zone) fw.setTimezone(zone.name);
        fw.setMultiVdom(settings.multiVdom);
        if (settings.authHttpPort !== undefined && settings.authHttpsPort !== undefined) {
          fw.setAuthPortalPorts(settings.authHttpPort, settings.authHttpsPort);
        }
        fw.setManagementPorts({
          ssh: settings.adminSshPort,
          telnet: settings.adminTelnetPort,
          http: settings.adminHttpPort,
          https: settings.adminHttpsPort,
        });
        if (settings.adminTimeoutMin !== undefined) {
          fw.setAdminIdleTimeout(settings.adminTimeoutMin);
        }
        if (settings.adminLockoutThreshold !== undefined
          && settings.adminLockoutDurationSec !== undefined) {
          fw.setAdminLockout(
            settings.adminLockoutThreshold, settings.adminLockoutDurationSec);
        }
        fw.getLoginBanners().enable('pre', settings.preLoginBanner === true);
        fw.getLoginBanners().enable('post', settings.postLoginBanner === true);
        if (settings.conserveThresholds !== undefined) {
          fw.getSystemLoad().setThresholds(settings.conserveThresholds);
        }
        if (settings.revisionOnLogout !== undefined) {
          fw.setRevisionOnLogout(settings.revisionOnLogout);
        }
        if (settings.avFailopen !== undefined) {
          fw.getSystemLoad().setAntivirusFailopen(
            settings.avFailopen as AntivirusFailopen);
        }
      },
      applyLdbMonitor(monitor) {
        fw.getLdbMonitors().set(monitor);
      },
      applyFragmentMemoryThreshold(megabytes) {
        fw.getFragmentReassembly().setThresholdMegabytes(megabytes);
      },
      refusePasswordReuse(admin, secret) {
        return passwordHistoryRefusal(
          admin, secret, environment, fw.getPasswordHistory());
      },
      refuseBoundInterface(iface, excludingTable) {
        if (iface.length === 0) return null;
        const holders = (environment.referenceHolders?.(['system', 'interface'], iface)
          ?? []).filter(line => !line.includes(` ${excludingTable}`));
        if (holders.length === 0) return null;
        return FortiMessages.notInDatasource(iface,
          `"${iface}" is still referenced — `
          + `\`diagnose sys cmdb refcnt show system.interface.name ${iface}\` `
          + `lists ${holders.length === 1 ? 'it' : `all ${holders.length}`}; `
          + 'remove the reference before adding the interface here.');
      },
      refuseReuseLimit(limit) {
        const kept = passwordHistoryThreshold(environment);
        if (limit <= kept) return null;
        return `reuse-password-limit cannot exceed user-history-password-threshold `
          + `(${kept}).`;
      },
      removeLdbMonitor(name) {
        fw.getLdbMonitors().remove(name);
      },
      applyBalancedVip(vip) {
        return applyBalancedVipToFirewall(fw, vip);
      },
      applyIpsGlobal(settings) {
        fw.getSystemLoad().setIpsFailOpen(settings.failOpen);
      },
      applyReplacementMessage(message, buffer) {
        fw.getLoginBanners().setBuffer(message, buffer);
      },
      setCaptivePortalInterface(iface, on) {
        fw.setCaptivePortalInterface(iface, on);
      },
      refreshCaptivePortal() {
        fw.refreshCaptivePortal();
      },
      applySyslogCollector(settings) {
        fw.getSyslogCollectors().applySettings(settings);
      },
      applySyslogFilter(settings) {
        fw.getSyslogCollectors().applyFilter(settings);
      },
      applyVdom(name) {
        fw.getVdomRegistry().create(name);
      },
      removeVdom(name) {
        fw.getVdomRegistry().remove(name);
      },
      applyVdomLink(name) {
        fw.createVdomLink(name);
      },
      removeVdomLink(name) {
        fw.removeVdomLink(name);
      },
      applySwitchInterface(name, members) {
        fw.setSwitchInterface(name, members);
      },
      removeSwitchInterface(name) {
        fw.removeSwitchInterface(name);
      },
      applyAntivirusProfile(profile) {
        fw.getUtmProfiles().setAntivirus({
          name: profile.name,
          httpScan: utmAction(profile.http),
          ftpScan: utmAction(profile.ftp),
          smtpScan: utmAction(profile.smtp),
          comment: profile.comment,
        });
      },
      removeAntivirusProfile(name) {
        fw.getUtmProfiles().removeAntivirus(name);
      },
      applyApplicationList(list) {
        fw.getUtmProfiles().setApplicationList({
          name: list.name,
          entries: list.entries.map(entry => ({
            id: entry.id,
            application: entry.application,
            action: entry.action === 'allow' ? 'allow' : 'block',
          })),
          comment: list.comment,
        });
      },
      removeApplicationList(name) {
        fw.getUtmProfiles().removeApplicationList(name);
      },
      applyWebFilterProfile(profile) {
        fw.getUtmProfiles().setWebFilter({
          name: profile.name,
          urlFilterTable: profile.urlFilterTable,
          categoryFilters: profile.categoryFilters.map(categoryEntry),
          unclassifiedAction: utmAction(profile.unclassifiedAction),
          logAllUrl: profile.logAllUrl,
          featureSet: profile.featureSet,
          comment: profile.comment,
        });
      },
      webFilterFeatureSet(name) {
        return fw.getUtmProfiles().getWebFilter(name)?.featureSet;
      },
      removeWebFilterProfile(name) {
        fw.getUtmProfiles().removeWebFilter(name);
      },
      applyDnsFilterProfile(profile) {
        fw.getUtmProfiles().setDnsFilter({
          name: profile.name,
          domainFilterTable: profile.domainFilterTable,
          categoryFilters: profile.categoryFilters.map(categoryEntry),
          unclassifiedAction: utmAction(profile.unclassifiedAction),
          comment: profile.comment,
        });
      },
      removeDnsFilterProfile(name) {
        fw.getUtmProfiles().removeDnsFilter(name);
      },
      applyFileFilterProfile(profile) {
        fw.getUtmProfiles().setFileFilter({
          name: profile.name,
          entries: profile.entries.map(entry => ({
            id: entry.id,
            fileTypes: [...entry.fileTypes],
            action: utmAction(entry.action),
            direction: entry.direction === 'incoming' || entry.direction === 'outgoing'
              ? entry.direction
              : 'any',
          })),
          scanArchiveContents: profile.scanArchiveContents,
          comment: profile.comment,
        });
      },
      removeFileFilterProfile(name) {
        fw.getUtmProfiles().removeFileFilter(name);
      },
      applySslSshProfile(profile) {
        fw.getUtmProfiles().setSslSsh({
          name: profile.name,
          httpsMode: profile.httpsMode === 'certificate-inspection'
            || profile.httpsMode === 'deep-inspection'
            ? profile.httpsMode
            : 'disable',
          httpsPorts: [...profile.httpsPorts],
          caName: profile.caName,
          untrustedCaName: profile.untrustedCaName,
          serverCertMode: profile.serverCertMode,
          exemptions: profile.exemptions?.map(entry => ({ ...entry })),
          comment: profile.comment,
        });
      },
      removeSslSshProfile(name) {
        fw.getUtmProfiles().removeSslSsh(name);
      },
      applyProtocolOptions(options) {
        fw.getUtmProfiles().setProtocolOptions({
          name: options.name,
          httpPorts: [...options.httpPorts],
          httpsPorts: [...options.httpsPorts],
          ftpPorts: [...options.ftpPorts],
          dnsPorts: [...options.dnsPorts],
          oversizeLimitMb: options.oversizeLimitMb,
          blockOversize: options.blockOversize,
          comment: options.comment,
        });
      },
      removeProtocolOptions(name) {
        fw.getUtmProfiles().removeProtocolOptions(name);
      },
      ...identityCommitHandlers(fw),
      ...vpnCommitHandlers(fw),
      applyUrlFilterTable(table) {
        fw.getUtmProfiles().setUrlFilterTable(filterTable(table));
      },
      removeUrlFilterTable(id) {
        fw.getUtmProfiles().removeUrlFilterTable(id);
      },
      applyDomainFilterTable(table) {
        fw.getUtmProfiles().setDomainFilterTable(filterTable(table));
      },
      removeDomainFilterTable(id) {
        fw.getUtmProfiles().removeDomainFilterTable(id);
      },
      applyIpPool(pool) {
        fw.setIpPool(makeIpPool({ ...pool, type: pool.type as IpPoolType }));
      },
      removeIpPool(name) {
        fw.removeIpPool(name);
      },
      applyFqdnVip(vip) {
        return applyFqdnVipToFirewall(fw, vip);
      },
      applyVip(vip) {
        applyVipToFirewall(fw, vip);
      },
      removeVip(name) {
        fw.getNatPolicy().remove(vipRuleId(name));
        fw.getObjectStore().removeAddress(name);
        fw.clearProxyArpEntries(proxyOwnerKey('vip', name));
      },
      applyCentralSnat(entry) {
        applyCentralSnatToFirewall(fw, entry);
      },
      removeCentralSnat(id) {
        fw.getNatPolicy().remove(centralSnatRuleId(id));
      },
      applyPolicyRoute(route) {
        fw.getPolicyRoutes().upsert({
          id: route.id,
          enabled: route.enabled,
          action: route.action,
          inputDevices: route.inputDevices,
          sourcePrefixes: route.sources.map(toPrefix).filter(isPrefix),
          destinationPrefixes: route.destinations.map(toPrefix).filter(isPrefix),
          protocol: route.protocol,
          startPort: route.startPort,
          endPort: route.endPort,
          startSourcePort: route.startSourcePort,
          endSourcePort: route.endSourcePort,
          outputDevice: route.outputDevice,
          gateway: route.gateway,
          comment: route.comment,
        }, route.position);
      },
      removePolicyRoute(id) {
        fw.getPolicyRoutes().remove(id);
      },
      applyMemoryLog(patch) {
        if (patch.capacity !== undefined) fw.getLogStore().setCapacity(patch.capacity);
        if (patch.maxBytes !== undefined) fw.getLogStore().setMaxBytes(patch.maxBytes);
        if (patch.fullThresholds) fw.getLogStore().setFullThresholds(patch.fullThresholds);
        if (patch.enabled === false) fw.getLogStore().clear();
        fw.getSystemLoad().reassess();
      },
  };
}

function toPrefix(raw: string): PolicyRoutePrefix | null {
  const [network, length] = raw.split('/');
  if (network === undefined) return null;
  if (length === undefined) return { network, mask: '255.255.255.255' };

  const bits = Number.parseInt(length, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return null;
  return { network, mask: maskOfLength(bits) };
}

function isPrefix(value: PolicyRoutePrefix | null): value is PolicyRoutePrefix {
  return value !== null;
}

function maskOfLength(bits: number): string {
  const value = bits === 0 ? 0 : ((0xffffffff << (32 - bits)) >>> 0);
  return [24, 16, 8, 0].map(shift => (value >>> shift) & 0xff).join('.');
}
