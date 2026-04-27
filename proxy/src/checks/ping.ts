import { execFile } from 'node:child_process';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

// Permissive hostname/IP allow-list — rejects shell metacharacters. Validation
// is also enforced server-side; this is defence-in-depth in case a server is
// compromised or the validator is bypassed.
const SAFE_HOSTNAME_RE = /^[A-Za-z0-9._:\-\[\]]+$/;

export async function pingCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const hostname = cfg.hostname;
  if (!hostname) return { status: 'down', message: 'No hostname provided' };
  if (!SAFE_HOSTNAME_RE.test(hostname) || hostname.length > 255) {
    return { status: 'down', message: 'Invalid hostname (rejected by safety filter)' };
  }

  const timeoutSec = Math.max(1, Math.round((cfg.timeoutMs || 10000) / 1000));
  const isWin = process.platform === 'win32';
  const args = isWin
    ? ['-n', '1', '-w', String(timeoutSec * 1000), hostname]
    : ['-c', '1', '-W', String(timeoutSec), hostname];

  const start = performance.now();
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: (timeoutSec + 2) * 1000 }, (err, stdout) => {
      const responseTime = Math.round(performance.now() - start);
      if (err) {
        resolve({ status: 'down', responseTime, message: 'Host unreachable' });
        return;
      }
      const ping = extractPingTime(stdout);
      resolve({
        status: 'up',
        responseTime,
        ping,
        message: `Alive (${ping.toFixed(1)}ms)`,
      });
    });
  });
}

function extractPingTime(output: string): number {
  const match = output.match(/(?:time[=<]|=)\s*([\d.]+)\s*ms/);
  return match ? parseFloat(match[1]) : 0;
}
