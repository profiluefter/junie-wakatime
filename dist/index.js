#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var path5 = __toESM(require("path"));

// src/options.ts
var fs2 = __toESM(require("fs"));
var path2 = __toESM(require("path"));

// src/utils.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var crypto = __toESM(require("crypto"));
var import_child_process = require("child_process");
var import_util = require("util");
var execFileAsync = (0, import_util.promisify)(import_child_process.execFile);
function parseInput() {
  try {
    const stdinData = fs.readFileSync(0, "utf-8");
    if (stdinData.trim()) {
      const input = JSON.parse(stdinData);
      return input;
    }
  } catch (err) {
    console.error(err);
  }
  return void 0;
}
function getStateFile() {
  const key = crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16);
  return path.join(getHomeDirectory(), ".wakatime", "junie-wakatime", `${key}.wakatime`);
}
function getAILastParsedFile() {
  return path.join(getHomeDirectory(), ".wakatime", "junie-wakatime", "ai-last-parsed.json");
}
function getAILastParsedLockFile() {
  return path.join(getHomeDirectory(), ".wakatime", "junie-wakatime", "ai-last-parsed.lock");
}
var LOCK_RETRY_MS = 50;
var LOCK_TIMEOUT_MS = 5e3;
async function withAiCursorLock(fn) {
  const lockFile = getAILastParsedLockFile();
  await fs.promises.mkdir(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (; ; ) {
    try {
      fs.closeSync(fs.openSync(lockFile, "wx"));
      break;
    } catch (err) {
      const code = err.code;
      if (code !== "EEXIST" || Date.now() >= deadline) {
        break;
      }
      await new Promise((resolve2) => setTimeout(resolve2, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockFile);
    } catch {
    }
  }
}
function getAILastParsedAt() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getAILastParsedFile(), "utf-8"));
    return typeof parsed.lastParsedAt === "number" ? parsed.lastParsedAt : void 0;
  } catch {
    return void 0;
  }
}
async function setAILastParsedAt(timestampMs) {
  const file = getAILastParsedFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ lastParsedAt: timestampMs }, null, 2));
}
function shouldSendHeartbeat(inp) {
  if (!inp) return false;
  try {
    const last = JSON.parse(fs.readFileSync(getStateFile(), "utf-8")).lastHeartbeatAt ?? timestamp();
    return timestamp() - last >= 60;
  } catch {
    return true;
  }
}
async function updateState() {
  const file = getStateFile();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify({ lastHeartbeatAt: timestamp() }, null, 2));
}
async function getEditorVersion() {
  try {
    const { stdout } = await execFileAsync("junie", ["--version"], { timeout: 3e3 });
    const firstLine = stdout.toString().split(/\r?\n/)[0] ?? "";
    return firstLine.replace(/[\x00-\x1f\x7f]/g, "").trim();
  } catch {
    return "";
  }
}
function isWindows() {
  return os.platform() === "win32";
}
function getHomeDirectory() {
  let home = process.env.WAKATIME_HOME;
  if (home && home.trim() && fs.existsSync(home.trim())) return home.trim();
  return process.env[isWindows() ? "USERPROFILE" : "HOME"] || process.cwd();
}
function timestamp() {
  return Date.now() / 1e3;
}

