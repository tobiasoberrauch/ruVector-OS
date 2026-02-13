#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { readFile, rm } from 'fs/promises';
import { RuvectorDaemon } from '../daemon/daemon.js';
import { DashboardServer } from '../dashboard/server.js';
import { RuvectorMcpServer } from '../mcp/server.js';
import { loadConfig, addWatchDir, removeWatchDir } from '../daemon/config.js';
import {
  installLaunchAgent,
  loadLaunchAgent,
  unloadLaunchAgent,
  isLaunchAgentLoaded,
  removeLaunchAgent,
} from '../daemon/launchagent.js';
import { DATA_DIR, PID_FILE, VECTOR_DIR, GRAPH_DIR, LAUNCH_AGENT_PLIST, BIN_DIR, OCR_BINARY_PATH } from '../shared/paths.js';
import { ensureDir, formatBytes, formatDuration, isProcessRunning, readPidFile } from '../shared/utils.js';
import { OnnxEmbedder } from '../embeddings/onnx-embedder.js';

const program = new Command();

program
  .name('ruvector-memory')
  .description('RuVector OS — System-level intelligence layer for macOS')
  .version('0.1.0');

// ── init ─────────────────────────────────────────────
program
  .command('init')
  .description('Initialize RuVector OS (create data directory, download model)')
  .option('--redownload', 'Force re-download of ONNX model and tokenizer', false)
  .action(async (opts) => {
    console.log('Initializing RuVector OS...');

    await ensureDir(DATA_DIR);
    console.log(`  Data directory: ${DATA_DIR}`);

    const config = await loadConfig();
    console.log('  Config created');

    const embedder = new OnnxEmbedder();
    if (opts.redownload) {
      console.log('  Force re-downloading model...');
      await embedder.redownloadModel((msg) => console.log(`  ${msg}`));
    } else {
      await embedder.downloadModel((msg) => console.log(`  ${msg}`));
    }

    // Compile OCR helper if swiftc is available (macOS only)
    try {
      const { execFile } = await import('child_process');
      const { promisify } = await import('util');
      const { existsSync } = await import('fs');
      const { dirname, join: pathJoin } = await import('path');
      const { fileURLToPath } = await import('url');
      const execFileAsync = promisify(execFile);

      // Find the Swift source file
      const __filename = fileURLToPath(import.meta.url);
      const projectRoot = dirname(dirname(dirname(__filename)));
      const swiftSource = pathJoin(projectRoot, 'scripts', 'ocr-helper.swift');

      if (existsSync(swiftSource)) {
        await ensureDir(BIN_DIR);
        console.log('  Compiling OCR helper...');
        await execFileAsync('swiftc', [
          swiftSource,
          '-o', OCR_BINARY_PATH,
          '-O',
          '-framework', 'Vision',
          '-framework', 'CoreGraphics',
          '-framework', 'ImageIO',
        ], { timeout: 60000 });
        console.log('  OCR helper compiled');
      }
    } catch {
      console.log('  OCR helper: skipped (swiftc not available or compilation failed)');
    }

    console.log('');
    console.log('Ready. Run \'ruvector-memory start --watch <dir>\' to begin indexing.');
  });

// ── start ────────────────────────────────────────────
program
  .command('start')
  .description('Start the RuVector OS daemon')
  .option('--watch <dirs...>', 'Directories to watch')
  .option('--port <port>', 'Dashboard port', '3333')
  .option('--foreground', 'Run in foreground (don\'t use LaunchAgent)', false)
  .action(async (opts) => {
    const config = await loadConfig();

    // Add any new watch directories
    if (opts.watch) {
      for (const dir of opts.watch) {
        const absDir = resolve(dir);
        if (!existsSync(absDir)) {
          console.error(`Directory does not exist: ${absDir}`);
          process.exit(1);
        }
        await addWatchDir(absDir);
      }
    }

    // Reload config after adding dirs
    const updatedConfig = await loadConfig();

    if (updatedConfig.watchDirs.length === 0) {
      console.error('No directories to watch. Use --watch <dir> to specify directories.');
      process.exit(1);
    }

    console.log('Starting RuVector OS daemon...');
    console.log(`  Watching: ${updatedConfig.watchDirs.join(', ')}`);
    console.log(`  Dashboard: http://localhost:${opts.port}`);
    console.log('');

    // Create and start daemon
    const daemon = new RuvectorDaemon();
    await daemon.init();

    // Start dashboard
    const dashboard = new DashboardServer(daemon, parseInt(opts.port));
    await dashboard.start();

    // Wire up logging
    daemon.on('log', (msg: string) => console.log(`  ${msg}`));
    daemon.on('error', (err: Error) => console.error(`  Error: ${err.message}`));
    daemon.on('indexed', async (file: any) => {
      const status = await daemon.getStatus();
      process.stdout.write(`\r  Indexed: ${status.indexedFiles} files`);
    });

    // Start the daemon
    await daemon.start();

    console.log('');
    console.log('Daemon running. Press Ctrl+C to stop.');

    // Keep alive
    await new Promise(() => {});
  });

