// The AI check of symbol submissions (.github/workflows/ai-check.yml; Matt 2026-11-21: "link the signal desk back to claude
// via my api, that way when a new symbol comes in, it will automatically check the ports, make the back and front plate,
// check for duplicates and leave it for review").
// Each run goes through every open [symbol] submission that wants a check (new, or labelled ai-check), oldest first, as
// many as today's limit allows: Claude researches the device on the web, the answer becomes "the AI version" of the symbol
// (the connectors as the maker lists them, the size and power, where each connector sits), and a comment on the issue says
// what it found. NOTHING IS CHANGED OR PUBLISHED: the symbol desk shows the comment, and the maintainer takes the AI
// version (or not) and approves as before.
// Settings (repository variables): AI_MODEL (claude-opus-5-5), AI_EFFORT (high), AI_DAILY_MAX checks in 24 hours (10),
// AI_MAX_USD a check (3), AI_SINCE (2026-11-21: a submission sent before it is checked only when asked for, so switching the
// check on does not spend the daily budget on the ones already waiting). The key is the ANTHROPIC_API_KEY secret; without it
// nothing runs.
import { readFileSync, appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as kit from "./kit.mjs";
import * as R from "./review.mjs";
import { Conversation, CheckError } from "./claude.mjs";

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, "..", "..");
const lib = createRequire(import.meta.url)(path.join(root, "scripts", "symbol.js"));
const env = process.env;
const REPO = env.REPO || env.GITHUB_REPOSITORY || "MattVillis/signalflow-symbols";
const API = (env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/, "");
const MODEL = env.AI_MODEL || "claude-opus-5-5", EFFORT = env.AI_EFFORT || "high";
const DAILY = Number(env.AI_DAILY_MAX) > 0 ? Number(env.AI_DAILY_MAX) : 10;
const MAX_USD = Number(env.AI_MAX_USD) > 0 ? Number(env.AI_MAX_USD) : 3;
const SINCE = /^\d{4}-\d\d-\d\d/.test(env.AI_SINCE || "") ? env.AI_SINCE : "2026-11-21";
const BUILTINS_URL = env.BUILTINS_URL || "https://mattvillis.github.io/signalflow/builtins.json";
const log = (...a) => console.log(...a);
const summary = line => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, line + "\n"); };

