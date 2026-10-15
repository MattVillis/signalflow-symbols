// Used by the publish workflow: merge one validated, normalised symbol (a JSON file) into library.json
// and print what happened ("added" | "updated"). It runs inside a fetch / merge / push retry loop, so it
// always starts from the latest library.json — two approvals at once must not drop each other's symbol.
const fs = require("fs");
const lib = require("./symbol.js");
const sym = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const file = JSON.parse(fs.readFileSync("library.json", "utf8"));
file.library = file.library || [];
const what = lib.upsert(file.library, sym);
file.updated = new Date().toISOString();
fs.writeFileSync("library.json", JSON.stringify(file, null, 2) + "\n");
process.stdout.write(what);
