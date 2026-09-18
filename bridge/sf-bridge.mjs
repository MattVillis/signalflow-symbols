#!/usr/bin/env node
// SignalFlow local CLI bridge — routes AI symbol requests through headless
// Claude Code (`claude -p`) so symbol building runs on your Claude
// subscription instead of a metered API key.
//
//   node sf-bridge.mjs                serve on http://localhost:8317
//   node sf-bridge.mjs --open        serve (or reuse a running instance)
//                                    AND open signalflow.html next to it
//   node sf-bridge.mjs install       autostart at login (this OS) + start now
//   node sf-bridge.mjs uninstall     remove autostart + stop running instance
//   node sf-bridge.mjs status        is a bridge running?
//   node sf-bridge.mjs quit          stop a running instance
//   node sf-bridge.mjs test          run the engine once and show raw output
//
// Config (env):  SF_PORT=8317  SF_CMD=claude  SF_TIMEOUT=180000  SF_EFFORT=high
//   SF_APP_URL=https://mattvillis.github.io/signalflow-symbols/  (--open target
//     when no signalflow.html sits next to the bridge)
//   SF_SYMBOLS_DIR=<checkout of the symbols repo>  (default: ../signalflow-symbols)
//     when present and pushable, the app gets a maintainer-only "Publish to
//     repo" button: POST /publish upserts symbols into library.json + git push
//   SF_ARGS='["-p","{PROMPT}","--output-format","text"]'   custom CLI template
//     ({PROMPT}/{IMAGE} placeholders; without {PROMPT} the prompt goes to stdin)
//
// Windows note: the npm install of Claude Code is `claude.cmd`, which Node's
// secure (shell-less) spawn can't execute. This bridge resolves that shim to
// the real program next to it — bin/claude.exe (native builds, 2.1.x+) or
// cli.js under Node (older JS builds) — and spawns it directly with the prompt
// on argv. Only if neither exists does it fall back to cmd.exe running the
// .cmd shim, with the prompt on stdin so nothing user-typed can hit a shell.

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WIN = process.platform === "win32";
const PORT = Number(process.env.SF_PORT || 8317);
const CMD = process.env.SF_CMD || "claude";
const TIMEOUT = Number(process.env.SF_TIMEOUT || 180000);
const SCRIPT = fileURLToPath(import.meta.url);
const NODE = process.execPath;
const argv = process.argv.slice(2);
const sub = ["install", "uninstall", "status", "quit", "test"].find(x => argv.includes(x));
const OPEN = argv.includes("--open");

const extFor = m => m === "application/pdf" ? "pdf" : m === "image/jpeg" ? "jpg"
  : m === "image/webp" ? "webp" : m === "image/gif" ? "gif" : "png";

/* ---- engine resolution: find a spawnable Claude Code ---- */
function resolveEngine() {
  const hasSep = /[\\/]/.test(CMD);
  let found = hasSep ? (existsSync(CMD) ? CMD : null) : null;
  if (!found && !hasSep) {
    const w = spawnSync(WIN ? "where" : "which", [CMD], { encoding: "utf8" });
    if (w.status === 0) {
      const lines = w.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      found = lines.find(l => /\.exe$/i.test(l)) || lines.find(l => /\.(cmd|bat)$/i.test(l)) || lines[0];
    }
  }
  if (!found && !hasSep) {
    const home = homedir();
    const cands = WIN
      ? [join(process.env.APPDATA || "", "npm", CMD + ".cmd"),
         join(home, ".local", "bin", CMD + ".exe"),
         join(home, ".local", "bin", CMD + ".cmd")]
      : [join(home, ".local", "bin", CMD), "/usr/local/bin/" + CMD,
         "/opt/homebrew/bin/" + CMD, join(home, ".npm-global", "bin", CMD)];
    found = cands.find(existsSync) || null;
  }
  if (!found) return { file: CMD, pre: [], note: `'${CMD}' NOT RESOLVED — set SF_CMD to the executable's full path` , ok: false };
  if (WIN) {
    // npm layout: whichever shim we landed on (extensionless sh, .cmd or .ps1),
    // the real program lives in node_modules/@anthropic-ai/claude-code next to it:
    // bin/claude.exe (native, 2.1.x+) or cli.js (older JS builds) — run that
    // directly, no shim, no shell.
    const pkg = join(dirname(found), "node_modules", "@anthropic-ai", "claude-code");
    const exe = join(pkg, "bin", "claude.exe"), cli = join(pkg, "cli.js");
    if (existsSync(exe)) return { file: exe, pre: [], note: `${found} → ${exe}`, ok: true };
    if (existsSync(cli)) return { file: NODE, pre: [cli], note: `${found} → node cli.js`, ok: true };
    if (/\.exe$/i.test(found)) return { file: found, pre: [], note: found, ok: true };
    const cmdSib = /\.(cmd|bat)$/i.test(found) ? found
      : [found + ".cmd", found + ".bat", found.replace(/\.ps1$/i, ".cmd")].find(p => p !== found && existsSync(p));
    if (cmdSib) return { file: "cmd.exe", pre: ["/d", "/s", "/c", cmdSib], note: `${cmdSib} via cmd.exe`, ok: true };
    return { file: found, pre: [], note: `${found} (not directly runnable on Windows — set SF_CMD to a .exe or .cmd)`, ok: false };
  }
  return { file: found, pre: [], note: found, ok: true };
}
const ENGINE = resolveEngine();