// ── stop ─────────────────────────────────────────────
program
  .command('stop')
  .description('Stop the RuVector OS daemon')
  .action(async () => {
    if (isLaunchAgentLoaded()) {
      unloadLaunchAgent();
      console.log('Daemon stopped (LaunchAgent unloaded)');
    } else if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(await readFile(PID_FILE, 'utf-8'));
        process.kill(pid, 'SIGTERM');
        console.log(`Daemon stopped (PID ${pid})`);
      } catch {
        console.log('Daemon not running');
      }
    } else {
      console.log('Daemon not running');
    }
  });

// ── status ───────────────────────────────────────────
program
  .command('status')
  .description('Show daemon and index status')
  .action(async () => {
    const config = await loadConfig();
    const isLoaded = isLaunchAgentLoaded();
    let running = false;

    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(await readFile(PID_FILE, 'utf-8'));
        process.kill(pid, 0); // Check if process exists
        running = true;
      } catch {
        // Process not running
      }
    }

    console.log('RuVector OS Status');
    console.log('──────────────────');
    console.log(`  Daemon:       ${running ? '● Running' : '○ Stopped'}`);
    console.log(`  LaunchAgent:  ${isLoaded ? 'Loaded' : 'Not loaded'}`);
    console.log(`  Data dir:     ${DATA_DIR}`);
    console.log(`  Watch dirs:   ${config.watchDirs.length > 0 ? config.watchDirs.join(', ') : '(none)'}`);
    console.log(`  Dashboard:    http://localhost:${config.dashboardPort}`);
  });

// ── search ───────────────────────────────────────────
program
  .command('search <query>')
  .description('Search indexed files using natural language')
  .option('-l, --limit <n>', 'Max results', '10')
  .option('-t, --threshold <n>', 'Minimum similarity', '0.3')
  .option('-d, --directory <dir>', 'Filter by directory')
  .action(async (query, opts) => {
    const config = await loadConfig();

    // Try the running daemon's HTTP API first
    try {
      const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          limit: parseInt(opts.limit),
          threshold: parseFloat(opts.threshold),
        }),
      });
      if (res.ok) {
        const data = await res.json() as { results: any[] };
        printSearchResults(data.results);
        process.exit(0);
      }
    } catch {
      // Daemon not running, fall back to direct DB access
    }

    // Direct access (daemon not running)
    try {
      const daemon = new RuvectorDaemon();
      await daemon.init();

      const results = await daemon.search({
        query,
        limit: parseInt(opts.limit),
        threshold: parseFloat(opts.threshold),
        directory: opts.directory ? resolve(opts.directory) : undefined,
      });

      printSearchResults(results);
    } catch (error: any) {
      if (error.message?.includes('lock') || error.message?.includes('already open')) {
        console.error('Database is locked by the running daemon. Please wait and try again.');
      } else {
        console.error('Search failed:', error.message);
      }
    }

    process.exit(0);
  });

function printSearchResults(results: any[]): void {
  if (!results || results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`Found ${results.length} results:\n`);
  for (const [i, r] of results.entries()) {
    const score = ((r.score ?? 0) * 100).toFixed(1);
    const path = r.file?.path ?? r.path ?? '';
    const snippet = r.snippet ?? r.file?.contentPreview ?? '';
    const related = r.relatedFiles ?? [];

    console.log(`  ${i + 1}. [${score}%] ${path}`);
    if (snippet) {
      console.log(`     ${snippet.slice(0, 120).replace(/\n/g, ' ')}...`);
    }
    if (related.length > 0) {
      console.log(`     Related: ${related.map((f: any) => f.name).join(', ')}`);
    }
    console.log('');
  }
}

// ── watch ────────────────────────────────────────────
const watchCmd = program
  .command('watch')
  .description('Manage watched directories');

watchCmd
  .command('add <dir>')
  .description('Add a directory to watch')
  .action(async (dir) => {
    const absDir = resolve(dir);
    if (!existsSync(absDir)) {
      console.error(`Directory does not exist: ${absDir}`);
      process.exit(1);
    }
    await addWatchDir(absDir);
    console.log(`Added: ${absDir}`);
  });

watchCmd
  .command('remove <dir>')
  .description('Remove a directory from watch list')
  .action(async (dir) => {
    const absDir = resolve(dir);
    await removeWatchDir(absDir);
    console.log(`Removed: ${absDir}`);
  });

