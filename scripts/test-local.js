// Test local : prend un payload Tally d'exemple, génère le docx dans scripts/out/
// et affiche les données mappées. N'envoie PAS d'email.
//
//   node scripts/test-local.js [chemin/vers/payload.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapTallyToTemplateData } from "../lib/tally.js";
import { renderBrief, briefFilename } from "../lib/docx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const payloadPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "sample-payload.json");

const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));
const data = mapTallyToTemplateData(payload);

console.log("Données mappées :");
console.log(JSON.stringify(data, null, 2));

const buffer = renderBrief(data);
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, briefFilename(data));
fs.writeFileSync(outFile, buffer);

console.log(`\nDocx généré : ${outFile} (${buffer.length} octets)`);
