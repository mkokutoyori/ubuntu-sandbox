/**
 * FaultProjection — turns domain events into registry entries.
 *
 * This is the ONLY place that decides "this event means something is
 * broken". Nothing else writes to the registry, and the registry itself
 * decides nothing (docs/PRD-Pannes.md §6.1).
 *
 * Phase 1 subscribes to EXISTING topics only. No new event is published,
 * no behaviour changes anywhere — what was already happening in the model
 * simply becomes visible (docs/PRD-Pannes.md §25, Phase 1).
 *
 * Topic selection follows the same reasoning as `networkStore`'s autonomous
 * bridge: a small explicit allowlist, never `subscribeAll`, because the bus
 * also carries one event per Ethernet frame.
 */

import type { IEventBus, Unsubscribe } from '@/events/EventBus';
// This projection observes the topology to describe it, it never forwards
// anything — the layer docs/PRD-Frame-Only-Refactor.md §2.2 exempts, the
// same exemption `linux/network/HostLookup.ts` takes for the UI/terminal
// layer. It reads a device only to name it and to read its port state, and
// the events it reacts to carry no more than an id.
// eslint-disable-next-line no-restricted-imports
import { EquipmentRegistry } from '../equipment/EquipmentRegistry';
import { watchDevices } from '../equipment/DeviceWatch';
import type { FaultRegistry } from './FaultRegistry';
import { getFaultRegistry } from './FaultRegistry';
import { faultId } from './FaultTypes';

/**
 * Human name for a device id, falling back to the id when the device has
 * already left the registry (a power-off racing a removal).
 */
const REGISTRY_TOPICS = new Set<string>([
  'device.removed', 'device.deregistered', 'registry.cleared',
]);

function deviceName(deviceId: string): string {
  const dev = EquipmentRegistry.getInstance().getById(deviceId);
  return dev?.getHostname?.() ?? dev?.getName?.() ?? deviceId;
}

/**
 * Does this port carry an address an operator configured? An unused port
 * losing carrier is a `notice`; a port that was routing traffic is
 * `critical` (docs/PRD-Pannes.md §5, principle P7). Reading the live port
 * is cheap and avoids a second source of truth.
 *
 * IPv6 link-local addresses do NOT count: the stack autoconfigures one on
 * every interface that comes up, so counting them would make every cabled
 * port look addressed and collapse the distinction this function exists
 * for.
 */
function portIsAddressed(deviceId: string, portName: string): boolean {
  const dev = EquipmentRegistry.getInstance().getById(deviceId);
  const port = dev?.getPort?.(portName);
  if (!port) return false;
  if (port.getIPAddress() !== null) return true;
  return port.getIPv6Addresses().some(entry => !entry.address.isLinkLocal());
}

/**
 * Was this port taken down by an operator, rather than losing signal?
 *
 * The event's own `adminDown` flag is not enough. It mirrors `Port.adminDown`,
 * which only the Cisco/Huawei `shutdown` path sets (`setAdminShutdown`);
 * Linux's `ip link set <if> down` goes through `setUp(false)` and leaves the
 * flag false, so a deliberate interface shutdown arrives looking exactly
 * like a pulled cable.
 *
 * Rather than change what `ip link` writes — `docs/PRD-Link-State.md §3.2`
 * deliberately froze the meaning of `getIsUp()` because dozens of callers
 * depend on it — the distinction is *derived*: a port that is down while its
 * cable still carries signal was not unplugged, it was switched off.
 */
function portIsAdministrativelyDown(
  deviceId: string,
  portName: string,
  eventFlag: boolean | undefined,
): boolean {
  if (eventFlag) return true;
  const dev = EquipmentRegistry.getInstance().getById(deviceId);
  const port = dev?.getPort?.(portName);
  if (!port) return false;
  return !port.getIsUp() && port.hasCarrier();
}

export class FaultProjection {
  private readonly unsubs: Unsubscribe[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly faults: FaultRegistry,
  ) {
    this.wire();
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
  }

