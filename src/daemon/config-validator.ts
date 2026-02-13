import { existsSync } from 'fs';
import type { RuvectorConfig } from '../shared/types.js';

/** Fields that require a daemon restart to take effect */
export const RESTART_REQUIRED_FIELDS = new Set([
  'dashboardPort',
  'mcpPort',
  'dimensions',
  'modelPath',
]);

/** Fields that can be hot-reloaded at runtime */
export const HOT_RELOAD_FIELDS = new Set([
  'watchDirs',
  'indexExtensions',
  'ignoreDirs',
  'maxFileSize',
  'clipboardEnabled',
  'modelIdleTimeout',
]);

export interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  requiresRestart: string[];
}

/** Validate a partial config update against the current config */
export function validateConfigUpdate(
  update: Partial<RuvectorConfig>,
  current: RuvectorConfig,
): ConfigValidationResult {
  const errors: string[] = [];
  const requiresRestart: string[] = [];

  // Check which fields require restart
  for (const key of Object.keys(update)) {
    if (RESTART_REQUIRED_FIELDS.has(key)) {
      requiresRestart.push(key);
    }
  }

  // Validate dashboardPort
  if (update.dashboardPort !== undefined) {
    if (!Number.isInteger(update.dashboardPort) || update.dashboardPort < 1 || update.dashboardPort > 65535) {
      errors.push('dashboardPort must be an integer between 1 and 65535');
    }
  }

  // Validate mcpPort
  if (update.mcpPort !== undefined) {
    if (!Number.isInteger(update.mcpPort) || update.mcpPort < 1 || update.mcpPort > 65535) {
      errors.push('mcpPort must be an integer between 1 and 65535');
    }
  }

  // Validate indexExtensions
  if (update.indexExtensions !== undefined) {
    if (!Array.isArray(update.indexExtensions)) {
      errors.push('indexExtensions must be an array');
    } else {
      for (const ext of update.indexExtensions) {
        if (typeof ext !== 'string' || !ext.startsWith('.') || ext.length < 2) {
          errors.push(`Invalid extension format: "${ext}" — must start with "." (e.g., ".ts")`);
        }
      }
    }
  }

  // Validate ignoreDirs
  if (update.ignoreDirs !== undefined) {
    if (!Array.isArray(update.ignoreDirs)) {
      errors.push('ignoreDirs must be an array');
    } else {
      for (const dir of update.ignoreDirs) {
        if (typeof dir !== 'string' || dir.length === 0) {
          errors.push('ignoreDirs entries must be non-empty strings');
        }
      }
    }
  }

  // Validate maxFileSize
  if (update.maxFileSize !== undefined) {
    if (typeof update.maxFileSize !== 'number' || update.maxFileSize < 1024 || update.maxFileSize > 100 * 1024 * 1024) {
      errors.push('maxFileSize must be between 1KB (1024) and 100MB (104857600)');
    }
  }

  // Validate watchDirs
  if (update.watchDirs !== undefined) {
    if (!Array.isArray(update.watchDirs)) {
      errors.push('watchDirs must be an array');
    } else {
      for (const dir of update.watchDirs) {
        if (typeof dir !== 'string') {
          errors.push('watchDirs entries must be strings');
        } else if (!existsSync(dir)) {
          errors.push(`Watch directory does not exist: ${dir}`);
        }
      }
    }
  }

  // Validate modelIdleTimeout
  if (update.modelIdleTimeout !== undefined) {
    if (typeof update.modelIdleTimeout !== 'number' || update.modelIdleTimeout < 10000 || update.modelIdleTimeout > 3600000) {
      errors.push('modelIdleTimeout must be between 10000 (10s) and 3600000 (1h)');
    }
  }

  // Validate clipboardEnabled
  if (update.clipboardEnabled !== undefined) {
    if (typeof update.clipboardEnabled !== 'boolean') {
      errors.push('clipboardEnabled must be a boolean');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    requiresRestart,
  };
}
