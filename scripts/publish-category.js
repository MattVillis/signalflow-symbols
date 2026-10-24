// Used by the category workflow: file an approved suggestion's symbols under its category in library.json's catalog
// and print "<n moved> <category>". It runs inside a fetch / reset / push retry loop, so it always starts from the
// latest library.json: a symbol published at the same moment must not be dropped, and neither must this.
const fs = require("fs");
const lib = require("./symbol.js");
const sug = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const file = JSON.parse(fs.readFileSync("library.json", "utf8"));
const r = lib.applyCategory(file, sug);
if (r.moved) {
  file.updated = new Date().toISOString();
  fs.writeFileSync("library.json", JSON.stringify(file, null, 2) + "\n");
}
process.stdout.write(`${r.moved} ${r.name}`);
