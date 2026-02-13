import { homedir } from 'os';
import { join } from 'path';

/** Base data directory */
export const DATA_DIR = join(
  homedir(),
  'Library',
  'Application Support',
  'ruvector-os'
);

/** Database file */
export const DB_PATH = join(DATA_DIR, 'ruvector.db');

/** Vector index storage */
export const VECTOR_DIR = join(DATA_DIR, 'vectors');

/** Knowledge graph storage */
export const GRAPH_DIR = join(DATA_DIR, 'graph');

/** ONNX model directory */
export const MODEL_DIR = join(DATA_DIR, 'models');

/** ONNX model file */
export const MODEL_PATH = join(MODEL_DIR, 'all-MiniLM-L6-v2.onnx');

/** Tokenizer file */
export const TOKENIZER_PATH = join(MODEL_DIR, 'tokenizer.json');

/** Config file */
export const CONFIG_PATH = join(DATA_DIR, 'config.json');

/** PID file for daemon */
export const PID_FILE = join(DATA_DIR, 'daemon.pid');

/** IPC socket for daemon communication */
export const IPC_SOCKET = join(DATA_DIR, 'daemon.sock');

/** LaunchAgent plist path */
export const LAUNCH_AGENT_DIR = join(homedir(), 'Library', 'LaunchAgents');
export const LAUNCH_AGENT_PLIST = join(
  LAUNCH_AGENT_DIR,
  'com.ruvector.memory.plist'
);

/** Log file */
export const LOG_PATH = join(DATA_DIR, 'daemon.log');

/** Binary directory for compiled helpers */
export const BIN_DIR = join(DATA_DIR, 'bin');

/** Compiled OCR helper binary */
export const OCR_BINARY_PATH = join(BIN_DIR, 'ocr-helper');
