import { writeFile, unlink, access } from 'fs/promises';
import { execFileSync } from 'child_process';
import { LAUNCH_AGENT_DIR, LAUNCH_AGENT_PLIST, LOG_PATH, DATA_DIR } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';

const LABEL = 'com.ruvector.memory';

/** Generate the LaunchAgent plist XML */
function generatePlist(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${binaryPath}</string>
    <string>daemon</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>

  <key>LowPriorityBackgroundIO</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>

  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>

  <key>WorkingDirectory</key>
  <string>${DATA_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
  </dict>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>Nice</key>
  <integer>10</integer>
</dict>
</plist>`;
}

/** Install the LaunchAgent (but don't start it) */
export async function installLaunchAgent(binaryPath: string): Promise<void> {
  await ensureDir(LAUNCH_AGENT_DIR);
  const plist = generatePlist(binaryPath);
  await writeFile(LAUNCH_AGENT_PLIST, plist, 'utf-8');
}

/** Load (start) the LaunchAgent */
export function loadLaunchAgent(): void {
  try {
    execFileSync('launchctl', ['load', LAUNCH_AGENT_PLIST], { stdio: 'pipe' });
  } catch {
    // May already be loaded
  }
}

/** Unload (stop) the LaunchAgent */
export function unloadLaunchAgent(): void {
  try {
    execFileSync('launchctl', ['unload', LAUNCH_AGENT_PLIST], { stdio: 'pipe' });
  } catch {
    // May not be loaded
  }
}

/** Check if LaunchAgent is loaded */
export function isLaunchAgentLoaded(): boolean {
  try {
    const result = execFileSync('launchctl', ['list', LABEL], {
      stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr like 2>/dev/null
      encoding: 'utf-8',
    });
    return result.includes(LABEL);
  } catch {
    return false;
  }
}

/** Remove the LaunchAgent plist file */
export async function removeLaunchAgent(): Promise<void> {
  unloadLaunchAgent();
  try {
    await unlink(LAUNCH_AGENT_PLIST);
  } catch {
    // File doesn't exist
  }
}

/** Check if the plist file exists */
export async function isLaunchAgentInstalled(): Promise<boolean> {
  try {
    await access(LAUNCH_AGENT_PLIST);
    return true;
  } catch {
    return false;
  }
}
