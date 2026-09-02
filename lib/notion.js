// Client minimal de l'API Notion + lecture typée des propriétés.
const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

function entetes() {
  const token = process.env.NOTION_TOKEN;
  if (!token) throw new Error("NOTION_TOKEN non configuré.");
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": VERSION,
    "Content-Type": "application/json",
  };
}

async function appel(chemin, options = {}) {
  const resp = await fetch(`${API}${chemin}`, {
    ...options,
    headers: { ...entetes(), ...(options.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const texte = await resp.text();
  let json;
  try { json = texte ? JSON.parse(texte) : {}; } catch { json = { brut: texte }; }
  if (!resp.ok) {
    throw new Error(`Notion ${chemin} → ${resp.status} ${json.message || texte.slice(0, 200)}`);
  }
  return json;
}

export const getPage = (id) => appel(`/pages/${id}`);
export const getDatabase = (id) => appel(`/databases/${id}`);

export const queryDatabase = (id, corps = {}) =>
  appel(`/databases/${id}/query`, { method: "POST", body: JSON.stringify(corps) });

export const createPage = (corps) =>
  appel("/pages", { method: "POST", body: JSON.stringify(corps) });

export const updatePage = (id, properties) =>
  appel(`/pages/${id}`, { method: "PATCH", body: JSON.stringify({ properties }) });

// --- Lecture des propriétés -------------------------------------------------

// Renvoie une valeur JS simple pour une propriété Notion, quel que soit son type.
export function valeur(prop) {
  if (!prop) return null;
  const t = prop.type;
  switch (t) {
    case "title": return prop.title.map((x) => x.plain_text).join("");
    case "rich_text": return prop.rich_text.map((x) => x.plain_text).join("");
    case "number": return prop.number;
    case "select": return prop.select?.name ?? null;
    case "status": return prop.status?.name ?? null;
    case "multi_select": return prop.multi_select.map((o) => o.name);
    case "date": return prop.date?.start ?? null;
    case "checkbox": return prop.checkbox;
    case "email": return prop.email;
    case "url": return prop.url;
    case "phone_number": return prop.phone_number;
    case "relation": return prop.relation.map((r) => r.id);
    case "created_time": return prop.created_time;
    case "formula": return prop.formula?.[prop.formula.type] ?? null;
    case "rollup": {
      const r = prop.rollup;
      if (r.type === "array") return r.array.map((a) => valeur(a));
      return r?.[r.type] ?? null;
    }
    default: return null;
  }
}

// Raccourci : lit une propriété d'une page par son nom (tolérant aux espaces).
export function prop(page, nom) {
  const props = page?.properties || {};
  if (props[nom] !== undefined) return valeur(props[nom]);
  const cible = nom.trim().toLowerCase();
  for (const [k, v] of Object.entries(props)) {
    if (k.trim().toLowerCase() === cible) return valeur(v);
  }
  return null;
}

// --- Écriture : fabriques de valeurs ---------------------------------------

export const txt = (s) => ({ rich_text: [{ type: "text", text: { content: String(s ?? "").slice(0, 2000) } }] });
export const titre = (s) => ({ title: [{ type: "text", text: { content: String(s ?? "").slice(0, 2000) } }] });
export const nombre = (n) => ({ number: n == null ? null : Number(n) });
export const choix = (s) => ({ select: s ? { name: s } : null });
export const date = (iso) => ({ date: iso ? { start: iso } : null });
export const coche = (b) => ({ checkbox: Boolean(b) });
export const lien = (u) => ({ url: u || null });
export const relation = (ids) => ({ relation: (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map((id) => ({ id })) });

// --- Extraction défensive d'un ID de page depuis un payload de webhook ------
// Le format exact des webhooks d'automatisation Notion n'est pas documenté :
// on cherche donc le premier identifiant de page plausible, où qu'il soit.
const RE_UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export function trouverPageId(payload) {
  const vus = new Set();
  const pile = [payload];
  const candidats = [];
  while (pile.length) {
    const o = pile.pop();
    if (!o || typeof o !== "object" || vus.has(o)) continue;
    vus.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && RE_UUID.test(v)) {
        const cle = k.toLowerCase();
        // On privilégie les clés qui désignent explicitement une page.
        const score = cle === "id" ? 2 : /page/.test(cle) ? 3 : 0;
        if (score) candidats.push({ score, id: v, objet: o.object });
      } else if (v && typeof v === "object") {
        pile.push(v);
      }
    }
  }
  // Priorité : clé « page… », puis objet de type page, puis premier « id ».
  candidats.sort((a, b) =>
    (b.objet === "page" ? 1 : 0) - (a.objet === "page" ? 1 : 0) || b.score - a.score
  );
  return candidats[0]?.id || null;
}
