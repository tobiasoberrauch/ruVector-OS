import { exec } from 'child_process';

export interface BatteryStatus {
  onAC: boolean;
  batteryPercent: number;
}

/**
 * Get macOS battery status via pmset.
 * Fails safe: returns { onAC: true, batteryPercent: 100 } if detection fails,
 * so background tasks always run when we can't determine power state.
 */
export function getBatteryStatus(): Promise<BatteryStatus> {
  return new Promise((resolve) => {
    exec('pmset -g batt', { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve({ onAC: true, batteryPercent: 100 });
        return;
      }

      const onAC = stdout.includes('AC Power');

      // Parse percentage: "XX%" pattern
      const match = stdout.match(/(\d+)%/);
      const batteryPercent = match ? parseInt(match[1], 10) : 100;

      resolve({ onAC, batteryPercent });
    });
  });
}

/**
 * Check if we should defer heavy background work.
 * Returns true if on battery with < 50% charge.
 */
export async function shouldDeferHeavyWork(): Promise<boolean> {
  const status = await getBatteryStatus();
  return !status.onAC && status.batteryPercent < 50;
}