function buildInvocation(prompt, imagePath) {
  const full = imagePath
    ? `${prompt}\n\nThe panel image is saved at this exact path — read it before answering: ${imagePath}`
    : prompt;
  if (process.env.SF_ARGS) {
    const tpl = process.env.SF_ARGS;
    const args = JSON.parse(tpl).map(a => a.replace("{PROMPT}", full).replace("{IMAGE}", imagePath || ""));
    return { args, stdin: tpl.includes("{PROMPT}") ? null : full };
  }
  // Only web + file-read are allowed; everything else is REMOVED from the model's
  // tool list (not merely permission-denied) so it never burns turns trying to
  // shell out to parse a PDF — observed headlessly, and every denied attempt is
  // a turn not spent finding a readable spec page.
  // Effort pinned high: research quality tracks how many pages the model is
  // willing to try before it gives up and answers from memory.
  const flags = ["--output-format", "text", "--effort", process.env.SF_EFFORT || "high",
    "--allowedTools", "WebSearch,WebFetch,Read",
    "--disallowedTools", "Bash,PowerShell,Edit,Write,NotebookEdit,Task,Agent,Skill,Workflow,Glob,Grep,ToolSearch"];
  // symbol jobs need no MCP servers — isolate them so a hanging/slow MCP boot
  // can never stall the run (JSON arg skipped on the cmd.exe fallback, where
  // cmd's re-parsing would mangle the quotes)
  const mcpOff = ENGINE.file === "cmd.exe" ? [] : ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'];
  if (ENGINE.file === "cmd.exe") {
    // .cmd fallback goes through a real shell — keep user text off its command line
    return { args: ["-p", "Follow the instructions provided on stdin exactly and completely.", ...flags], stdin: full };
  }
  return { args: ["-p", full, ...flags, ...mcpOff], stdin: null };
}
const cleanupImg = p => { if (p) { try { unlinkSync(p); } catch { /* gone */ } } };

