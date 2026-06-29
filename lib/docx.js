// Génération d'un .docx à partir du template Word et d'un objet de données.
// Le template utilise des balises {{variable}} (double accolade).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATE_PATH = path.join(
  __dirname,
  "..",
  "templates",
  "BRIEF_Charles_Paris_template.docx"
);

// Génère le buffer du docx rempli. `data` : objet { variable -> valeur }.
export function renderBrief(data) {
  const content = fs.readFileSync(TEMPLATE_PATH, "binary");
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    delimiters: { start: "{{", end: "}}" },
    paragraphLoop: true,
    linebreaks: true,
    // Toute variable absente/nulle est remplacée par une chaîne vide.
    nullGetter: () => "",
  });

  doc.render(data);

  return doc.getZip().generate({
    type: "nodebuffer",
    compression: "DEFLATE",
  });
}

// Nom de fichier propre pour le brief (sans caractères problématiques).
export function briefFilename(data) {
  const ref = String(data.reference_projet || data.nom_produit || "brief")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "brief";
  return `Brief_${ref}.docx`;
}
