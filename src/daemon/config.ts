import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { CONFIG_PATH, DATA_DIR, MODEL_PATH } from '../shared/paths.js';
import { ensureDir } from '../shared/utils.js';
import { DEFAULT_CONFIG, type RuvectorConfig } from '../shared/types.js';

/** Load config from disk, creating defaults if needed */
export async function loadConfig(): Promise<RuvectorConfig> {
  await ensureDir(DATA_DIR);

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, 'utf-8');
      const stored = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        dataDir: DATA_DIR,
        modelPath: MODEL_PATH,
        ...stored,
      };
    } catch {
      // Corrupt config, return defaults
    }
  }

  const config: RuvectorConfig = {
    ...DEFAULT_CONFIG,
    dataDir: DATA_DIR,
    modelPath: MODEL_PATH,
  };

  await saveConfig(config);
  return config;
}

/** Save config to disk */
export async function saveConfig(config: RuvectorConfig): Promise<void> {
  await ensureDir(DATA_DIR);
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Update specific config fields */
export async function updateConfig(
  updates: Partial<RuvectorConfig>
): Promise<RuvectorConfig> {
  const config = await loadConfig();
  const updated = { ...config, ...updates };
  await saveConfig(updated);
  return updated;
}

/** Add a directory to watch list */
export async function addWatchDir(dir: string): Promise<RuvectorConfig> {
  const config = await loadConfig();
  if (!config.watchDirs.includes(dir)) {
    config.watchDirs.push(dir);
    await saveConfig(config);
  }
  return config;
}

/** Remove a directory from watch list */
export async function removeWatchDir(dir: string): Promise<RuvectorConfig> {
  const config = await loadConfig();
  config.watchDirs = config.watchDirs.filter(d => d !== dir);
  await saveConfig(config);
  return config;
}
