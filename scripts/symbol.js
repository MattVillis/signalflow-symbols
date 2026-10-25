// Shared by the validate and publish workflows (loaded via actions/github-script)
// and by the maintainer bridge's direct publish.
const SIGNALS = ["video", "audio", "network", "fiber", "control", "power"];
const SIDES = ["left", "right"], DIRS = ["in", "out", "bi"], KINDS = ["in", "out", "link", "aux", "any"];

// The app opens a pre-filled issue whose body carries the symbol in a ```json block.
// A symbol too big for a link is pasted by hand, so the block may be empty with the JSON beside it:
// fall back to the outermost {...} in the body.
function parseSubmission(body) {
  const m = /```json\s*([\s\S]*?)```/.exec(body || "");
  if (m && m[1].trim()) return JSON.parse(m[1].trim());
  const t = String(body || ""), a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("no JSON found - paste the symbol between the ```json lines");
  return JSON.parse(t.slice(a, b + 1));
}

// caps match the app (sanitizePorts): 256 port entries on a chassis, 64 on a card
function validatePorts(list, where, errs, allowEmpty, max = 256) {
  if (!Array.isArray(list) || (!list.length && !allowEmpty)) { errs.push(`${where}: \`ports\` must be a non-empty array`); return; }
  if (list.length > max) errs.push(`${where}: too many ports (${list.length} > ${max})`);
  list.forEach((p, i) => {
    if (!p || typeof p.label !== "string" || !p.label.trim()) errs.push(`${where} port ${i + 1}: missing label`);
    if (!SIDES.includes(p?.side)) errs.push(`${where} port ${i + 1}: side must be left|right`);
    if (!DIRS.includes(p?.dir)) errs.push(`${where} port ${i + 1}: dir must be in|out|bi`);
    if (!SIGNALS.includes(p?.signal)) errs.push(`${where} port ${i + 1}: signal must be ${SIGNALS.join("|")}`);
  });
}
const isModular = sym => Array.isArray(sym.slots) && sym.slots.length > 0 && Array.isArray(sym.cards) && sym.cards.length > 0;

function validate(sym) {
  const errs = [];
  if (!sym || typeof sym !== "object" || Array.isArray(sym)) return ["submission is not a JSON object"];
  if (typeof sym.id !== "string" || !sym.id.trim()) errs.push("missing `id`");
  if (typeof sym.name !== "string" || !sym.name.trim()) errs.push("missing `name`");
  // a modular chassis (slots + a card catalogue) may have no fixed ports at all
  const modular = isModular(sym);
  validatePorts(sym.ports, "chassis", errs, modular);
  if (modular) {
    sym.cards.forEach((c, i) => {
      if (!c || typeof c.name !== "string" || !c.name.trim()) errs.push(`card ${i + 1}: missing name`);
      if (!KINDS.includes(c?.kind)) errs.push(`card ${i + 1}: kind must be in|out|link|aux|any`);
      validatePorts(c?.ports, `card ${i + 1}`, errs, false, 64);
    });
    sym.slots.forEach((sl, i) => {
      if (!sl || typeof sl.label !== "string" || !sl.label.trim()) errs.push(`slot ${i + 1}: missing label`);
      if (!KINDS.includes(sl?.accepts)) errs.push(`slot ${i + 1}: accepts must be in|out|link|aux|any`);
      if (sl?.card != null && !sym.cards.some(c => c.id === sl.card)) errs.push(`slot ${i + 1}: card \`${sl.card}\` is not in cards`);
    });
  }
  return errs;
}

