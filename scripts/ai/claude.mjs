// One check's conversation with Claude: the agent loop, by hand (the server's web_search / web_fetch and this workflow's
// page_images / view_image in one tool list), with what it may spend held to a budget.
// - streaming, so a long answer never meets an HTTP timeout; finalMessage() collects it
// - pause_turn (the server's own tool loop paused): the answer goes back as it is, with no new message, and it resumes
// - client tool calls: run together, every result in ONE user message
// - the cost so far is worked out from each answer's usage; at 80 % of the budget Claude is told to answer with what it
//   has and is given no more tools (tool_choice none), past 150 % the check stops
// - refusal / max_tokens / no JSON after one reminder: the check fails with that reason
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, runTool } from "./tools.mjs";
import { costOf, parseAnswer } from "./review.mjs";

export class CheckError extends Error {
  constructor(message, { fatal = false } = {}) { super(message); this.fatal = fatal; }
}
// the API's server tools (their dynamic-filtering versions), capped per request
export const SERVER_TOOLS = [
  { type: "web_search_20260209", name: "web_search", max_uses: 8 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 10, max_content_tokens: 40000 },
];

export class Conversation {
  constructor({ model, effort, system, usd, requests = 16, minutes = 15, fallbacks = true, log = () => {} }) {
    // the key from ANTHROPIC_API_KEY; ANTHROPIC_BASE_URL moves it (the tests' fake API)
    this.client = new Anthropic({ maxRetries: 3, timeout: 8 * 60 * 1000 });
    Object.assign(this, { model, effort, usd, requestCap: requests, fallbacks, log });
    this.system = [{ type: "text", text: system }];
    this.tools = [...SERVER_TOOLS, ...TOOLS];
    this.messages = [];
    this.used = {};
    this.usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, searches: 0, fetches: 0, requests: 0 };
    this.deadline = Date.now() + minutes * 60 * 1000;
    this.finalOnly = false;
  }
  cost() { return costOf(this.model, this.usage); }
  // a user turn (the submission, or a contradiction to resolve) -> the parsed JSON answer
  async ask(text) {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    let reminded = false;
    for (;;) {
      if (this.usage.requests >= this.requestCap) throw new CheckError(`stopped after ${this.usage.requests} requests without a final answer`);
      if (Date.now() > this.deadline) throw new CheckError("ran out of time (the check's time limit) without a final answer");
      if (this.cost() > this.usd * 1.5) throw new CheckError(`stopped at about $${this.cost().toFixed(2)}, over its budget`);
      const msg = await this.request();
      if (msg.stop_reason === "pause_turn") continue;
      if (msg.stop_reason === "refusal") throw new CheckError(`Claude declined to answer (${msg.stop_details?.category || "no reason given"})`);
      if (msg.stop_reason === "max_tokens") throw new CheckError("the answer was cut off at the output limit");
      const calls = msg.content.filter(b => b.type === "tool_use");
      if (msg.stop_reason === "tool_use" && calls.length) {
        const results = await Promise.all(calls.map(async c => {
          const r = await runTool(c.name, c.input, this.used);
          this.log(`  ${c.name} ${String(c.input?.url || "").slice(0, 120)}${r.is_error ? " -> " + String(r.content).slice(0, 120) : ""}`);
          return { type: "tool_result", tool_use_id: c.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) };
        }));
        if (!this.finalOnly && this.cost() > this.usd * 0.8) {
          this.finalOnly = true;
          results.push({ type: "text", text: "This check's research budget is used up: no more tools. Give your final JSON object now, from what you have found, and say in \"notes\" what you could not check." });
        }
        this.messages.push({ role: "user", content: results });
        continue;
      }
      const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("\n");
      const answer = parseAnswer(text);
      if (answer) return answer;
      if (reminded) throw new CheckError("Claude's final answer was not the JSON object asked for");
      reminded = true;
      this.messages.push({ role: "user", content: [{ type: "text", text: "Reply with only the JSON object described in the instructions, nothing else." }] });
    }
  }
  async request() {
    const p = { model: this.model, max_tokens: 64000, system: this.system, tools: this.tools, messages: this.messages,
      output_config: { effort: this.effort }, cache_control: { type: "ephemeral" } };
    if (this.finalOnly) p.tool_choice = { type: "none" };
    // the web tools' dynamic filtering runs in a code-execution container: a continuation must name it, or it starts afresh
    if (this.container) p.container = this.container;
    // a request a model declines is retried on another model by the API itself ("default": it picks by the reason)
    if (this.fallbacks) { p.betas = ["server-side-fallback-2026-07-01"]; p.fallbacks = "default"; }
    let msg;
    try { msg = await this.client.beta.messages.stream(p).finalMessage(); }
    catch (e) {
      // an account without the fallback beta: carry on without it
      if (this.fallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) { this.fallbacks = false; this.log("  (server-side fallback refused: off for this run)"); return this.request(); }
      // a bad key or no credit stops the whole run: every other check would fail the same way
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new CheckError(`the API key was refused (${e.status}): check the ANTHROPIC_API_KEY secret`, { fatal: true });
      if (e instanceof Anthropic.BadRequestError && /credit|billing|spend/i.test(e.message)) throw new CheckError(`the API refused the request: ${e.message}`, { fatal: true });
      if (e instanceof Anthropic.APIError) throw new CheckError(`the API answered ${e.status ?? "with an error"}: ${String(e.message).slice(0, 300)}`);
      throw e;
    }
    if (msg.container?.id) this.container = msg.container.id;
    const u = msg.usage || {};
    this.usage.requests++;
    this.usage.input += u.input_tokens || 0; this.usage.output += u.output_tokens || 0;
    this.usage.cacheWrite += u.cache_creation_input_tokens || 0; this.usage.cacheRead += u.cache_read_input_tokens || 0;
    this.usage.searches += u.server_tool_use?.web_search_requests || 0; this.usage.fetches += u.server_tool_use?.web_fetch_requests || 0;
    this.log(`  request ${this.usage.requests}: ${msg.stop_reason}, in ${u.input_tokens || 0} + cache ${u.cache_read_input_tokens || 0}/${u.cache_creation_input_tokens || 0}, out ${u.output_tokens || 0}, about $${this.cost().toFixed(2)} so far`);
    // the whole answer goes back as it came (thinking blocks, server tool blocks and all)
    this.messages.push({ role: "assistant", content: msg.content });
    return msg;
  }
}