watchCmd
  .command('list')
  .description('List watched directories')
  .action(async () => {
    const config = await loadConfig();
    if (config.watchDirs.length === 0) {
      console.log('No directories being watched.');
      return;
    }
    console.log('Watched directories:');
    for (const dir of config.watchDirs) {
      console.log(`  ${dir}`);
    }
  });

// ── learning ────────────────────────────────────────
const learningCmd = program
  .command('learning')
  .description('Learning system management (Tier 2)');

learningCmd
  .command('status')
  .description('Show learning metrics and status')
  .action(async () => {
    const config = await loadConfig();

    // Try the running daemon's HTTP API first
    try {
      const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/learning`);
      if (res.ok) {
        const m = await res.json() as any;
        console.log('Learning Status');
        console.log('───────────────');
        console.log(`  Total searches:     ${m.totalSearches}`);
        console.log(`  Total clicks:       ${m.totalClicks}`);
        console.log(`  Click-through rate: ${(m.clickThroughRate * 100).toFixed(1)}%`);
        console.log(`  GNN re-ranking:     ${m.gnnActive ? 'Active' : 'Inactive'}`);
        console.log(`  Last sweep:         ${m.lastSweepTime ? new Date(m.lastSweepTime).toISOString() : 'Never'}`);
        console.log(`  Sweep file count:   ${m.sweepFileCount}`);
        if (m.topFilesByImportance?.length > 0) {
          console.log('');
          console.log('  Top files by importance:');
          for (const [i, f] of m.topFilesByImportance.entries()) {
            console.log(`    ${i + 1}. [${f.score.toFixed(3)}] ${f.path}`);
          }
        }
        process.exit(0);
      }
    } catch {
      // Daemon not running
    }

    console.error('Daemon not running. Start the daemon first: ruvector-memory start --watch <dir>');
    process.exit(1);
  });

learningCmd
  .command('sweep')
  .description('Trigger a similarity discovery sweep')
  .action(async () => {
    const config = await loadConfig();

    // Must use running daemon (sweep needs vector store access)
    try {
      const daemon = new RuvectorDaemon();
      await daemon.init();

      console.log('Running similarity sweep...');
      const result = await daemon.triggerSweep();
      console.log(`  Files processed: ${result.filesProcessed}`);
      console.log(`  Edges created:   ${result.edgesCreated}`);
      console.log('Sweep complete.');
    } catch (error: any) {
      if (error.message?.includes('lock') || error.message?.includes('already open')) {
        console.error('Database is locked by the running daemon.');
        console.error('Use the HTTP API instead: curl -X POST http://127.0.0.1:3333/api/sweep');
      } else {
        console.error('Sweep failed:', error.message);
      }
    }

    process.exit(0);
  });

learningCmd
  .command('reset')
  .description('Clear all learning data (importance scores, clicks, sessions)')
  .action(async () => {
    try {
      const daemon = new RuvectorDaemon();
      await daemon.init();
      daemon.resetLearning();
      console.log('Learning data cleared.');
    } catch (error: any) {
      if (error.message?.includes('lock') || error.message?.includes('already open')) {
        console.error('Database is locked by the running daemon. Stop the daemon first.');
      } else {
        console.error('Reset failed:', error.message);
      }
    }

    process.exit(0);
  });

// ── tags ─────────────────────────────────────────────
const tagsCmd = program
  .command('tags')
  .description('Topic tag management (Tier 3)');

tagsCmd
  .command('list')
  .description('List all topic tags')
  .action(async () => {
    const config = await loadConfig();
    try {
      const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/tags`);
      if (res.ok) {
        const data = await res.json() as any;
        if (!data.tags || data.tags.length === 0) {
          console.log('No tags yet. Run: ruvector-memory tags autotag');
          process.exit(0);
        }
        console.log('Topic Tags');
        console.log('──────────');
        for (const t of data.tags) {
          console.log(`  ${t.label} (${t.fileCount} files)`);
        }
        process.exit(0);
      }
    } catch {
      // fallback
    }

    try {
      const daemon = new RuvectorDaemon();
      await daemon.init();
      const tags = daemon.getTags();
      if (tags.length === 0) {
        console.log('No tags yet. Run: ruvector-memory tags autotag');
      } else {
        console.log('Topic Tags');
        console.log('──────────');
        for (const t of tags) {
          console.log(`  ${t.label} (${t.fileCount} files)`);
        }
      }
    } catch (error: any) {
      console.error('Failed:', error.message);
    }
    process.exit(0);
  });