// src/options.ts
var Options = class {
  constructor() {
    const home = getHomeDirectory();
    const wakaFolder = path2.join(home, ".wakatime");
    try {
      if (!fs2.existsSync(wakaFolder)) {
        fs2.mkdirSync(wakaFolder, { recursive: true });
      }
      this.resourcesLocation = wakaFolder;
    } catch (e) {
      console.error(e);
      throw e;
    }
    this.configFile = path2.join(home, ".wakatime.cfg");
    this.internalConfigFile = path2.join(this.resourcesLocation, "wakatime-internal.cfg");
    this.logFile = path2.join(this.resourcesLocation, "wakatime.log");
  }
  getSetting(section, key, internal) {
    try {
      const content = fs2.readFileSync(this.getConfigFile(internal ?? false), "utf-8");
      if (content.trim()) {
        let currentSection = "";
        let lines = content.split("\n");
        for (var i = 0; i < lines.length; i++) {
          let line = lines[i];
          if (this.startsWith(line.trim(), "[") && this.endsWith(line.trim(), "]")) {
            currentSection = line.trim().substring(1, line.trim().length - 1).toLowerCase();
          } else if (currentSection === section) {
            let parts = line.split("=");
            let currentKey = parts[0].trim();
            if (currentKey === key && parts.length > 1) {
              return this.removeNulls(parts[1].trim());
            }
          }
        }
        return void 0;
      }
    } catch (_) {
      return void 0;
    }
  }
  setSetting(section, key, val, internal) {
    const configFile = this.getConfigFile(internal);
    fs2.readFile(configFile, "utf-8", (err, content) => {
      if (err) content = "";
      let contents = [];
      let currentSection = "";
      let found = false;
      let lines = content.split("\n");
      for (var i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (this.startsWith(line.trim(), "[") && this.endsWith(line.trim(), "]")) {
          if (currentSection === section && !found) {
            contents.push(this.removeNulls(key + " = " + val));
            found = true;
          }
          currentSection = line.trim().substring(1, line.trim().length - 1).toLowerCase();
          contents.push(this.removeNulls(line));
        } else if (currentSection === section) {
          let parts = line.split("=");
          let currentKey = parts[0].trim();
          if (currentKey === key) {
            if (!found) {
              contents.push(this.removeNulls(key + " = " + val));
              found = true;
            }
          } else {
            contents.push(this.removeNulls(line));
          }
        } else {
          contents.push(this.removeNulls(line));
        }
      }
      if (!found) {
        if (currentSection !== section) {
          contents.push("[" + section + "]");
        }
        contents.push(this.removeNulls(key + " = " + val));
      }
      fs2.writeFile(configFile, contents.join("\n"), (err2) => {
        if (err2) throw err2;
      });
    });
  }
  setSettings(section, settings, internal) {
    const configFile = this.getConfigFile(internal);
    fs2.readFile(configFile, "utf-8", (err, content) => {
      if (err) content = "";
      let contents = [];
      let currentSection = "";
      const found = {};
      let lines = content.split("\n");
      for (var i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (this.startsWith(line.trim(), "[") && this.endsWith(line.trim(), "]")) {
          if (currentSection === section) {
            settings.forEach((setting) => {
              if (!found[setting.key]) {
                contents.push(this.removeNulls(setting.key + " = " + setting.value));
                found[setting.key] = true;
              }
            });
          }
          currentSection = line.trim().substring(1, line.trim().length - 1).toLowerCase();
          contents.push(this.removeNulls(line));
        } else if (currentSection === section) {
          let parts = line.split("=");
          let currentKey = parts[0].trim();
          let keepLineUnchanged = true;
          settings.forEach((setting) => {
            if (currentKey === setting.key) {
              keepLineUnchanged = false;
              if (!found[setting.key]) {
                contents.push(this.removeNulls(setting.key + " = " + setting.value));
                found[setting.key] = true;
              }
            }
          });
          if (keepLineUnchanged) {
            contents.push(this.removeNulls(line));
          }
        } else {
          contents.push(this.removeNulls(line));
        }
      }
      settings.forEach((setting) => {
        if (!found[setting.key]) {
          if (currentSection !== section) {
            contents.push("[" + section + "]");
            currentSection = section;
          }
          contents.push(this.removeNulls(setting.key + " = " + setting.value));
          found[setting.key] = true;
        }
      });
      fs2.writeFile(configFile, contents.join("\n"), (err2) => {
        if (err2) throw err2;
      });
    });
  }
  getConfigFile(internal) {
    return internal ? this.internalConfigFile : this.configFile;
  }
  getLogFile() {
    return this.logFile;
  }
  startsWith(outer, inner) {
    return outer.slice(0, inner.length) === inner;
  }
  endsWith(outer, inner) {
    return inner === "" || outer.slice(-inner.length) === inner;
  }
  removeNulls(s) {
    return s.replace(/\0/g, "");
  }
};

