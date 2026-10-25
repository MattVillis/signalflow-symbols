// Used by the catalog workflow: apply a symbol-desk catalog edit (classes, categories, category classes) to
// library.json's catalog and print how many settings changed. It runs inside a fetch / reset / push retry loop, so it
// always starts from the latest library.json: a symbol or category published at the same moment must not be dropped.
const fs = require("fs");
const lib = require("./symbol.js");
const edit = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const file = JSON.parse(fs.readFileSync("library.json", "utf8"));
const r = lib.applyCatalogEdit(file, edit);
if (r.changed) {
  file.updated = new Date().toISOString();
  fs.writeFileSync("library.json", JSON.stringify(file, null, 2) + "\n");
}
process.stdout.write(String(r.changed));
