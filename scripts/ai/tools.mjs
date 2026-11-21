// The AI check's own tools, run here in the workflow (the API's web_fetch reads web pages and PDFs, not pictures):
// page_images lists the pictures on a web page, view_image hands Claude one of them. Both fetch only public http(s)
// addresses: a host that resolves to a private, loopback or link-local address (the runner's own network, a cloud
// metadata service) is refused when it is looked up, on every redirect, so a name that changes its address in between
// gains nothing. Nothing secret is sent: no token, no cookie.
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0 Safari/537.36 SignalFlow-AI-check";
// the tests serve their pages from this machine; never set in the workflow
const ALLOW_LOCAL = process.env.AI_TEST_ALLOW_LOCAL === "1";
export const LIMITS = { page_images: 8, view_image: 12 };
const IMAGE_MAX = 3_750_000;   // the API takes an image of up to 5 MB once base64-encoded
const PAGE_MAX = 4 << 20;

export function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || (a === 192 && b === 0);
  }
  const s = ip.toLowerCase();
  if (s === "::" || s === "::1") return true;
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s); if (v4) return privateIp(v4[1]);
  return /^(fc|fd|fe[89ab]|ff)/.test(s);
}
// http(s).get's lookup: refuse a private address at connect time (Node asks for one address, or for all of them)
function safeLookup(host, opts, cb) {
  dns.lookup(host, opts, (err, addr, fam) => {
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
    if (!ALLOW_LOCAL && list.some(a => privateIp(a.address))) return cb(Object.assign(new Error(`${host} is not on the public internet`), { code: "EPRIVATE" }));
    return Array.isArray(addr) ? cb(null, addr) : cb(null, addr, fam);
  });
}
function get1(u, accept, max, timeout) {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.get(u, { headers: { "User-Agent": UA, Accept: accept, "Accept-Encoding": "gzip, deflate, br", "Accept-Language": "en-GB,en;q=0.8" }, lookup: safeLookup, timeout }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); return resolve({ status: res.statusCode, headers: res.headers, body: Buffer.alloc(0) }); }
      const enc = String(res.headers["content-encoding"] || "").toLowerCase();
      const s = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
      const parts = []; let n = 0;
      s.on("data", c => { n += c.length; if (n > max) { req.destroy(); reject(new Error(`it is bigger than ${(max / 1048576).toFixed(1)} MB`)); } else parts.push(c); });
      s.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      s.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("it took too long to answer")));
    req.on("error", reject);
  });
}
export async function safeGet(url, { accept = "*/*", max = PAGE_MAX, timeout = 20000 } = {}) {
  let at = String(url || "");
  for (let hop = 0; hop <= 5; hop++) {
    let u; try { u = new URL(at); } catch { throw new Error("that is not a web address"); }
    if (!/^https?:$/.test(u.protocol)) throw new Error("only http and https addresses can be fetched");
    if (u.username || u.password) throw new Error("addresses with a user name or password are not fetched");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (!ALLOW_LOCAL && ((net.isIP(host) && privateIp(host)) || /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host))) throw new Error(`${host} is not on the public internet`);
    const r = await get1(u, accept, max, timeout);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { at = new URL(r.headers.location, u).href; continue; }
    if (r.status >= 400) throw new Error(`the site answered ${r.status}`);
    return { ...r, url: u.href };
  }
  throw new Error("too many redirects");
}