/* ---- maintainer publish: direct commit into the symbols repo checkout ---- */
const SYMBOLS_DIR = process.env.SF_SYMBOLS_DIR || join(dirname(SCRIPT), "..", "signalflow-symbols");
const canPublish = () => existsSync(join(SYMBOLS_DIR, "library.json")) && existsSync(join(SYMBOLS_DIR, "scripts", "symbol.js"));
function publishSymbols(list) {
  if (!canPublish()) return { ok: false, error: `symbols repo checkout not found at ${SYMBOLS_DIR} (set SF_SYMBOLS_DIR)` };
  const git = (...a) => spawnSync("git", a, { cwd: SYMBOLS_DIR, encoding: "utf8" });
  const lib = createRequire(import.meta.url)(join(SYMBOLS_DIR, "scripts", "symbol.js"));
  const pull = git("pull", "--rebase", "--quiet", "origin", "main");
  if (pull.status !== 0) return { ok: false, error: "git pull failed: " + (pull.stderr || pull.stdout).trim().slice(0, 300) };
  const path = join(SYMBOLS_DIR, "library.json");
  const file = JSON.parse(readFileSync(path, "utf8")); file.library = file.library || [];
  let added = 0, updated = 0; const bad = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const errs = lib.validate(raw);
    if (errs.length) { bad.push(`${raw?.name || raw?.id || "?"}: ${errs[0]}`); continue; }
    const sym = lib.normalise(raw);
    // unchanged copies are skipped so a re-publish doesn't bump every rev
    const cur = file.library.find(d => d.id === sym.id);
    if (cur && JSON.stringify({ ...cur, rev: 0 }) === JSON.stringify({ ...sym, rev: 0 })) continue;
    lib.upsert(file.library, sym) === "added" ? added++ : updated++;
  }
  if (!added && !updated) return { ok: true, added, updated, bad, note: "nothing to publish" };
  file.updated = new Date().toISOString();
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  const msg = `Publish from SignalFlow: ${added} added, ${updated} updated`;
  git("add", "library.json");
  const commit = git("-c", "user.name=SignalFlow", "-c", "user.email=signalflow@users.noreply.github.com", "commit", "-q", "-m", msg);
  if (commit.status !== 0) return { ok: false, error: "git commit failed: " + (commit.stderr || commit.stdout).trim().slice(0, 300) };
  const push = git("push", "--quiet", "origin", "main");
  if (push.status !== 0) return { ok: false, error: "git push failed: " + (push.stderr || push.stdout).trim().slice(0, 300) };
  return { ok: true, added, updated, bad, commit: git("rev-parse", "--short", "HEAD").stdout.trim() };
}
function execRaw(args, stdinPayload, timeoutMs, opts = {}) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(ENGINE.file, [...ENGINE.pre, ...args], {
      shell: false, windowsHide: opts.hide !== false, cwd: tmpdir(),
      // no-TTY CLIs (Ink apps like Claude Code) can hang waiting on a piped
      // stdin — give them NO stdin unless we actually have a payload to send
      stdio: [stdinPayload != null ? "pipe" : "ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let out = "", errOut = "", done = false, timedOut = false;
    const timer = setTimeout(() => { if (!done) { timedOut = true; child.kill("SIGKILL"); } }, timeoutMs || TIMEOUT);
    child.stdout.on("data", d => out += d);
    child.stderr.on("data", d => errOut += d);
    child.on("error", e => { if (done) return; done = true; clearTimeout(timer); resolve({ spawnError: e.message, out, err: errOut, code: null, ms: Date.now() - t0, timedOut }); });
    child.on("exit", code => { if (done) return; done = true; clearTimeout(timer); setTimeout(() => resolve({ out, err: errOut, code, ms: Date.now() - t0, timedOut }), 250); });
    if (stdinPayload != null) { child.stdin.write(stdinPayload); child.stdin.end(); }
  });
}
function execEngine(prompt, imagePath) {
  const inv = buildInvocation(prompt, imagePath);
  return execRaw(inv.args, inv.stdin, TIMEOUT);
}

const APP_URL = process.env.SF_APP_URL || "https://mattvillis.github.io/signalflow-symbols/";
function openApp() {
  // a local standalone next to the bridge wins (developer setup); beta users
  // just have the bridge files and get the hosted app
  const local = join(dirname(SCRIPT), "signalflow.html");
  const url = existsSync(local) ? pathToFileURL(local).href : APP_URL;
  const [c, a] = WIN ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(c, a, { detached: true, stdio: "ignore" }).unref(); console.log(`[sf-bridge] opened ${url}`); }
  catch { console.log(`[sf-bridge] open manually: ${url}`); }
}

const ping = () => new Promise(res => {
  const r = http.get({ host: "127.0.0.1", port: PORT, path: "/", timeout: 800 },
    x => { x.resume(); res(x.statusCode === 200); });
  r.on("error", () => res(false)); r.on("timeout", () => { r.destroy(); res(false); });
});
const quitRemote = () => new Promise(res => {
  const r = http.request({ host: "127.0.0.1", port: PORT, path: "/quit", method: "POST", timeout: 800 },
    x => { x.resume(); res(true); });
  r.on("error", () => res(false)); r.on("timeout", () => { r.destroy(); res(false); }); r.end();
});

