// Shared by the validate and publish workflows (loaded via actions/github-script).
const SIGNALS = ["video", "audio", "network", "fiber", "control", "power"];
const SIDES = ["left", "right"], DIRS = ["in", "out", "bi"];

// The app opens a pre-filled issue whose body carries the symbol in a ```json block.
function parseSubmission(body) {
  const m = /```json\s*([\s\S]*?)```/.exec(body || "");
  return JSON.parse((m ? m[1] : body || "").trim());
}

function validate(sym) {
  const errs = [];
  if (!sym || typeof sym !== "object" || Array.isArray(sym)) return ["submission is not a JSON object"];
  if (typeof sym.id !== "string" || !sym.id.trim()) errs.push("missing `id`");
  if (typeof sym.name !== "string" || !sym.name.trim()) errs.push("missing `name`");
  if (!Array.isArray(sym.ports) || !sym.ports.length) errs.push("`ports` must be a non-empty array");
  else if (sym.ports.length > 64) errs.push(`too many ports (${sym.ports.length} > 64)`);
  else sym.ports.forEach((p, i) => {
    if (!p || typeof p.label !== "string" || !p.label.trim()) errs.push(`port ${i + 1}: missing label`);
    if (!SIDES.includes(p?.side)) errs.push(`port ${i + 1}: side must be left|right`);
    if (!DIRS.includes(p?.dir)) errs.push(`port ${i + 1}: dir must be in|out|bi`);
    if (!SIGNALS.includes(p?.signal)) errs.push(`port ${i + 1}: signal must be ${SIGNALS.join("|")}`);
  });
  return errs;
}

// Library symbols are generic: show-specific VLAN/IP assignments are dropped.
function normalise(sym) {
  return {
    id: sym.id.trim(),
    rev: Math.max(1, Number(sym.rev) || 1),
    name: sym.name.trim().toUpperCase().slice(0, 32),
    category: typeof sym.category === "string" ? sym.category : "Custom",
    width: Math.max(130, Math.min(280, Number(sym.width) || 170)),
    ports: sym.ports.map((p, i) => ({
      id: typeof p.id === "string" && p.id ? p.id : `p${i}`,
      label: p.label.trim().toUpperCase().slice(0, 15),
      side: p.side, dir: p.dir, signal: p.signal,
      conn: typeof p.conn === "string" ? p.conn : "",
    })),
  };
}

function summary(sym) {
  const rows = sym.ports.map(p => `| ${p.label} | ${p.side} | ${p.dir} | ${p.signal} | ${p.conn || ""} |`).join("\n");
  return `**${sym.name}** · ${sym.category} · ${sym.ports.length} ports · width ${sym.width} · id \`${sym.id}\` rev ${sym.rev}\n\n| Port | Side | Dir | Signal | Conn |\n|---|---|---|---|---|\n${rows}`;
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