/* ---------- pictures ---------- */
export function sniff(b) {
  if (!b || b.length < 12) return null;
  if (b.readUInt32BE(0) === 0x89504e47 && b.length >= 24) return { type: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
    return { type: "image/jpeg", w: 0, h: 0 };
  }
  const t = b.subarray(0, 16).toString("latin1");
  if (/^GIF8[79]a/.test(t)) return { type: "image/gif", w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (t.startsWith("RIFF") && t.slice(8, 12) === "WEBP") {
    const f = t.slice(12, 16);
    if (f === "VP8X" && b.length >= 30) return { type: "image/webp", w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (f === "VP8L" && b.length >= 25) { const v = b.readUInt32LE(21); return { type: "image/webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (f === "VP8 " && b.length >= 30) return { type: "image/webp", w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    return { type: "image/webp", w: 0, h: 0 };
  }
  const head = b.subarray(0, 600).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return { type: "svg" };
  return null;
}
const attr = (tag, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag); return m ? (m[2] ?? m[3] ?? m[4] ?? "") : ""; };
const unent = s => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
const biggest = set => { let top = "", w = -1;
  String(set || "").split(",").forEach(part => { const [u, d] = part.trim().split(/\s+/); const n = parseFloat(d) || 1; if (u && n >= w) { top = u; w = n; } });
  return top; };
const PANEL_WORDS = /rear|back|front|panel|connect|interface|\bi-?\/?o\b|ports?\b|inputs?|outputs?|terminal|side|view/i;
const JUNK = /logo|icon|sprite|favicon|flag|banner|avatar|social|badge|award|placeholder|loading|spinner|pixel|tracking/i;
// the pictures on a page: <img> (srcset's largest, lazy-load attributes), <picture> sources, og:image, links to image
// files, and image URLs in the page's JSON (product galleries); panel-looking ones first
export function pageImages(html, base) {
  const seen = new Map();
  const add = (src, alt, how) => {
    src = unent(src).trim(); if (!src || /^data:/i.test(src)) return;
    let u; try { u = new URL(src, base).href; } catch { return; }
    if (!/^https?:/i.test(u)) return;
    const had = seen.get(u); if (had) { if (!had.alt && alt) had.alt = alt; return; }
    seen.set(u, { url: u, alt: unent(alt).replace(/\s+/g, " ").trim().slice(0, 120), how });
  };
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) { const t = m[0];
    add(biggest(attr(t, "srcset") || attr(t, "data-srcset")) || attr(t, "data-src") || attr(t, "data-lazy-src") || attr(t, "data-original") || attr(t, "data-zoom-image") || attr(t, "src"), attr(t, "alt") || attr(t, "title"), "img"); }
  for (const m of html.matchAll(/<source\b[^>]*>/gi)) add(biggest(attr(m[0], "srcset") || attr(m[0], "data-srcset")), "", "picture");
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) { const p = (attr(m[0], "property") || attr(m[0], "name")).toLowerCase();
    if (p === "og:image" || p === "twitter:image") add(attr(m[0], "content"), "", "the page's preview picture"); }
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+\.(?:png|jpe?g|webp|gif)(?:\?[^"']*)?)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi))
    add(m[1], m[2].replace(/<[^>]+>/g, " "), "a link");
  for (const m of html.matchAll(/"(?:image|url|src|contentUrl|zoom|large|full)"\s*:\s*"(https?:[^"]+?\.(?:png|jpe?g|webp|gif)(?:\?[^"]*)?)"/gi))
    add(m[1].replace(/\\\//g, "/"), "", "the page's data");
  const score = x => (PANEL_WORDS.test(x.alt) || PANEL_WORDS.test(decodeURIComponent(x.url.split("/").pop() || "")) ? 2 : 0) - (JUNK.test(x.url) || JUNK.test(x.alt) ? 3 : 0) - (/\.svg(\?|$)/i.test(x.url) ? 1 : 0);
  return [...seen.values()].map((x, i) => ({ ...x, i, s: score(x) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, 60);
}

/* ---------- the tools Claude is given ---------- */
export const TOOLS = [
  { name: "page_images", eager_input_streaming: true,
    description: "List the pictures on a web page: each picture's address with its alt text, panel-looking ones first. Use it on a product, tech-specs or gallery page to find a photo or drawing of the rear or front panel, then look at one with view_image. Pages built by JavaScript may list few or none.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "The page's http or https address" } }, required: ["url"], additionalProperties: false } },
  { name: "view_image", eager_input_streaming: true,
    description: "Look at one picture (PNG, JPEG, GIF or WebP, up to about 3.5 MB), such as a rear-panel photo or a connections drawing. Give its http or https address, as page_images, a page or a search result showed it.",
    input_schema: { type: "object", properties: { url: { type: "string", description: "The picture's http or https address" } }, required: ["url"], additionalProperties: false } },
];
const fail = text => ({ is_error: true, content: text });
// one client tool call -> the tool_result's {content, is_error?}. used = this check's calls so far, per tool.
export async function runTool(name, input, used) {
  const url = typeof input?.url === "string" ? input.url.trim() : "";
  if (!TOOLS.some(t => t.name === name)) return fail(`There is no tool called ${name}.`);
  if (!url || url.length > 2000) return fail("Give the address as {\"url\": \"https://...\"}.");
  used[name] = (used[name] || 0) + 1;
  if (used[name] > LIMITS[name]) return fail(`That is the limit of ${LIMITS[name]} ${name} calls for this check: finish with what you have.`);
  try {
    if (name === "page_images") {
      const r = await safeGet(url, { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" });
      const ct = String(r.headers["content-type"] || "");
      if (!/html|xml|text\/plain/i.test(ct) && sniff(r.body)) return fail("That address is a picture, not a page: look at it with view_image.");
      const html = r.body.toString("utf8"), title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() || "";
      const list = pageImages(html, r.url);
      if (!list.length) return { content: `No pictures found on ${r.url}${title ? ` ("${unent(title).slice(0, 100)}")` : ""}. If the page is built by JavaScript, try the maker's gallery or support page, or a search.` };
      return { content: [`Pictures on ${r.url}${title ? ` ("${unent(title).slice(0, 100)}")` : ""}, panel-looking ones first:`,
        ...list.map((x, k) => `${k + 1}. ${x.url}${x.alt ? ` (alt: ${x.alt})` : ""}${/\.svg(\?|$)/i.test(x.url) ? " [SVG: view_image can't show it]" : ""}`)].join("\n") };
    }
    const r = await safeGet(url, { accept: "image/avif;q=0.1,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5", max: IMAGE_MAX });
    const k = sniff(r.body);
    if (!k) return fail(`${r.url} is not a picture view_image can show (PNG, JPEG, GIF or WebP)${/html/i.test(String(r.headers["content-type"] || "")) ? ": it is a web page, so try page_images on it" : ""}.`);
    if (k.type === "svg") return fail(`${r.url} is an SVG drawing, which view_image can't show: look for a PNG or JPEG of it.`);
    if (k.w > 8000 || k.h > 8000) return fail(`${r.url} is ${k.w} × ${k.h} pixels, more than the 8000 a side a picture may have.`);
    return { content: [{ type: "text", text: `${r.url} · ${k.w} × ${k.h} ${k.type.slice(6).toUpperCase()}` },
      { type: "image", source: { type: "base64", media_type: k.type, data: r.body.toString("base64") } }] };
  } catch (e) {
    return fail(`Could not fetch ${url}: ${e.message}.`);
  }
}
