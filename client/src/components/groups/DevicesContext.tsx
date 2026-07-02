import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { AgentDevice, MonitorStatus } from '@obliview/shared';

/**
 * Provides the list of agent devices to the group tree so each GroupNode can
 * render its devices as leaf items alongside monitors.
 *
 * Sidebar is the canonical owner of the devices list (it already polls + listens
 * to socket events); other consumers of <GroupTree> (e.g. GroupPicker) simply
 * don't wrap with this provider — GroupNode then renders zero devices.
 */
export interface DevicesContextValue {
  devices: AgentDevice[];
  /** Per-device operational status (from `agent:status` socket frames). */
  statuses: Map<number, MonitorStatus | 'suspended' | undefined>;
  /** Whether devices should be rendered at all (admin gate on the sidebar). */
  enabled: boolean;
}

const DevicesContext = createContext<DevicesContextValue>({
  devices: [],
  statuses: new Map(),
  enabled: false,
});

export function DevicesProvider({
  devices,
  statuses,
  enabled,
  children,
}: DevicesContextValue & { children: ReactNode }) {
  // Memoize the context value so its identity is stable when the underlying
  // inputs haven't changed. Without this, every Sidebar re-render (which fires
  // on every socket frame) allocated a fresh object and forced every
  // useContext(DevicesContext) consumer to re-render. Requires each caller
  // (Sidebar) to already memoize `devices` + `statuses` — otherwise this
  // still-fires but at least the object identity gate does its job for the
  // common case where nothing meaningful moved.
  const value = useMemo<DevicesContextValue>(
    () => ({ devices, statuses, enabled }),
    [devices, statuses, enabled],
  );
  return <DevicesContext.Provider value={value}>{children}</DevicesContext.Provider>;
}

/**
 * Filter devices to a single group. Groups its return in a useMemo so the
 * `list` array's identity is stable for consumers whose deps depend on it.
 */
export function useGroupDevices(groupId: number | null): {
  list: AgentDevice[];
  enabled: boolean;
  statuses: Map<number, MonitorStatus | 'suspended' | undefined>;
} {
  const ctx = useContext(DevicesContext);
  const list = useMemo(
    () => (ctx.enabled ? ctx.devices.filter((d) => d.groupId === groupId) : []),
    [ctx.enabled, ctx.devices, groupId],
  );
  return { list, enabled: ctx.enabled, statuses: ctx.statuses };
}
