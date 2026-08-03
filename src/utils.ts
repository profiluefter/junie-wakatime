import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as child_process from 'child_process';
import { StdioOptions } from 'child_process';
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
    return stdout.toString().trim();
  } catch {
    return '';
  }
}

export function formatArguments(binary: string, args: string[]): string {
  let clone = args.slice(0);
  clone.unshift(wrapArg(binary));
  let newCmds: string[] = [];
  let lastCmd = '';
  for (let i = 0; i < clone.length; i++) {
    if (lastCmd == '--key') newCmds.push(wrapArg(obfuscateKey(clone[i])));
    else newCmds.push(wrapArg(clone[i]));
    lastCmd = clone[i];
  }
  return newCmds.join(' ');
}

export function isWindows(): boolean {
  return os.platform() === 'win32';
}

export function getHomeDirectory(): string {
  let home = process.env.WAKATIME_HOME;
  if (home && home.trim() && fs.existsSync(home.trim())) return home.trim();
  return process.env[isWindows() ? 'USERPROFILE' : 'HOME'] || process.cwd();
}

export function buildOptions(stdin?: boolean): Object {
  const options: child_process.ExecFileOptions = {
    windowsHide: true,
  };
  if (stdin) {
    (options as any).stdio = ['pipe', 'pipe', 'pipe'] as StdioOptions;
  }
  if (!isWindows() && !process.env.WAKATIME_HOME && !process.env.HOME) {
    options['env'] = { ...process.env, WAKATIME_HOME: getHomeDirectory() };
  }
  return options;
}

function timestamp() {
  return Date.now() / 1000;
}

function wrapArg(arg: string): string {
  if (arg.indexOf(' ') > -1) return '"' + arg.replace(/"/g, '\\"') + '"';
  return arg;
}

function obfuscateKey(key: string): string {
  let newKey = '';
  if (key) {
    newKey = key;
    if (key.length > 4) newKey = 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXX' + key.substring(key.length - 4);
  }
  return newKey;
}
