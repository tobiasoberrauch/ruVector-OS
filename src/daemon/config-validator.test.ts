import { describe, it, expect } from 'vitest';
import { validateConfigUpdate, RESTART_REQUIRED_FIELDS, HOT_RELOAD_FIELDS } from './config-validator.js';
import { DEFAULT_CONFIG } from '../shared/types.js';

describe('validateConfigUpdate', () => {
  const current = { ...DEFAULT_CONFIG, watchDirs: ['/tmp'] };

  it('accepts a valid empty update', () => {
    const result = validateConfigUpdate({}, current);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('accepts valid maxFileSize', () => {
    const result = validateConfigUpdate({ maxFileSize: 2 * 1024 * 1024 }, current);
    expect(result.valid).toBe(true);
  });

  it('rejects maxFileSize below 1KB', () => {
    const result = validateConfigUpdate({ maxFileSize: 500 }, current);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('maxFileSize');
  });

  it('rejects maxFileSize above 100MB', () => {
    const result = validateConfigUpdate({ maxFileSize: 200 * 1024 * 1024 }, current);
    expect(result.valid).toBe(false);
  });

  it('accepts valid port numbers', () => {
    const result = validateConfigUpdate({ dashboardPort: 8080 }, current);
    expect(result.valid).toBe(true);
  });

  it('rejects port 0', () => {
    const result = validateConfigUpdate({ dashboardPort: 0 }, current);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dashboardPort');
  });

  it('rejects port above 65535', () => {
    const result = validateConfigUpdate({ dashboardPort: 70000 }, current);
    expect(result.valid).toBe(false);
  });

  it('rejects non-integer port', () => {
    const result = validateConfigUpdate({ dashboardPort: 3333.5 }, current);
    expect(result.valid).toBe(false);
  });

  it('accepts valid extensions', () => {
    const result = validateConfigUpdate({ indexExtensions: ['.ts', '.js', '.md'] }, current);
    expect(result.valid).toBe(true);
  });

  it('rejects extensions without leading dot', () => {
    const result = validateConfigUpdate({ indexExtensions: ['ts', '.js'] }, current);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('ts');
  });

  it('rejects extension that is just a dot', () => {
    const result = validateConfigUpdate({ indexExtensions: ['.'] }, current);
    expect(result.valid).toBe(false);
  });

  it('accepts valid ignoreDirs', () => {
    const result = validateConfigUpdate({ ignoreDirs: ['node_modules', '.git'] }, current);
    expect(result.valid).toBe(true);
  });

  it('rejects empty string in ignoreDirs', () => {
    const result = validateConfigUpdate({ ignoreDirs: ['', 'node_modules'] }, current);
    expect(result.valid).toBe(false);
  });

  it('accepts valid clipboardEnabled', () => {
    const result = validateConfigUpdate({ clipboardEnabled: true }, current);
    expect(result.valid).toBe(true);
  });

  it('rejects non-boolean clipboardEnabled', () => {
    const result = validateConfigUpdate({ clipboardEnabled: 'yes' as any }, current);
    expect(result.valid).toBe(false);
  });

  it('flags port changes as requiring restart', () => {
    const result = validateConfigUpdate({ dashboardPort: 4444 }, current);
    expect(result.requiresRestart).toContain('dashboardPort');
  });

  it('does not flag hot-reload fields as requiring restart', () => {
    const result = validateConfigUpdate({ maxFileSize: 2 * 1024 * 1024 }, current);
    expect(result.requiresRestart).toHaveLength(0);
  });

  it('validates modelIdleTimeout bounds', () => {
    expect(validateConfigUpdate({ modelIdleTimeout: 5000 }, current).valid).toBe(false);
    expect(validateConfigUpdate({ modelIdleTimeout: 60000 }, current).valid).toBe(true);
    expect(validateConfigUpdate({ modelIdleTimeout: 4000000 }, current).valid).toBe(false);
  });

  it('rejects non-existent watch directory', () => {
    const result = validateConfigUpdate({ watchDirs: ['/definitely/nonexistent/path'] }, current);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('does not exist');
  });

  it('accepts /tmp as a valid watch directory', () => {
    const result = validateConfigUpdate({ watchDirs: ['/tmp'] }, current);
    expect(result.valid).toBe(true);
  });
});

describe('Field classification', () => {
  it('restart fields include expected keys', () => {
    expect(RESTART_REQUIRED_FIELDS.has('dashboardPort')).toBe(true);
    expect(RESTART_REQUIRED_FIELDS.has('mcpPort')).toBe(true);
    expect(RESTART_REQUIRED_FIELDS.has('dimensions')).toBe(true);
  });

  it('hot-reload fields include expected keys', () => {
    expect(HOT_RELOAD_FIELDS.has('watchDirs')).toBe(true);
    expect(HOT_RELOAD_FIELDS.has('indexExtensions')).toBe(true);
    expect(HOT_RELOAD_FIELDS.has('maxFileSize')).toBe(true);
  });
});
