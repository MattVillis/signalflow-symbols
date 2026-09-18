// Shared by the validate and publish workflows (loaded via actions/github-script)
// and by the maintainer bridge's direct publish.
const SIGNALS = ["video", "audio", "network", "fiber", "control", "power"];
const SIDES = ["left", "right"], DIRS = ["in", "out", "bi"], KINDS = ["in", "out", "link", "any"];

// The app opens a pre-filled issue whose body carries the symbol in a ```json block.
function parseSubmission(body) {
  const m = /```json\s*([\s\S]*?)```/.exec(body || "");
  return JSON.parse((m ? m[1] : body || "").trim());
}

function validatePorts(list, where, errs, allowEmpty) {
  if (!Array.isArray(list) || (!list.length && !allowEmpty)) { errs.push(`${where}: \`ports\` must be a non-empty array`); return; }
  if (list.length > 64) errs.push(`${where}: too many ports (${list.length} > 64)`);
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
      if (!KINDS.includes(c?.kind)) errs.push(`card ${i + 1}: kind must be in|out|link|any`);
      validatePorts(c?.ports, `card ${i + 1}`, errs, false);
    });
    sym.slots.forEach((sl, i) => {
      if (!sl || typeof sl.label !== "string" || !sl.label.trim()) errs.push(`slot ${i + 1}: missing label`);
      if (!KINDS.includes(sl?.accepts)) errs.push(`slot ${i + 1}: accepts must be in|out|link|any`);
      if (sl?.card != null && !sym.cards.some(c => c.id === sl.card)) errs.push(`slot ${i + 1}: card \`${sl.card}\` is not in cards`);
    });
  }
  return errs;
}

// Library symbols are generic: show-specific VLAN/IP assignments are dropped.
const normPorts = list => (list || []).map((p, i) => ({
  id: typeof p.id === "string" && p.id ? p.id : `p${i}`,
  label: p.label.trim().toUpperCase().slice(0, 15),
  side: p.side, dir: p.dir, signal: p.signal,
  conn: typeof p.conn === "string" ? p.conn : "",
}));
function normalise(sym) {
  const modular = isModular(sym);
  return {
    id: sym.id.trim(),
    rev: Math.max(1, Number(sym.rev) || 1),
    name: sym.name.trim().toUpperCase().slice(0, 32),
    category: typeof sym.category === "string" ? sym.category : "Custom",
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

module.exports = { parseSubmission, validate, normalise, summary, upsert };