// Library symbols are generic: show-specific VLAN/IP assignments are dropped.
const normPorts = list => (list || []).map((p, i) => ({
  id: typeof p.id === "string" && p.id ? p.id : `p${i}`,
  label: p.label.trim().toUpperCase().slice(0, 24),   // = the app's PORT_LABEL_MAX
  side: p.side, dir: p.dir, signal: p.signal,
  conn: typeof p.conn === "string" ? p.conn : "",
  ...(p.gap === true ? { gap: true } : {}),   // the half-row space above a port group
}));
// a category name as the app writes one (its cleanCatName): letters, digits, spaces and / & + -, 18 characters
const cleanCategory = v => String(v || "").replace(/[^A-Za-z0-9 /&+-]/g, "").replace(/\s+/g, " ").trim().slice(0, 18);
function normalise(sym) {
  const modular = isModular(sym);
  return {
    id: sym.id.trim(),
    rev: Math.max(1, Number(sym.rev) || 1),
    name: sym.name.trim().toUpperCase().slice(0, 36),
    category: cleanCategory(sym.category) || "Custom",
    width: Math.max(130, Math.min(280, Number(sym.width) || 170)),
    ports: normPorts(sym.ports),
    ...(modular ? {
      slots: sym.slots.map((sl, i) => ({ id: typeof sl.id === "string" && sl.id ? sl.id : `s${i + 1}`, label: sl.label.trim().toUpperCase().slice(0, 12), accepts: sl.accepts, card: sl.card || null })),
      cards: sym.cards.map((c, i) => ({ id: typeof c.id === "string" && c.id ? c.id : `c${i + 1}`, name: c.name.trim().toUpperCase().slice(0, 24), kind: c.kind, ports: normPorts(c.ports) })),
    } : {}),
  };
}

function summary(sym) {
  const rows = sym.ports.map(p => `| ${p.label} | ${p.side} | ${p.dir} | ${p.signal} | ${p.conn || ""} |`).join("\n");
  let out = `**${sym.name}** · ${sym.category} · ${sym.ports.length} ports · width ${sym.width} · id \`${sym.id}\` rev ${sym.rev}\n\n| Port | Side | Dir | Signal | Conn |\n|---|---|---|---|---|\n${rows}`;
  if (sym.slots) {
    out += `\n\n**Slots:** ${sym.slots.map(sl => `${sl.label} (${sl.accepts}) → ${sl.card ? (sym.cards.find(c => c.id === sl.card)?.name || sl.card) : "empty"}`).join(" · ")}`;
    out += `\n\n**Cards:**\n${sym.cards.map(c => `- ${c.name} [${c.kind}]: ${c.ports.map(p => p.label + (p.conn ? " " + p.conn : "")).join(", ")}`).join("\n")}`;
  }
  return out;
}

// Upsert by id: an existing id is replaced and its rev bumped past both copies,
// so every synced app sees it as an update; a new id is appended.
function upsert(library, sym) {
  const i = library.findIndex(d => d.id === sym.id);
  if (i < 0) { library.push(sym); return "added"; }
  library[i] = { ...sym, rev: Math.max(library[i].rev || 1, sym.rev || 1) + 1 };
  return "updated";
}

// A correction ("Suggest a fix" in the app) carries <!-- sf-fix {"target":"builtin"|"shared","id":"..."} -->.
// A built-in lives in the app's code, so it is never published to library.json; a shared fix is an update.
function fixTarget(body) {
  const m = /<!--\s*sf-fix\s+(\{[^]*?\})\s*-->/.exec(body || "");
  if (!m) return null;
  try { const t = JSON.parse(m[1]); return t && (t.target === "builtin" || t.target === "shared") ? { target: t.target, id: String(t.id || "") } : null; }
  catch { return null; }
}

/* ---------- categories ----------
   The app's own categories, copied from src/App.jsx CATEGORIES (2026-10-24; the symbol desk carries the same copy).
   Refresh all three together. */
const APP_CATEGORIES = ["Servers", "Computers", "Processing", "LED", "Extenders", "KVM", "Display", "Cameras", "Network", "Audio", "Control", "Lighting", "Power", "Custom"];
// every category the shared library knows: the app's, the catalog's extra ones, re-filed symbols' and shared symbols'
function knownCategories(file) {
  const cat = (file && file.catalog) || {};
  return [...APP_CATEGORIES, ...(cat.cats || []), ...Object.values(cat.defs || {}).map(d => d && d.category), ...((file && file.library) || []).map(d => d.category)]
    .filter(c => typeof c === "string" && c.trim());
}
const isNewCategory = (name, file) => !!cleanCategory(name) && !knownCategories(file).some(c => c.toLowerCase() === cleanCategory(name).toLowerCase());