tagsCmd
  .command('autotag')
  .description('Run auto-tagging to cluster files into topics')
  .action(async () => {
    try {
      const daemon = new RuvectorDaemon();
      await daemon.init();
      console.log('Running auto-tagging...');
      const result = await daemon.triggerAutoTag();
      console.log(`  Tags created:  ${result.tagsCreated}`);
      console.log(`  Files tagged:  ${result.filesTagged}`);
      console.log('Auto-tagging complete.');
    } catch (error: any) {
      if (error.message?.includes('lock') || error.message?.includes('already open')) {
        console.error('Database is locked by the running daemon.');
      } else {
        console.error('Auto-tagging failed:', error.message);
      }
    }
    process.exit(0);
  });

// ── analytics ────────────────────────────────────────
program
  .command('analytics')
  .description('Show search analytics (Tier 3)')
  .action(async () => {
    const config = await loadConfig();
    try {
      const res = await fetch(`http://127.0.0.1:${config.dashboardPort}/api/analytics`);
      if (res.ok) {
        const a = await res.json() as any;
        console.log('Search Analytics');
        console.log('────────────────');
        console.log(`  Total searches: ${a.clickStats.totalSearches}`);
        console.log(`  Total clicks:   ${a.clickStats.totalClicks}`);
        console.log(`  CTR:            ${(a.clickStats.ctr * 100).toFixed(1)}%`);
        if (a.topQueries?.length > 0) {
          console.log('');
          console.log('  Top queries:');
          for (const [i, q] of a.topQueries.entries()) {
            console.log(`    ${i + 1}. "${q.query}" (${q.count}x)`);
          }
        }
        if (a.volumeByDay?.length > 0) {
          console.log('');
          console.log('  Daily volume:');
          for (const d of a.volumeByDay) {
            const bar = '#'.repeat(Math.min(d.count, 40));
            console.log(`    ${d.date.slice(5)}: ${bar} ${d.count}`);
          }
        }
        process.exit(0);
      }
    } catch {
      // daemon not running
    }
    console.error('Daemon not running. Start the daemon first.');
    process.exit(1);
  });

// ── cleanup ──────────────────────────────────────────
program
  .command('cleanup')
  .description('Clean stale lock files left by a crashed daemon')
  .action(async () => {
    const pid = readPidFile();
    if (pid !== null && isProcessRunning(pid)) {
      console.log(`Daemon is still running (PID ${pid}). Stop it first.`);
      process.exit(1);
    }

    let cleaned = 0;
    const lockPatterns = ['.lock', '-shm', '-wal', '-journal'];
    const dirs = [VECTOR_DIR, GRAPH_DIR];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      const { readdirSync, unlinkSync } = await import('fs');
      for (const file of readdirSync(dir)) {
        if (lockPatterns.some(p => file.endsWith(p))) {
          try {
            unlinkSync(resolve(dir, file));
            console.log(`  Removed: ${file}`);
            cleaned++;
          } catch {
            // skip
          }
        }
      }
    }

    // Clean stale PID file
    if (pid !== null && !isProcessRunning(pid)) {
      try {
        await rm(PID_FILE);
        console.log(`  Removed stale PID file`);
        cleaned++;
      } catch {
        // skip
      }
    }

    if (cleaned === 0) {
      console.log('No stale lock files found.');
    } else {
      console.log(`Cleaned ${cleaned} stale file(s).`);
    }
  });

// ── mcp-server ───────────────────────────────────────
program
  .command('mcp-server')
  .description('Start the MCP server (stdio transport, for Claude integration)')
  .action(async () => {
    const daemon = new RuvectorDaemon();
    await daemon.init();

    const mcp = new RuvectorMcpServer(daemon);
    await mcp.startStdio();
  });

// ── daemon (internal, used by LaunchAgent) ───────────
program
  .command('daemon', { hidden: true })
  .description('Run as background daemon (used by LaunchAgent)')
  .action(async () => {
    const daemon = new RuvectorDaemon();
    await daemon.init();

    const config = daemon.getConfig();
    const dashboard = new DashboardServer(daemon, config.dashboardPort);
    await dashboard.start();

    daemon.on('log', (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`));
    daemon.on('error', (err: Error) => console.error(`[${new Date().toISOString()}] ERROR: ${err.message}`));

    await daemon.start();
  });

// ── uninstall ────────────────────────────────────────
program
  .command('uninstall')
  .description('Uninstall RuVector OS completely')
  .option('--delete-data', 'Delete all indexed data', false)
  .action(async (opts) => {
    // Stop daemon
    if (isLaunchAgentLoaded()) {
      unloadLaunchAgent();
      console.log('Daemon stopped');
    }

    // Remove LaunchAgent
    await removeLaunchAgent();
    console.log('LaunchAgent removed');

    if (opts.deleteData) {
      await rm(DATA_DIR, { recursive: true, force: true });
      console.log(`Data deleted: ${DATA_DIR}`);
    }

    console.log('RuVector OS uninstalled.');
  });

program.parse();