// src/logger.ts
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_os = __toESM(require("os"));
var LogLevel = /* @__PURE__ */ ((LogLevel2) => {
  LogLevel2[LogLevel2["DEBUG"] = 0] = "DEBUG";
  LogLevel2[LogLevel2["INFO"] = 1] = "INFO";
  LogLevel2[LogLevel2["WARN"] = 2] = "WARN";
  LogLevel2[LogLevel2["ERROR"] = 3] = "ERROR";
  return LogLevel2;
})(LogLevel || {});
var LOG_FILE = import_path.default.join(import_os.default.homedir(), ".wakatime", "junie-wakatime.log");
var Logger = class {
  constructor(level) {
    this.level = 1 /* INFO */;
    if (level !== void 0) this.setLevel(level);
  }
  getLevel() {
    return this.level;
  }
  setLevel(level) {
    this.level = level;
  }
  log(level, msg) {
    if (level >= this.level) {
      msg = `[${(/* @__PURE__ */ new Date()).toISOString()}][${LogLevel[level]}] ${msg}
`;
      import_fs.default.mkdirSync(import_path.default.dirname(LOG_FILE), { recursive: true });
      import_fs.default.appendFileSync(LOG_FILE, msg);
    }
  }
  debug(msg) {
    this.log(0 /* DEBUG */, msg);
  }
  debugException(msg) {
    if (msg.message !== void 0) {
      this.log(0 /* DEBUG */, msg.message);
    } else {
      this.log(0 /* DEBUG */, msg.toString());
    }
  }
  info(msg) {
    this.log(1 /* INFO */, msg);
  }
  warn(msg) {
    this.log(2 /* WARN */, msg);
  }
  warnException(msg) {
    if (msg.message !== void 0) {
      this.log(2 /* WARN */, msg.message);
    } else {
      this.log(2 /* WARN */, msg.toString());
    }
  }
  error(msg) {
    this.log(3 /* ERROR */, msg);
  }
  errorException(msg) {
    if (msg.message !== void 0) {
      this.log(3 /* ERROR */, msg.message);
    } else {
      this.log(3 /* ERROR */, msg.toString());
    }
  }
};
var global = globalThis;
var logger = global.logger ?? new Logger();
global.logger = logger;