/* A category suggestion ("Suggest a category" in the app): issue "[category] NAME", the marker below, and a json block
   {category, new, symbols: [{id, name, from, kind}]}. Approving it files those symbols under the category in
   library.json's catalog (catalog.defs[id].category), which every app applies on its next sync. That covers built-in
   symbols too: the catalog is how a shipped symbol is re-filed without a new app build. */
const CAT_MARK = "Category suggestion from SignalFlow";
const isCategoryIssue = (title, body) => /^\[category\]/i.test(title || "") || String(body || "").includes(CAT_MARK);
function parseCategory(body) {
  const m = /```json\s*([\s\S]*?)```/.exec(body || "");
  if (!m || !m[1].trim()) throw new Error("no ```json block with the suggestion in it");
  return JSON.parse(m[1].trim());
}
function validateCategory(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return ["the suggestion is not a JSON object"];
  const errs = [], name = typeof s.category === "string" ? s.category.replace(/\s+/g, " ").trim() : "";
  if (!/^[A-Za-z0-9 /&+-]{2,18}$/.test(name)) errs.push("`category` must be 2 to 18 letters, digits, spaces or / & + -");
  else if (/^custom$/i.test(name)) errs.push("`Custom` is where unfiled symbols go, so nothing can be filed there");
  if (!Array.isArray(s.symbols) || !s.symbols.length) errs.push("`symbols` must list at least one symbol");
  else {
    if (s.symbols.length > 100) errs.push(`too many symbols (${s.symbols.length} > 100)`);
    s.symbols.forEach((x, i) => { if (!x || typeof x.id !== "string" || !x.id.trim() || x.id.length > 64) errs.push(`symbol ${i + 1}: missing or bad \`id\``); });
  }
  return errs;
}
function normaliseCategory(s) {
  const seen = new Set();
  return {
    category: s.category.replace(/\s+/g, " ").trim(), new: !!s.new,
    symbols: s.symbols.filter(x => !seen.has(x.id.trim()) && seen.add(x.id.trim())).map(x => ({
      id: x.id.trim(), name: String(x.name || x.id).trim().toUpperCase().slice(0, 36), from: cleanCategory(x.from) || "Custom",
      kind: x.kind === "builtin" || x.kind === "shared" ? x.kind : "unknown" })),
  };
}
function categorySummary(s) {
  const rows = s.symbols.map(x => `| ${x.name} | ${x.from} | ${x.kind === "builtin" ? "built-in" : x.kind} | \`${x.id}\` |`).join("\n");
  return `**${s.category}** · ${s.new ? "new category" : "existing category"} · ${s.symbols.length} symbol${s.symbols.length === 1 ? "" : "s"}\n\n| Symbol | Now in | Kind | id |\n|---|---|---|---|\n${rows}`;
}
// file the symbols under the category in file.catalog (mutates file); an existing spelling of the name wins, so
// "lighting control" files with "Lighting Control". Caps = the app's cleanCat: 64 extra categories, 2000 re-filed symbols.
function applyCategory(file, s) {
  const cat = file.catalog && typeof file.catalog === "object" ? file.catalog : {};
  const cats = Array.isArray(cat.cats) ? [...cat.cats] : [];
  const defs = cat.defs && typeof cat.defs === "object" ? { ...cat.defs } : {};
  const name = knownCategories(file).find(c => c.toLowerCase() === s.category.toLowerCase()) || s.category;
  if (!APP_CATEGORIES.some(c => c.toLowerCase() === name.toLowerCase()) && !cats.some(c => c.toLowerCase() === name.toLowerCase())) {
    if (cats.length >= 64) throw new Error("the catalog already has 64 extra categories");
    cats.push(name);
  }
  let moved = 0;
  s.symbols.forEach(x => {
    const cur = defs[x.id] || {};
    if (cur.category !== name) { defs[x.id] = { ...cur, category: name }; moved++; }
  });
  if (Object.keys(defs).length > 2000) throw new Error("the catalog is full (2000 re-filed symbols)");
  // other catalog keys (catClass, written by a catalog edit) are kept: this used to rebuild the catalog as {cats, defs}
  file.catalog = { ...cat, cats, defs };
  return { name, moved };
}

