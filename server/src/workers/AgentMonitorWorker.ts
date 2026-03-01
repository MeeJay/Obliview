import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { agentPushData } from '../services/agent.service';
import { db } from '../db';
import { SOCKET_EVENTS } from '@obliview/shared';

/**
 * Agent Monitor Worker (passive).
 *
 * Thresholds are evaluated in real-time at push time (in agent.service.ts).
 * This worker's only job is to detect "device offline" (no push received
 * within 2 × check_interval_seconds) and return the current status.
 */
export class AgentMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const agentDeviceId = this.config.agentDeviceId as number | null;

    if (!agentDeviceId) {
      return { status: 'down', message: 'Agent monitor not configured (no device ID)' };
    }

    // Collect the result into a local variable so we can emit AGENT_STATUS_CHANGED
    // from every code path (offline watchdog, normal push, device state changes).
    let result: CheckResult;

    // Fetch device for status + check interval + heartbeat_monitoring
    const device = await db('agent_devices')
      .where({ id: agentDeviceId })
      .select('check_interval_seconds', 'status', 'heartbeat_monitoring')
      .first() as { check_interval_seconds: number; status: string; heartbeat_monitoring: boolean } | undefined;

    if (!device) {
      result = { status: 'down', message: 'Agent device not found' };
    } else if (device.status === 'refused') {
      result = { status: 'down', message: 'Agent device is refused' };
    } else if (device.status === 'suspended') {
      result = { status: 'paused', message: 'Agent device is suspended' };
    } else if (device.status === 'pending') {
      result = { status: 'pending', message: 'Waiting for device approval' };
    } else {
      // Check for a recent push
      const snapshot = agentPushData.get(agentDeviceId);
      const maxStaleMs = device.check_interval_seconds * 2 * 1000;

      if (!snapshot) {
        // No push received yet
        result = device.heartbeat_monitoring
          ? { status: 'down', message: 'Waiting for first agent push...' }
          : { status: 'inactive', message: 'No data received (heartbeat monitoring disabled)' };
      } else {
        const ageMs = Date.now() - snapshot.receivedAt.getTime();
        if (ageMs > maxStaleMs) {
          const ageSec = Math.round(ageMs / 1000);
          const ageMins = Math.floor(ageSec / 60);
          const timeLabel = ageMins > 0 ? `${ageMins}m ${ageSec % 60}s` : `${ageSec}s`;
          result = device.heartbeat_monitoring
            ? { status: 'down', message: `Device offline (last seen ${timeLabel} ago)` }
            : { status: 'inactive', message: `No data received for ${timeLabel} (heartbeat monitoring disabled)` };
        } else {
          // Agent is online — return the status computed at push time
          const message = snapshot.violations.length > 0
            ? snapshot.violations.join('; ')
            : 'All metrics OK';
          result = { status: snapshot.overallStatus, message };
        }
      }
    }

    // Emit dedicated agent status event so the sidebar badge updates immediately,
    // regardless of whether the BaseMonitorWorker will emit MONITOR_STATUS_CHANGE
    // (which only fires on transitions after retries are exhausted).
    this.io.to('role:admin').emit(SOCKET_EVENTS.AGENT_STATUS_CHANGED, {
      deviceId: agentDeviceId,
      status: result.status,
    });

    return result;
  }
}