// src/junie.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
var APP_ENTITY = "Junie";
function getSessionsDirectory(home) {
  return path4.join(home ?? getHomeDirectory(), ".junie", "sessions");
}
function stripDiffPath(raw) {
  let value = raw.trim();
  const tab = value.indexOf("	");
  if (tab !== -1) value = value.slice(0, tab);
  if (value === "" || value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) {
    value = value.slice(2);
  }
  return value;
}
function resolveEntity(file, cwd) {
  if (path4.isAbsolute(file)) return file;
  if (!cwd) return null;
  return path4.resolve(cwd, file);
}
function parsePatch(patch, cwd) {
  const changes = [];
  let current = null;
  let pendingMinus = null;
  const finalize = () => {
    if (current) changes.push(current);
    current = null;
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      pendingMinus = stripDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      finalize();
      const plus = stripDiffPath(line.slice(4));
      const file = plus ?? pendingMinus;
      pendingMinus = null;
      if (file) {
        const entity = resolveEntity(file, cwd);
        current = entity ? { file: entity, additions: 0, deletions: 0 } : null;
      } else {
        current = null;
      }
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (!current) continue;
    if (line.startsWith("+")) {
      current.additions++;
    } else if (line.startsWith("-")) {
      current.deletions++;
    }
  }
  finalize();
  return changes;
}
function sessionIdFromTranscript(file) {
  return path4.basename(path4.dirname(file));
}
function parseTranscript(file, afterMs) {
  let content;
  try {
    content = fs4.readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  const aiSession = sessionIdFromTranscript(file);
  const heartbeats = [];
  let cwd = "";
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const agentEvent = evt.event?.agentEvent;
    if (agentEvent?.kind === "CurrentDirectoryUpdatedEvent") {
      if (agentEvent.currentDirectory && agentEvent.currentDirectory.trim()) {
        cwd = agentEvent.currentDirectory.trim();
      }
      continue;
    }
    const timestampMs = evt.timestampMs;
    if (typeof timestampMs !== "number" || timestampMs <= afterMs) continue;
    const time = timestampMs / 1e3;
    if (evt.kind === "UserPromptEvent") {
      const prompt = evt.prompt;
      if (typeof prompt === "string" && prompt.length > 0) {
        heartbeats.push({
          entity: APP_ENTITY,
          entityType: "app",
          time,
          aiSession,
          aiPromptLength: [...prompt].length
        });
      }
      continue;
    }
    if (!agentEvent) continue;
    if (agentEvent.kind === "LlmResponseMetadataEvent") {
      const usage = agentEvent.modelUsage;
      if (Array.isArray(usage) && usage.length > 0) {
        let inputTokens = 0;
        let outputTokens = 0;
        for (const u of usage) {
          if (typeof u.inputTokens === "number") inputTokens += u.inputTokens;
          if (typeof u.outputTokens === "number") outputTokens += u.outputTokens;
        }
        if (inputTokens > 0 || outputTokens > 0) {
          heartbeats.push({
            entity: APP_ENTITY,
            entityType: "app",
            time,
            aiSession,
            aiInputTokens: inputTokens,
            aiOutputTokens: outputTokens
          });
        }
      }
      continue;
    }
    if (agentEvent.kind === "AgentPatchCreatedEvent") {
      const patch = agentEvent.patch;
      if (!patch || !patch.trim()) continue;
      for (const change of parsePatch(patch, cwd)) {
        heartbeats.push({
          entity: change.file,
          entityType: "file",
          time,
          aiSession,
          aiLineChanges: change.additions - change.deletions,
          projectFolder: cwd
        });
      }
    }
  }
  return heartbeats;
}
function findTranscripts(sessionsDir, afterMs) {
  let entries;
  try {
    entries = fs4.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const cutoff = afterMs - 2e3;
  const transcripts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const transcript = path4.join(sessionsDir, entry.name, "events.jsonl");
    try {
      const stat = fs4.statSync(transcript);
      if (stat.mtimeMs >= cutoff) transcripts.push(transcript);
    } catch {
    }
  }
  return transcripts;
}
function collectHeartbeats(afterMs, home) {
  const sessionsDir = getSessionsDirectory(home);
  const transcripts = findTranscripts(sessionsDir, afterMs);
  const heartbeats = [];
  let maxTimestampMs = 0;
  for (const transcript of transcripts) {
    for (const hb of parseTranscript(transcript, afterMs)) {
      heartbeats.push(hb);
      const tsMs = Math.round(hb.time * 1e3);
      if (tsMs > maxTimestampMs) maxTimestampMs = tsMs;
    }
  }
  heartbeats.sort((a, b) => a.time - b.time);
  return { heartbeats, maxTimestampMs };
}

// src/wakatime.ts
var http = __toESM(require("http"));
var https = __toESM(require("https"));
var net = __toESM(require("net"));
var os3 = __toESM(require("os"));
var tls = __toESM(require("tls"));
var import_url = require("url");

// src/version.ts
var VERSION = "4.1.0";

