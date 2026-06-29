// Parsing d'un payload de webhook Tally + mapping vers les variables du template docx.
//
// Format Tally (FORM_RESPONSE) :
// {
//   eventId, eventType: "FORM_RESPONSE", createdAt,
//   data: {
//     responseId, submissionId, respondentId, formId, formName, createdAt,
//     fields: [ { key, label, type, value, options? }, ... ]
//   }
// }
//
// Selon le type de champ, `value` est :
//  - texte / nombre / date / email : la valeur brute
//  - MULTIPLE_CHOICE / DROPDOWN : l'id (ou tableau d'ids) d'option -> à résoudre via `options`
//  - CHECKBOXES : tableau d'ids -> à résoudre via `options`

// --- Normalisation des libellés pour un matching tolérant (accents, casse, espaces) ---
export function norm(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // retire les accents
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Résout la valeur lisible d'un champ Tally, quel que soit son type.
function fieldText(field) {
  const { type, value, options } = field;
  if (value == null || value === "") return "";

  const resolveOption = (id) => {
    if (!Array.isArray(options)) return id;
    const opt = options.find((o) => o.id === id);
    return opt ? opt.text : id;
  };

  // Choix / listes : value = id ou tableau d'ids
  if (Array.isArray(value)) {
    return value.map(resolveOption).filter(Boolean).join(", ");
  }
  if (
    type === "MULTIPLE_CHOICE" ||
    type === "DROPDOWN" ||
    type === "CHECKBOXES" ||
    type === "MULTI_SELECT"
  ) {
    return resolveOption(value);
  }

  // Dates Tally : "YYYY-MM-DD" -> "JJ/MM/AAAA"
  if (type === "INPUT_DATE" && /^\d{4}-\d{2}-\d{2}/.test(String(value))) {
    const [y, m, d] = String(value).slice(0, 10).split("-");
    return `${d}/${m}/${y}`;
  }

  return String(value);
}

// Construit un index { libellé normalisé -> texte } à partir des fields Tally.
export function indexFields(fields = []) {
  const byLabel = new Map();
  for (const f of fields) {
    byLabel.set(norm(f.label), fieldText(f));
  }
  return byLabel;
}

// Récupère la 1re valeur non vide parmi une liste de libellés candidats.
function pick(idx, ...labels) {
  for (const l of labels) {
    const v = idx.get(norm(l));
    if (v != null && v !== "") return v;
  }
  return "";
}

function num(v) {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// mm -> pouces (1 décimale)
function mm2in(v) {
  const n = num(v);
  return n == null ? null : Math.round((n / 25.4) * 10) / 10;
}

// --- Compositions métier (cf. docs_mapping.md) ---

// {{dimensions}} : concatène les cotes selon le type de produit.
function composeDimensions(idx, typeProduit, unit /* "mm" | "in" */) {
  const conv = unit === "in" ? mm2in : (x) => num(x);
  const fmt = (label, sym) => {
    const v = conv(pick(idx, label));
    return v == null ? null : `${sym} ${v}`;
  };
  const L = fmt("Longueur", "L");
  const l = fmt("Largeur", "l");
  const D = fmt("Diamètre", "Ø");
  const Hht = fmt("Hauteur hors tout", "H");
  const H = fmt("Hauteur", "H");
  const suffix = unit === "in" ? " in" : " mm";

  const isLampadaire = norm(typeProduit).includes("lampadaire");
  const parts = isLampadaire
    ? [L, l, D, Hht ?? H]
    : [L, l, H];
  const kept = parts.filter(Boolean);
  return kept.length ? kept.join(" × ") + suffix : "";
}

// {{finition}} : "Finition standard" si Type de finition = Standard, sinon
// "Finition sur mesure" + précision éventuelle.
function composeFinition(idx) {
  const type = pick(idx, "Type de finition");
  const precision = pick(idx, "Préciser la finition", "Finition sur mesure");
  if (!type && !precision) return "";
  if (norm(type).includes("standard")) return "Finition standard";
  const base = "Finition sur mesure";
  return precision ? `${base} — ${precision}` : base;
}

// Combine un choix + une éventuelle valeur "sur mesure".
function withCustom(idx, choiceLabel, customLabel) {
  const choice = pick(idx, choiceLabel);
  if (!norm(choice).includes("mesure")) return choice;
  const custom = pick(idx, customLabel);
  return custom ? `${choice} (${custom})` : choice;
}

// Construit l'objet de données passé à Docxtemplater à partir du payload Tally.
// Les variables sans source Tally ({{adv}}, {{temperature}}) restent vides.
export function mapTallyToTemplateData(payload) {
  const fields = payload?.data?.fields ?? [];
  const idx = indexFields(fields);

  const typeProduit = pick(idx, "Quel type de produit ?", "Type de produit");

  const data = {
    // Page 1 — Infos générales
    pays_installation: pick(idx, "Pays d'installation"),
    reference_projet: pick(idx, "Référence du projet", "Référence projet"),
    date_commande: pick(idx, "Date de la commande", "Date de commande"),
    date_livraison: pick(idx, "Date de livraison souhaitée", "Date de livraison"),
    reference_produit: pick(idx, "Référence produit"),
    nom_produit: pick(idx, "Nom du produit"),
    quantite: pick(idx, "Quantité de pièces", "Quantité"),
    numeros_serie: pick(idx, "Numéro(s) de série", "Numéros de série", "Numéro de série"),

    // Page 2 — Type
    type_produit: typeProduit,

    // Finition (dimensions composées plus bas)
    finition: composeFinition(idx),

    // Branche Lampe
    matiere_fil: pick(idx, "Matière du fil"),
    position_commande: withCustom(idx, "Position du dispositif de commande", "Distance sur mesure"),
    longueur_fil: withCustom(idx, "Longueur de fil", "Longueur sur mesure"),
    couleur_fil: pick(idx, "Couleur du fil de soie tressée", "Couleur du fil"),
    couleur_switch: pick(idx, "Couleur du switch / variateur", "Couleur du switch"),
    couleur_fiche: pick(idx, "Couleur de la fiche"),
    certification: pick(idx, "Certification"),

    // Page 7 — Exposition & Montage
    exposition_humidite: pick(idx, "Exposition à l'humidité"),
    exposition_marin: pick(idx, "Exposition à un environnement marin"),
    vernis_marin: pick(idx, "Vernis marin requis ?", "Vernis marin"),
    montage_bateau: withCustom(idx, "Montage bateau ?", "Épaisseur du support"),
    longueur_tige_filetee: pick(idx, "Longueur tige filetée"),

    // Dimensions composées
    dimensions: composeDimensions(idx, typeProduit, "mm"),
    dimensions_pouces: composeDimensions(idx, typeProduit, "in"),

    // Sans source Tally — laissés vides (cf. décision projet)
    adv: "",
    temperature: "",
  };

  return data;
}
