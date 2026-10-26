import { useRef } from 'react';
import type { Connection, NetworkDeviceUI } from '@/store/networkStore';
import { computeCableRoutes, type CableRoute, type RoutedLink } from './connection-line-logic';

export function routedLinksOf(
  connections: ReadonlyArray<Connection>,
  devices: ReadonlyArray<NetworkDeviceUI>,
): RoutedLink[] {
  const byId = new Map(devices.map(device => [device.id, device]));
  return connections.flatMap(connection => {
    const source = byId.get(connection.sourceDeviceId);
    const target = byId.get(connection.targetDeviceId);
    if (!source || !target) return [];
    return [{
      id: connection.id,
      sourceDeviceId: connection.sourceDeviceId,
      targetDeviceId: connection.targetDeviceId,
      source: { x: source.x, y: source.y },
      target: { x: target.x, y: target.y },
      sourceInterface: connection.sourceInterfaceId,
      targetInterface: connection.targetInterfaceId,
    }];
  });
}

export function useCableRoutes(
  connections: ReadonlyArray<Connection>,
  devices: ReadonlyArray<NetworkDeviceUI>,
  zoom: number,
): Map<string, CableRoute> {
  const standing = useRef<{ key: string; routes: Map<string, CableRoute> } | null>(null);
  const links = routedLinksOf(connections, devices);
  const points = devices.map(device => ({ x: device.x, y: device.y }));
  const key = JSON.stringify([links, points, zoom]);
  if (standing.current?.key !== key) {
    standing.current = {
      key,
      routes: computeCableRoutes(links, points, zoom, standing.current?.routes),
    };
  }
  return standing.current.routes;
}