// src/wakatime.ts
var DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
var REQUEST_TIMEOUT_MS = 1e4;
function buildUserAgent(editorVersion) {
  const system = `${os3.platform()}-${os3.release()}-${os3.arch()}`;
  const plugin = editorVersion ? `junie-cli/${editorVersion} junie-wakatime/${VERSION}` : `junie-wakatime/${VERSION}`;
  return `wakatime/${VERSION} (${system}) node-${process.version} ${plugin}`;
}
function getApiKey(options2) {
  const fromConfig = options2.getSetting("settings", "api_key");
  if (fromConfig && fromConfig.trim()) return fromConfig.trim();
  const fromEnv = process.env.WAKATIME_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return void 0;
}
function getApiUrl(options2) {
  const configured = options2.getSetting("settings", "api_url");
  const base = configured && configured.trim() ? configured.trim() : DEFAULT_API_URL;
  return base.replace(/\/+$/, "");
}
function createProxyTunnel(proxyUrl, targetUrl) {
  const proxyPort = proxyUrl.port ? parseInt(proxyUrl.port, 10) : proxyUrl.protocol === "https:" ? 443 : 80;
  const baseSocket = proxyUrl.protocol === "https:" ? tls.connect({ host: proxyUrl.hostname, port: proxyPort, servername: proxyUrl.hostname }) : net.connect(proxyPort, proxyUrl.hostname);
  const targetPort = targetUrl.port || (targetUrl.protocol === "https:" ? "443" : "80");
  return new Promise((resolve2, reject) => {
    const auth = proxyUrl.username || proxyUrl.password ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString("base64")}` : void 0;
    const cleanup = () => {
      baseSocket.removeListener("error", onError);
      baseSocket.removeListener("data", onData);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    let response = "";
    const onData = (chunk) => {
      response += chunk.toString("utf8");
      if (!response.includes("\r\n\r\n")) return;
      cleanup();
      const statusLine = response.split("\r\n", 1)[0];
      if (!statusLine.includes(" 200 ")) {
        baseSocket.destroy();
        reject(new Error(`Proxy CONNECT failed: ${statusLine}`));
        return;
      }
      resolve2(baseSocket);
    };
    const connectRequest = `CONNECT ${targetUrl.hostname}:${targetPort} HTTP/1.1\r
Host: ${targetUrl.hostname}:${targetPort}\r
${auth ? `Proxy-Authorization: ${auth}\r
` : ""}Connection: close\r
\r
`;
    baseSocket.once("error", onError);
    baseSocket.on("data", onData);
    if (proxyUrl.protocol === "https:") {
      baseSocket.once("secureConnect", () => baseSocket.write(connectRequest));
    } else {
      baseSocket.once("connect", () => baseSocket.write(connectRequest));
    }
  });
}
async function post(url, body, headers, proxy) {
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const requestOptions = {
    method: "POST",
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    headers
  };
  if (proxy && proxy.trim()) {
    const proxyUrl = new import_url.URL(proxy.trim());
    if (isHttps) {
      const tunnel = await createProxyTunnel(proxyUrl, url);
      const secureSocket = tls.connect({
        socket: tunnel,
        servername: url.hostname
      });
      return new Promise((resolve2, reject) => {
        secureSocket.once("error", reject);
        const req = https.request(
          {
            host: url.hostname,
            port: url.port ? parseInt(url.port, 10) : 443,
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers,
            agent: false,
            createConnection: () => secureSocket,
            timeout: REQUEST_TIMEOUT_MS
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => data += chunk);
            res.on("end", () => resolve2({ status: res.statusCode ?? 0, body: data }));
          }
        );
        req.on("error", reject);
        req.on("timeout", () => req.destroy(new Error("Request to WakaTime API timed out")));
        req.write(body);
        req.end();
      });
    } else {
      requestOptions.hostname = proxyUrl.hostname;
      requestOptions.port = proxyUrl.port || 80;
      requestOptions.path = url.toString();
      requestOptions.headers = { ...headers, Host: url.host };
    }
  }
  requestOptions.timeout = REQUEST_TIMEOUT_MS;
  return new Promise((resolve2, reject) => {
    const req = transport.request(requestOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => resolve2({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Request to WakaTime API timed out")));
    req.write(body);
    req.end();
  });
}
async function sendHeartbeats(heartbeats, options2) {
  if (heartbeats.length === 0) return true;
  const apiKey = getApiKey(options2);
  if (!apiKey) {
    logger.warn(
      "WakaTime api key not found; skipping heartbeat send. Set api_key in ~/.wakatime.cfg or the WAKATIME_API_KEY environment variable."
    );
    return false;
  }
  const url = new import_url.URL(`${getApiUrl(options2)}/users/current/heartbeats.bulk`);
  const body = JSON.stringify(heartbeats);
  const headers = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    Authorization: `Basic ${Buffer.from(apiKey).toString("base64")}`,
    "User-Agent": heartbeats[0].user_agent ?? buildUserAgent("")
  };
  const proxy = options2.getSetting("settings", "proxy");
  try {
    const { status, body: responseBody } = await post(url, body, headers, proxy ?? void 0);
    if (status === 201 || status === 202) {
      logger.debug(`Sent ${heartbeats.length} Junie AI heartbeat(s) to WakaTime (HTTP ${status}).`);
      return true;
    }
    logger.error(`WakaTime API returned HTTP ${status} when sending heartbeats: ${responseBody}`);
    return false;
  } catch (e) {
    logger.error(`Failed to send heartbeats to WakaTime: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// src/index.ts
var options = new Options();
var AI_CODING_CATEGORY = "ai coding";
function projectName(projectFolder) {
  return projectFolder ? path5.basename(projectFolder) : "";
}
function toWakaHeartbeat(h, userAgent) {
  const hb = {
    entity: h.entity,
    type: h.entityType,
    category: AI_CODING_CATEGORY,
    time: h.time,
    ai_session: h.aiSession,
    user_agent: userAgent
  };
  if (h.entityType === "file") {
    hb.is_write = true;
    if (typeof h.aiLineChanges === "number") hb.ai_line_changes = h.aiLineChanges;
    const project = projectName(h.projectFolder);
    if (project) hb.project = project;
  }
  if (typeof h.aiPromptLength === "number") hb.ai_prompt_length = h.aiPromptLength;
  if (typeof h.aiInputTokens === "number") hb.ai_input_tokens = h.aiInputTokens;
  if (typeof h.aiOutputTokens === "number") hb.ai_output_tokens = h.aiOutputTokens;
  return hb;
}
async function syncJunieActivity() {
  return withAiCursorLock(async () => {
    const lastParsedAt = getAILastParsedAt();
    if (lastParsedAt === void 0) {
      await setAILastParsedAt(Date.now());
      logger.debug("Initialized Junie AI activity cursor; skipping historical backfill");
      return true;
    }
    const { heartbeats, maxTimestampMs } = collectHeartbeats(lastParsedAt);
    if (heartbeats.length === 0) return true;
    const editorVersion = await getEditorVersion();
    const userAgent = buildUserAgent(editorVersion);
    const payload = heartbeats.map((h) => toWakaHeartbeat(h, userAgent));
    logger.debug(`Sending ${payload.length} Junie AI heartbeat(s) to WakaTime`);
    const sent = await sendHeartbeats(payload, options);
    if (sent && maxTimestampMs > lastParsedAt) {
      await setAILastParsedAt(maxTimestampMs);
    }
    return sent;
  });
}
async function main() {
  const inp = parseInput();
  const debug = options.getSetting("settings", "debug");
  logger.setLevel(debug === "true" ? 0 /* DEBUG */ : 1 /* INFO */);
  try {
    if (inp) logger.debug(JSON.stringify(inp, null, 2));
    const isSessionEnd = inp?.hook_event_name === "SessionEnd";
    if (inp && (shouldSendHeartbeat(inp) || isSessionEnd)) {
      const sent = await syncJunieActivity();
      if (sent) await updateState();
    }
  } catch (err) {
    logger.errorException(err);
  }
}
main();