async function gh(p, opt = {}) {
  const r = await fetch(API + p, { ...opt, headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "signalflow-ai-check", ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
  if (r.status === 204) return null;
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {}
  if (!r.ok) throw Object.assign(new Error(`GitHub ${opt.method || "GET"} ${p}: ${r.status} ${j?.message || t.slice(0, 200)}`), { status: r.status });
  return j;
}
const post = (p, body) => gh(p, { method: "POST", body: JSON.stringify(body) });
async function relabel(n, add, remove) {
  for (const name of remove) await gh(`/repos/${REPO}/issues/${n}/labels/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(e => { if (e.status !== 404) throw e; });
  if (add.length) await post(`/repos/${REPO}/issues/${n}/labels`, { labels: add });
}
// the labels this uses, made once with a colour and a description (GitHub would make them grey and bare on first use)
async function ensureLabels() {
  const want = [[R.LABELS.ask, "5319e7", "Ask the AI check to (re)check this submission"], [R.LABELS.busy, "c5def5", "The AI check is checking this submission now"],
    [R.LABELS.done, "0e8a16", "The AI check has commented: see the symbol desk"], [R.LABELS.failed, "d93f0b", "The AI check didn't finish: see its comment"]];
  for (const [name, color, description] of want) await post(`/repos/${REPO}/labels`, { name, color, description }).catch(() => {});
}
async function openIssues() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const list = await gh(`/repos/${REPO}/issues?state=open&per_page=100&sort=created&direction=asc&page=${page}`);
    all.push(...list); if (list.length < 100) break;
  }
  return all;
}
// checks made in the last 24 hours (finished or not: both cost), counted from the check comments themselves
async function usedToday() {
  const since = new Date(Date.now() - 864e5).toISOString(); let n = 0;
  for (let page = 1; page <= 10; page++) {
    const list = await gh(`/repos/${REPO}/issues/comments?since=${since}&per_page=100&page=${page}`);
    n += list.filter(c => c.user?.login === R.BOT && String(c.body || "").includes(`<!-- ${R.MARKER} `) && c.created_at >= since).length;
    if (list.length < 100) break;
  }
  return n;
}
const rows = b => (b.list || []).map(([label, side, dir, signal, conn]) => ({ label, side, dir, signal, conn }));

async function main() {
  if (!env.ANTHROPIC_API_KEY) { log("No ANTHROPIC_API_KEY secret: the AI check is off. Add the secret to switch it on."); return; }
  const wanted = env.ISSUE ? [Number(env.ISSUE)] : null;
  let issues = wanted ? [await gh(`/repos/${REPO}/issues/${wanted[0]}`)] : await openIssues();
  // the issue that woke this run: GitHub's issue list can trail a brand-new issue by a few seconds
  if (!wanted && Number(env.EVENT_ISSUE) && !issues.some(i => i.number === Number(env.EVENT_ISSUE))) {
    const i = await gh(`/repos/${REPO}/issues/${Number(env.EVENT_ISSUE)}`).catch(() => null); if (i) issues.push(i);
  }
  const subs = issues.filter(i => R.isSymbolIssue(i, lib));
  // a submission that doesn't pass the library's own checks is not checked (validate.yml has said why)
  const read = i => { try { const raw = lib.parseSubmission(i.body); return lib.validate(raw).length ? null : lib.normalise(raw); } catch { return null; } };
  const todo = subs.filter(i => R.wantsCheck(i, SINCE) || (wanted && i.state === "open")).sort((a, b) => a.number - b.number)
    .map(i => ({ issue: i, sub: read(i) })).filter(x => x.sub || log(`#${x.issue.number}: doesn't pass the library's checks, so it isn't checked`));
  log(`${subs.length} open symbol submission${subs.length === 1 ? "" : "s"}, ${todo.length} to check (model ${MODEL}, effort ${EFFORT}, at most ${DAILY} a day, $${MAX_USD} each, sent since ${SINCE} or asked for)`);
  if (!todo.length) return;
  await ensureLabels();
  let used = await usedToday();
  // what the library has, for the duplicate question: the built-ins (the site's builtins.json), the shared library, the others waiting
  let builtins = [];
  try { builtins = (await (await fetch(BUILTINS_URL)).json()).symbols || []; } catch (e) { log(`builtins.json not read (${e.message}): checking without the built-ins`); }
  const shared = JSON.parse(readFileSync(path.join(root, "library.json"), "utf8")).library || [];
  const waiting = subs.map(i => ({ n: i.number, s: read(i) })).filter(w => w.s);
  summary(`### AI check · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC\n\n| Issue | Symbol | Verdict | Cost |\n|---|---|---|---|`);
  for (const { issue, sub } of todo) {
    if (used >= DAILY) { log(`Today's limit of ${DAILY} checks is reached: #${issue.number} and any after it wait for a later run.`); summary(`| #${issue.number} | | waits: daily limit | |`); break; }
    const n = issue.number;
    const pool = [
      ...builtins.map(b => ({ where: "built-in", name: b.name, ports: b.list ? rows(b) : null, count: b.ports })),
      ...shared.filter(d => d.id !== sub.id).map(d => ({ where: "shared library", name: d.name, ports: R.expandedPorts(d) })),
      ...waiting.filter(w => w.n !== n).map(w => ({ where: `waiting #${w.n}`, name: w.s.name, ports: R.expandedPorts(w.s) })),
    ];
    const dupes = kit.findSymbolDupes({ id: sub.id, name: sub.name, ports: R.expandedPorts(sub) }, pool);
    log(`#${n} ${sub.name}: checking`);
    await relabel(n, [R.LABELS.busy], [R.LABELS.ask, R.LABELS.failed, R.LABELS.done]);
    used++;
    const t0 = Date.now(), chat = new Conversation({ model: MODEL, effort: EFFORT, system: R.systemPrompt(pool), usd: MAX_USD, log });
    const meta = () => ({ model: MODEL, at: new Date().toISOString(), usd: Math.round(chat.cost() * 100) / 100, secs: Math.round((Date.now() - t0) / 1000) });
    try {
      let final = await chat.ask(R.userPrompt(issue, sub, dupes));
      // the app's own count checks; a miss goes back once, while there is budget left
      let c = R.contradictions(final, sub);
      if (c.text && !chat.finalOnly && chat.cost() < MAX_USD * 0.7) {
        log(`#${n}: contradiction, asking again`);
        try { const again = await chat.ask(c.text); if (again?.symbol || again?.verdict) { final = again; c = R.contradictions(final, sub); } }
        catch (e) { if (e.fatal) throw e; log(`#${n}: the second pass failed (${e.message}); keeping the first answer`); }
      }
      const prop = final.verdict === "not_found" ? null : R.proposalFrom(final, sub, lib);
      const review = R.reviewData(final, { warnings: c.warnings });
      const body = R.commentBody({ issue, sub, prop, review, diff: prop?.sym ? R.diffLines(sub, prop.sym) : [], dupes, meta: meta() });
      await post(`/repos/${REPO}/issues/${n}/comments`, { body });
      await relabel(n, [R.LABELS.done], [R.LABELS.busy]);
      log(`#${n}: ${review.verdict}, about $${meta().usd.toFixed(2)}, ${meta().secs} s, ${chat.usage.requests} requests, ${chat.usage.searches} searches, ${chat.used.view_image || 0} pictures`);
      summary(`| #${n} | ${R.md(sub.name, 40)} | ${review.verdict} | $${meta().usd.toFixed(2)} |`);
    } catch (e) {
      const message = e instanceof CheckError ? e.message : `the check failed: ${e.message}`;
      log(`#${n}: ${message}`);
      await post(`/repos/${REPO}/issues/${n}/comments`, { body: R.errorBody({ issue, message: `The check stopped: ${message}.`, meta: meta() }) }).catch(() => {});
      await relabel(n, [R.LABELS.failed], [R.LABELS.busy]).catch(() => {});
      summary(`| #${n} | ${R.md(sub.name, 40)} | failed | $${meta().usd.toFixed(2)} |`);
      if (e.fatal || !(e instanceof CheckError)) throw e;
    }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