function install() {
  if (WIN) {
    const vbs = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "SignalFlowBridge.vbs");
    writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${NODE}"" ""${SCRIPT}""", 0, False\r\n`);
    console.log(`[sf-bridge] autostart installed: ${vbs}`);
  } else if (process.platform === "darwin") {
    const dir = join(homedir(), "Library", "LaunchAgents"); mkdirSync(dir, { recursive: true });
    const plist = join(dir, "com.signalflow.bridge.plist");
    const env = ENGINE.ok && !/[\\/]/.test(CMD) ? `<key>EnvironmentVariables</key><dict><key>SF_CMD</key><string>${ENGINE.pre[0] || ENGINE.file}</string></dict>` : "";
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.signalflow.bridge</string>
<key>ProgramArguments</key><array><string>${NODE}</string><string>${SCRIPT}</string></array>
${env}
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>/tmp/sf-bridge.log</string>
<key>StandardErrorPath</key><string>/tmp/sf-bridge.log</string>
</dict></plist>`);
    spawnSync("launchctl", ["load", "-w", plist]);
    console.log(`[sf-bridge] autostart installed: ${plist}`);
  } else {
    const dir = join(homedir(), ".config", "systemd", "user"); mkdirSync(dir, { recursive: true });
    const unit = join(dir, "sf-bridge.service");
    const env = ENGINE.ok && ENGINE.pre.length === 0 ? `Environment=SF_CMD=${ENGINE.file}` : "";
    writeFileSync(unit, `[Unit]
Description=SignalFlow CLI bridge
[Service]
ExecStart=${NODE} ${SCRIPT}
${env}
Restart=on-failure
[Install]
WantedBy=default.target
`);
    spawnSync("systemctl", ["--user", "daemon-reload"]);
    spawnSync("systemctl", ["--user", "enable", "--now", "sf-bridge"]);
    console.log(`[sf-bridge] autostart installed: ${unit}`);
  }
  ping().then(up => {
    if (!up && WIN) {
      spawn(NODE, [SCRIPT], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      console.log("[sf-bridge] started now (and at every login).");
    } else console.log(up ? "[sf-bridge] already running." : "[sf-bridge] will start at login; run `node sf-bridge.mjs` to start now.");
  });
}
async function uninstall() {
  await quitRemote();
  if (WIN) {
    const vbs = join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "SignalFlowBridge.vbs");
    try { unlinkSync(vbs); console.log("[sf-bridge] autostart removed."); } catch { console.log("[sf-bridge] no autostart entry found."); }
  } else if (process.platform === "darwin") {
    const plist = join(homedir(), "Library", "LaunchAgents", "com.signalflow.bridge.plist");
    spawnSync("launchctl", ["unload", "-w", plist]);
    try { unlinkSync(plist); console.log("[sf-bridge] autostart removed."); } catch { console.log("[sf-bridge] no autostart entry found."); }
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", "sf-bridge"]);
    try { unlinkSync(join(homedir(), ".config", "systemd", "user", "sf-bridge.service")); console.log("[sf-bridge] autostart removed."); }
    catch { console.log("[sf-bridge] no autostart entry found."); }
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  }
}

if (sub === "status") { ping().then(up => { console.log(up ? `[sf-bridge] running on :${PORT}` : "[sf-bridge] not running"); process.exit(up ? 0 : 1); }); }
else if (sub === "quit") { quitRemote().then(ok => { console.log(ok ? "[sf-bridge] stopped." : "[sf-bridge] nothing to stop."); }); }
else if (sub === "test") {
  console.log(`[sf-bridge] engine: ${ENGINE.note}`);
  if (!ENGINE.ok) { console.log("[sf-bridge] engine not resolved — fix SF_CMD first."); process.exit(1); }
  console.log("[sf-bridge] step 1/2 — bootstrap check: --version through the identical spawn path (30s limit, no API)…");
  execRaw(["--version"], null, 30000).then(v => {
    const first = (v.out || v.err || "").trim().split(/\r?\n/)[0] || "(no output)";
    console.log(`[sf-bridge] --version → code ${v.code} in ${(v.ms / 1000).toFixed(1)}s${v.timedOut ? " (TIMED OUT)" : ""}${v.spawnError ? " — spawn error: " + v.spawnError : ""}: ${first}`);
    if (v.timedOut || v.code !== 0) {
      console.log("[sf-bridge] verdict: the CLI stalls at BOOTSTRAP — before auth or network. Environmental (stdin/TTY/env), not your login.");
    } else {
      console.log("[sf-bridge] bootstrap OK — the spawn path is healthy.");
    }
    const PROMPT = "Reply with exactly the single word: BRIDGE-OK";
    const passed = r => r.code === 0 && /BRIDGE-OK/.test(r.out);
    const show = (label, r) => {
      console.log(`[sf-bridge] ${label}: code ${r.code} in ${(r.ms / 1000).toFixed(1)}s${r.timedOut ? " (TIMED OUT)" : ""}${r.spawnError ? " — spawn error: " + r.spawnError : ""}`);
      console.log("---- stdout ----"); console.log((r.out || "(empty)").trim() || "(empty)");
      console.log("---- stderr ----"); console.log((r.err || "(empty)").trim() || "(empty)");
    };
    const STEP_MS = Math.min(TIMEOUT, 90000);
    (async () => {
      const inv = buildInvocation(PROMPT, null);
      console.log("[sf-bridge] step 2 — full invocation (same flags as real runs)…");
      console.log(`[sf-bridge] argv: ${JSON.stringify(inv.args.map(a => a.length > 64 ? a.slice(0, 61) + "…" : a))}`);
      const r2 = await execRaw(inv.args, inv.stdin, STEP_MS);
      show("step 2", r2);
      if (passed(r2)) { console.log("[sf-bridge] SELF-TEST PASSED"); process.exit(0); }
      if (/401|OAuth|authenticat/i.test(r2.err + r2.out)) {
        console.log("[sf-bridge] VERDICT: AUTH — Claude Code's login is expired/invalid. Run `claude login`, verify with `claude -p \"say OK\"`, then re-run this test.");
        process.exit(4);
      }

      console.log("[sf-bridge] step 2b — minimal invocation: -p only, no flags…");
      const r2b = await execRaw(["-p", PROMPT], null, STEP_MS);
      show("step 2b", r2b);
      if (passed(r2b)) {
        console.log("[sf-bridge] VERDICT: print mode works — one of the standard flags stalls this CLI version. Paste this output; the bridge can drop/adjust flags.");
        process.exit(2);
      }

      console.log("[sf-bridge] step 2c — minimal invocation with a VISIBLE console (a window will flash)…");
      const r2c = await execRaw(["-p", PROMPT], null, STEP_MS, { hide: false });
      show("step 2c", r2c);
      if (passed(r2c)) {
        console.log("[sf-bridge] VERDICT: the engine needs a console window (windowsHide interaction). Easy bridge fix — report this.");
        process.exit(3);
      }

      const tail = (s, n = 3200) => { s = (s || "").trim(); return s.length > n ? "…" + s.slice(-n) : (s || "(empty)"); };
      console.log("[sf-bridge] step 3 — debug capture: full run with --debug; last lines name the stall point…");
      const d = await execRaw([...inv.args, "--debug"], inv.stdin, STEP_MS);
      console.log(`[sf-bridge] debug run: code ${d.code} in ${(d.ms / 1000).toFixed(1)}s${d.timedOut ? " (TIMED OUT)" : ""}`);
      console.log("---- debug stderr (tail) ----"); console.log(tail(d.err));
      console.log("---- debug stdout (tail) ----"); console.log(tail(d.out));
      console.log("[sf-bridge] SELF-TEST FAILED at every rung. FIRST run `claude -p \"say OK\"` in your own cmd window — an expired login prints a 401 there while hanging silently here (fix: `claude login`). If the terminal run works and this still fails, report the full output above.");
      process.exit(1);
    })();
    return null;
  }).then(() => { /* ladder handles exit */ });
}
else if (sub === "install") { install(); }
else if (sub === "uninstall") { uninstall(); }
else {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // the hosted app (https) talks to this http://localhost bridge — Chrome's
    // Private Network Access wants this on the preflight
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
    if (req.method === "GET" && req.url.startsWith("/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: true, engine: ENGINE.note, publish: canPublish() }));
    }
    if (req.method === "GET" && req.url.startsWith("/fetch?")) {
      // CORS-free fetch of the online symbol repo for the app (GET, http(s) only, 4 MB cap)
      const target = new URL(req.url, "http://x").searchParams.get("url") || "";
      const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (!/^https?:\/\//i.test(target)) return send(400, { ok: false, error: "url must be http(s)" });
      return fetch(target, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "User-Agent": "sf-bridge" } })
        .then(async r => {
          if (!r.ok) return send(200, { ok: false, error: `HTTP ${r.status}` });
          const text = await r.text();
          if (text.length > 4e6) return send(200, { ok: false, error: "file too large" });
          send(200, { ok: true, text });
        })
        .catch(e => send(200, { ok: false, error: e.name === "TimeoutError" ? "timed out" : e.message }));
    }
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(`SignalFlow bridge running\nengine: ${ENGINE.note}\nPOST /run {prompt, image?} to use.\nGET /fetch?url=… proxies a symbol-repo file.\n`);
    }
    if (req.method === "POST" && req.url.startsWith("/publish")) {
      let body = "";
      req.on("data", c => { body += c; if (body.length > 8e6) req.destroy(); });
      req.on("end", () => {
        let list; try { ({ library: list } = JSON.parse(body)); } catch { res.writeHead(400, { "Content-Type": "application/json" }); return res.end('{"ok":false,"error":"bad JSON body"}'); }
        const r = publishSymbols(list);
        console.log(`[sf-bridge] publish: ${r.ok ? `${r.added} added, ${r.updated} updated${r.commit ? " → " + r.commit : ""}` : "FAILED " + r.error}`);
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(r));
      });
      return;
    }
    if (req.method === "POST" && req.url.startsWith("/quit")) {
      res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
      return setTimeout(() => process.exit(0), 60);
    }
    if (req.method !== "POST" || !req.url.startsWith("/run")) { res.writeHead(404); return res.end(); }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 40e6) req.destroy(); });
    req.on("end", () => {
      let prompt, image;
      try { ({ prompt, image } = JSON.parse(body)); } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "bad JSON body" }));
      }
      if (!prompt) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: "missing prompt" })); }
      if (!ENGINE.ok) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: ENGINE.note }));
      }
      let imgPath = null;
      if (image?.b64) {
        imgPath = join(tmpdir(), `sf-panel-${Date.now()}.${extFor(image.mime)}`);
        try { writeFileSync(imgPath, Buffer.from(image.b64, "base64")); }
        catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ok: false, error: `temp image write failed: ${e.message}` })); }
      }
      console.log(`[sf-bridge] ${new Date().toISOString()} run: ${ENGINE.note} (prompt ${prompt.length} chars${imgPath ? ", +image" : ""})`);
      execEngine(prompt, imgPath).then(r => {
        cleanupImg(imgPath);
        console.log(`[sf-bridge] done in ${(r.ms / 1000).toFixed(1)}s — code ${r.code}, stdout ${r.out.length}B, stderr ${r.err.length}B${r.timedOut ? ", TIMED OUT" : ""}${r.spawnError ? ", spawn error" : ""}`);
        if (process.env.SF_DEBUG) {
          console.log("[sf-bridge] STDOUT >>>\n" + (r.out || "(empty)") + "\n<<<");
          console.log("[sf-bridge] STDERR >>>\n" + (r.err || "(empty)") + "\n<<<");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        if (r.spawnError) return res.end(JSON.stringify({ ok: false, error: `could not start engine (${ENGINE.note}): ${r.spawnError} — set SF_CMD to Claude Code's full path` }));
        if (r.code === 0 && r.out.trim()) return res.end(JSON.stringify({ ok: true, text: r.out, code: r.code }));
        const detail = (r.err || r.out || "").trim().slice(0, 800);
        if (/401|OAuth|authenticat/i.test(detail)) return res.end(JSON.stringify({ ok: false, code: r.code,
          error: `Claude Code login is expired or invalid — run \`claude login\` in a terminal, verify with \`claude -p "say OK"\`, then retry. (${detail.slice(0, 200)})` }));
        if (r.timedOut && !detail) return res.end(JSON.stringify({ ok: false, code: r.code,
          error: `engine went silent and was killed at ${TIMEOUT / 1000}s — on Windows this is most often an EXPIRED CLAUDE CODE LOGIN stalling headlessly. Run \`claude login\` in a terminal (then \`claude -p "say OK"\` should print OK) and retry; \`node sf-bridge.mjs test\` gives full diagnostics` }));
        res.end(JSON.stringify({ ok: false, code: r.code,
          error: detail || `CLI exited code ${r.code} with no output — run \`node sf-bridge.mjs test\` in a terminal to see the raw engine behaviour` }));
      });
    });
  });
  server.on("error", e => {
    if (e.code === "EADDRINUSE") {
      console.log(`[sf-bridge] already running on :${PORT}${OPEN ? " — opening the app." : ""}`);
      if (OPEN) openApp();
      process.exit(0);
    }
    console.error("[sf-bridge]", e.message); process.exit(1);
  });
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[sf-bridge] listening on http://localhost:${PORT}`);
    console.log(`[sf-bridge] engine: ${ENGINE.note}${process.env.SF_ARGS ? " (custom SF_ARGS)" : ""}`);
    if (!ENGINE.ok) console.log("[sf-bridge] WARNING: /run will fail until SF_CMD points at Claude Code.");
    if (OPEN) openApp();
  });
}
