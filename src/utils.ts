import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Input, State } from './types';

const execFileAsync = promisify(execFile);

export function parseInput() {
  try {
    const stdinData = fs.readFileSync(0, 'utf-8');
    if (stdinData.trim()) {
      const input: Input = JSON.parse(stdinData);
      return input;
    }
  } catch (err) {
    console.error(err);
  }
  return undefined;
}

function getStateFile(): string {
  const key = crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 16);
  return path.join(getHomeDirectory(), '.wakatime', 'junie-wakatime', `${key}.wakatime`);
}

function getAILastParsedFile(): string {
  return path.join(getHomeDirectory(), '.wakatime', 'junie-wakatime', 'ai-last-parsed.json');
}

// getAILastParsedAt returns the timestamp (unix epoch ms) of the newest Junie
// transcript event already turned into heartbeats, or undefined on first run.
export function getAILastParsedAt(): number | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAILastParsedFile(), 'utf-8')) as { lastParsedAt?: number };
    return typeof parsed.lastParsedAt === 'number' ? parsed.lastParsedAt : undefined;
  } catch {
    return undefined;
  }
}

// setAILastParsedAt persists the newest parsed Junie transcript timestamp
// (unix epoch ms) so the same edits are never sent twice.
export async function setAILastParsedAt(timestampMs: number): Promise<void> {
  const file = getAILastParsedFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ lastParsedAt: timestampMs }, null, 2));
}

export function shouldSendHeartbeat(inp?: Input): boolean {
  if (!inp) return false;

  try {
    const last = (JSON.parse(fs.readFileSync(getStateFile(), 'utf-8')) as State).lastHeartbeatAt ?? timestamp();
    return timestamp() - last >= 60;
  } catch {
    return true;
  }
}

export async function updateState(): Promise<void> {
  const file = getStateFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ lastHeartbeatAt: timestamp() } as State, null, 2));
}

export async function getEditorVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('junie', ['--version'], { timeout: 3000 });
    // `junie --version` can print multiple lines (e.g. a JVM/OpenJDK banner on
    // some setups). Only the first line is used, and any remaining control
    // characters are stripped, since this value ends up in the User-Agent
    // header, which cannot contain newlines or other invalid header characters.
    const firstLine = stdout.toString().split(/\r?\n/)[0] ?? '';
    return firstLine.replace(/[\x00-\x1f\x7f]/g, '').trim();
  } catch {
    return '';
  }
}

export function isWindows(): boolean {
  return os.platform() === 'win32';
}

export function getHomeDirectory(): string {
  let home = process.env.WAKATIME_HOME;
  if (home && home.trim() && fs.existsSync(home.trim())) return home.trim();
  return process.env[isWindows() ? 'USERPROFILE' : 'HOME'] || process.cwd();
}

function timestamp() {
  return Date.now() / 1000;
}