  private wire(): void {
    const perDevice = new Map<string, Parameters<IEventBus['subscribe']>[1][]>();
    const on = <T extends Parameters<IEventBus['subscribe']>[0]>(
      topic: T,
      handler: Parameters<IEventBus['subscribe']>[1],
    ) => {
      if (REGISTRY_TOPICS.has(topic)) {
        this.unsubs.push(this.bus.subscribe(topic, handler as never));
        return;
      }
      const existing = perDevice.get(topic);
      if (existing) existing.push(handler);
      else perDevice.set(topic, [handler]);
    };

    // ── F1 — physical ────────────────────────────────────────────
    on('port.link.down', ({ payload }) => {
      const { deviceId, portName, adminDown } = payload as {
        deviceId: string; portName: string; adminDown?: boolean;
      };
      // A device that is off takes its ports down with it; reporting each
      // port as its own incident would bury the one fact that matters.
      if (this.faults.has(deviceId, 'DEVICE_POWERED_OFF', 'device')) return;

      if (portIsAdministrativelyDown(deviceId, portName, adminDown)) {
        this.faults.raise({
          code: 'LINK_ADMIN_DOWN',
          deviceId,
          scope: portName,
          summary: `${portName} is administratively down`,
          investigate: `ip link show ${portName}`,
          remedy: `ip link set ${portName} up`,
        });
        return;
      }
      this.faults.raise({
        code: 'LINK_DOWN',
        deviceId,
        scope: portName,
        // Wording follows what Linux shows in `ip link` for a port with no
        // signal, so the incident text and the CLI agree.
        summary: `${portName} lost carrier (NO-CARRIER)`,
        severity: portIsAddressed(deviceId, portName) ? 'critical' : 'notice',
        investigate: `ip link show ${portName}`,
      });
    });

    on('port.link.up', ({ payload }) => {
      const { deviceId, portName } = payload as { deviceId: string; portName: string };
      this.faults.resolve(deviceId, 'LINK_DOWN', portName);
      this.faults.resolve(deviceId, 'LINK_ADMIN_DOWN', portName);
    });

    // ── F3 — port security ───────────────────────────────────────
    on('port.security.errdisable.set', ({ payload }) => {
      const { deviceId, portName, mac } = payload as {
        deviceId: string; portName: string; mac: { toString(): string };
      };
      this.faults.raise({
        code: 'LINK_ERRDISABLE',
        deviceId,
        scope: portName,
        summary: `${portName} put in err-disable state by a port-security violation (${mac.toString()})`,
        investigate: `show port-security interface ${portName}`,
      });
    });

    on('port.security.errdisable.cleared', ({ payload }) => {
      const { deviceId, portName } = payload as { deviceId: string; portName: string };
      this.faults.resolve(deviceId, 'LINK_ERRDISABLE', portName);
    });

    // ── F2 — power ───────────────────────────────────────────────
    on('device.power-off', ({ payload }) => {
      const { id } = payload as { id: string };
      // Powering a device off is a deliberate act, so it is a `notice` on
      // the device itself. What its NEIGHBOURS lose is their problem, and
      // they raise their own carrier faults (docs/PRD-Pannes.md §19.1).
      this.faults.raise({
        code: 'DEVICE_POWERED_OFF',
        deviceId: id,
        scope: 'device',
        summary: `${deviceName(id)} is powered off`,
      });
      // Its own ports going down are a consequence, not news.
      this.faults.resolveAllOfCode(id, 'LINK_DOWN');
      this.faults.resolveAllOfCode(id, 'LINK_ADMIN_DOWN');
    });

    on('device.power-on', ({ payload }) => {
      const { id } = payload as { id: string };
      this.faults.resolve(id, 'DEVICE_POWERED_OFF', 'device');
    });

    // A device that leaves the topology takes its incidents with it —
    // otherwise the incident centre accumulates dead references
    // (docs/PRD-Pannes.md §F2.8).
    on('device.removed', ({ payload }) => {
      const { id } = payload as { id: string };
      this.faults.resolveAllForDevice(id);
    });
    on('device.deregistered', ({ payload }) => {
      const { id } = payload as { id: string };
      this.faults.resolveAllForDevice(id);
    });

    // Clearing the canvas powers every device off on the way out, which
    // raises a `DEVICE_POWERED_OFF` per device — and then removes them
    // without a per-device `device.removed`. Without this the incident
    // board survives the topology it described.
    on('registry.cleared', () => {
      for (const fault of this.faults.list()) this.faults.resolveById(fault.id);
    });

    // ── F6 — services ────────────────────────────────────────────
    on('linux.service.failed', ({ payload }) => {
      const { deviceId, name, reason } = payload as {
        deviceId: string; name: string; reason: string;
      };
      this.faults.raise({
        code: 'SERVICE_FAILED',
        deviceId,
        scope: name,
        summary: `${name}.service failed: ${reason}`,
        investigate: `systemctl status ${name}`,
        remedy: `systemctl restart ${name}`,
        causedBy: this.deviceLevelCauses(deviceId),
      });
    });

    on('linux.service.start-limited', ({ payload }) => {
      const { deviceId, name } = payload as { deviceId: string; name: string };
      this.faults.raise({
        code: 'SERVICE_START_LIMITED',
        deviceId,
        scope: name,
        // systemd's own wording, so `systemctl status` and the incident
        // say the same thing (docs/PRD-Pannes.md §5, principle P3).
        summary: `${name}.service: start request repeated too quickly`,
        investigate: `systemctl status ${name}`,
        remedy: `systemctl reset-failed ${name} && systemctl start ${name}`,
      });
    });

    const clearService = ({ payload }: { payload: unknown }) => {
      const { deviceId, name } = payload as { deviceId: string; name: string };
      this.faults.resolve(deviceId, 'SERVICE_FAILED', name);
      this.faults.resolve(deviceId, 'SERVICE_START_LIMITED', name);
    };
    on('linux.service.started', clearService);
    on('linux.service.restarted', clearService);
    on('linux.service.stopped', clearService);

    const topics = [...perDevice.keys()] as Parameters<IEventBus['subscribe']>[0][];
    this.unsubs.push(watchDevices(topics, (event) => {
      for (const handler of perDevice.get(event.topic) ?? []) {
        (handler as (e: unknown) => void)(event);
      }
    }));
  }

  /**
   * Device-wide faults a per-resource fault should hang off. Keeps the
   * incident centre grouped by cause rather than flat.
   */
  private deviceLevelCauses(deviceId: string): readonly string[] | undefined {
    const id = faultId(deviceId, 'DEVICE_POWERED_OFF', 'device');
    return this.faults.get(id) ? [id] : undefined;
  }
}

// ─── Default wiring ──────────────────────────────────────────────

let attachedBus: IEventBus | null = null;
let projection: FaultProjection | null = null;

/**
 * Attach the projection to the current default bus, re-attaching if the
 * bus was swapped. Cheap reference check on every call, for exactly the
 * reason `networkStore.ensureAutonomousEventBridge` does the same: the
 * global test setup nulls the default bus before every test, so a
 * subscribe-once-at-import would go dead after the first test of a file.
 */
export function ensureFaultProjection(): FaultProjection {
  const bus = EquipmentRegistry.getInstance().getBus();
  if (bus !== attachedBus || !projection) {
    projection?.dispose();
    attachedBus = bus;
    projection = new FaultProjection(bus, getFaultRegistry());
  }
  return projection;
}

export function __resetFaultProjection(): void {
  projection?.dispose();
  projection = null;
  attachedBus = null;
}