/* ---------- catalog edits from the symbol desk (app 1.34.0) ----------
   Every symbol has a CLASS (video, audio, lighting, network, control, power: the department) and a CATEGORY (the finer
   filing). The app works a class out by itself: set on the symbol, else the class its category is allotted to, else its
   ports. The maintainer's symbol desk overrides that for ANY symbol, built-ins too, through library.json's catalog:
     catalog.defs[id].class      a symbol's class          catalog.defs[id].category   where it is filed
     catalog.catClass[key]       the class a category is allotted to (key = the category in lower case)
   The desk opens a "[catalog] ..." issue carrying the marker below and a json block, then adds the approved label
   itself; catalog.yml applies it (only someone who can label issues can do that). The block is
     {"symbols": [{"id", "name"?, "class"?, "category"?}], "categories": [{"name", "class"?}]}
   where a class or category given as null CLEARS that setting (back to what the app works out) and a key left out
   changes nothing. A category nobody has yet is created. Custom is the catch-all: never allotted, nothing filed in it. */
const CLASSES = ["video", "audio", "lighting", "network", "control", "power"];
const CATALOG_MARK = "Catalog edit from the SignalFlow symbol desk";
const isCatalogIssue = (title, body) => /^\[catalog\]/i.test(title || "") || String(body || "").includes(CATALOG_MARK);
const catKeyOf = name => (cleanCategory(name) || "Custom").toLowerCase();
function parseCatalogEdit(body) {
  const m = /```json\s*([\s\S]*?)```/.exec(body || "");
  if (!m || !m[1].trim()) throw new Error("no ```json block with the edit in it");
  return JSON.parse(m[1].trim());
}
function validateCatalogEdit(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return ["the edit is not a JSON object"];
  const errs = [], syms = e.symbols == null ? [] : e.symbols, cats = e.categories == null ? [] : e.categories;
  const okName = v => typeof v === "string" && /^[A-Za-z0-9 /&+-]{2,18}$/.test(v.replace(/\s+/g, " ").trim()) && !/^custom$/i.test(v.trim());
  const okClass = v => v === null || CLASSES.includes(v);
  if (!Array.isArray(syms)) errs.push("`symbols` must be a list");
  if (!Array.isArray(cats)) errs.push("`categories` must be a list");
  if (errs.length) return errs;
  if (!syms.length && !cats.length) errs.push("the edit changes nothing: no symbols and no categories");
  if (syms.length > 500) errs.push(`too many symbols in one edit (${syms.length} > 500)`);
  if (cats.length > 64) errs.push(`too many categories in one edit (${cats.length} > 64)`);
  syms.forEach((s, i) => {
    if (!s || typeof s.id !== "string" || !s.id.trim() || s.id.length > 64) { errs.push(`symbol ${i + 1}: missing or bad \`id\``); return; }
    if (!("class" in s) && !("category" in s)) errs.push(`symbol ${s.id}: sets neither a class nor a category`);
    if ("class" in s && !okClass(s.class)) errs.push(`symbol ${s.id}: class must be one of ${CLASSES.join(", ")}, or null to clear it`);
    if ("category" in s && s.category !== null && !okName(s.category)) errs.push(`symbol ${s.id}: category must be 2 to 18 letters, digits, spaces or / & + - (and not Custom), or null to clear it`);
  });
  cats.forEach((c, i) => {
    if (!c || !okName(c.name)) { errs.push(`category ${i + 1}: name must be 2 to 18 letters, digits, spaces or / & + - (and not Custom)`); return; }
    if ("class" in c && !okClass(c.class)) errs.push(`category ${c.name}: class must be one of ${CLASSES.join(", ")}, or null to clear it`);
  });
  return errs;
}
function normaliseCatalogEdit(e) {
  const syms = new Map(), cats = new Map();
  (e.symbols || []).forEach(s => {
    const o = { id: s.id.trim(), name: String(s.name || s.id).trim().toUpperCase().slice(0, 36) };
    if ("class" in s) o.class = s.class;
    if ("category" in s) o.category = s.category === null ? null : s.category.replace(/\s+/g, " ").trim();
    syms.set(o.id, o);   // a symbol listed twice: the last one wins
  });
  (e.categories || []).forEach(c => { const name = c.name.replace(/\s+/g, " ").trim(); cats.set(name.toLowerCase(), { name, ...("class" in c ? { class: c.class } : {}) }); });
  return { symbols: [...syms.values()], categories: [...cats.values()] };
}
const shown = v => v === null ? "*automatic*" : v === undefined ? "—" : String(v);
function catalogEditSummary(e) {
  const out = [];
  if (e.categories.length) out.push(`**Categories**\n\n| Category | Class |\n|---|---|\n${e.categories.map(c => `| ${c.name} | ${"class" in c ? shown(c.class) : "—"} |`).join("\n")}`);
  if (e.symbols.length) out.push(`**Symbols**\n\n| Symbol | Class | Category | id |\n|---|---|---|---|\n${e.symbols.map(s => `| ${s.name} | ${"class" in s ? shown(s.class) : "—"} | ${"category" in s ? shown(s.category) : "—"} | \`${s.id}\` |`).join("\n")}`);
  return out.join("\n\n");
}
// apply a normalised edit to file.catalog (mutates file); returns how many settings actually changed
function applyCatalogEdit(file, e) {
  const cat = file.catalog && typeof file.catalog === "object" ? file.catalog : {};
  const cats = Array.isArray(cat.cats) ? [...cat.cats] : [];
  const defs = cat.defs && typeof cat.defs === "object" ? { ...cat.defs } : {};
  const catClass = cat.catClass && typeof cat.catClass === "object" ? { ...cat.catClass } : {};
  // an existing spelling wins ("amplifiers" files with "Amplifiers"); a new category is created
  const spell = name => knownCategories(file).concat(cats).find(c => c.toLowerCase() === name.toLowerCase()) || name;
  const ensure = name => {
    if (APP_CATEGORIES.some(c => c.toLowerCase() === name.toLowerCase()) || cats.some(c => c.toLowerCase() === name.toLowerCase())) return false;
    if (cats.length >= 64) throw new Error("the catalog already has 64 extra categories");
    cats.push(name); return true;
  };
  let changed = 0;
  e.categories.forEach(c => {
    const name = spell(c.name), key = catKeyOf(name);
    if (ensure(name)) changed++;
    if (!("class" in c)) return;
    if (c.class && catClass[key] !== c.class) { catClass[key] = c.class; changed++; }
    else if (!c.class && catClass[key]) { delete catClass[key]; changed++; }
  });
  e.symbols.forEach(s => {
    const cur = { ...(defs[s.id] || {}) }; let ch = false;
    if ("class" in s) {
      if (s.class && cur.class !== s.class) { cur.class = s.class; ch = true; }
      else if (!s.class && cur.class) { delete cur.class; ch = true; }
    }
    if ("category" in s) {
      if (s.category) { const name = spell(s.category); ensure(name); if (cur.category !== name) { cur.category = name; ch = true; } }
      else if (cur.category) { delete cur.category; ch = true; }
    }
    if (!ch) return;
    changed++;
    if (Object.keys(cur).length) defs[s.id] = cur; else delete defs[s.id];
  });
  if (Object.keys(defs).length > 2000) throw new Error("the catalog is full (2000 symbols with settings)");
  if (Object.keys(catClass).length > 128) throw new Error("too many allotted categories (128)");
  const next = { ...cat, cats, defs };
  if (Object.keys(catClass).length) next.catClass = catClass; else delete next.catClass;
  file.catalog = next;
  return { changed };
}

module.exports = { parseSubmission, validate, normalise, summary, upsert, fixTarget,
  APP_CATEGORIES, knownCategories, isNewCategory, cleanCategory,
  CAT_MARK, isCategoryIssue, parseCategory, validateCategory, normaliseCategory, categorySummary, applyCategory,
  CLASSES, CATALOG_MARK, isCatalogIssue, parseCatalogEdit, validateCatalogEdit, normaliseCatalogEdit, catalogEditSummary, applyCatalogEdit };
