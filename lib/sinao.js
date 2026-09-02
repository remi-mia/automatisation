// Client Sinao (facturation). Authentification par header `Api-Key`.
// Une clé API Sinao n'est liée qu'à UNE application : une paire app/clé par entité.
const BASE = "https://api.sinao.app/v1";

// Résout l'application Sinao à utiliser selon l'entité Notion (Moneverest / Prestalp).
export function appPourEntite(entite) {
  const e = String(entite || "").trim().toLowerCase();
  const table = {
    moneverest: { id: process.env.SINAO_APP_MONEVEREST, key: process.env.SINAO_KEY_MONEVEREST },
    prestalp: { id: process.env.SINAO_APP_PRESTALP, key: process.env.SINAO_KEY_PRESTALP },
  };
  const conf = table[e];
  if (!conf) throw new Error(`Entité inconnue : « ${entite} » (attendu : Moneverest ou Prestalp).`);
  if (!conf.id || !conf.key) {
    throw new Error(
      `Sinao non configuré pour l'entité « ${entite} ». ` +
      `Renseigner SINAO_APP_${e.toUpperCase()} et SINAO_KEY_${e.toUpperCase()}.`
    );
  }
  return { appId: conf.id, key: conf.key, entite: e };
}

async function appel(app, chemin, options = {}) {
  const resp = await fetch(`${BASE}/apps/${app.appId}${chemin}`, {
    ...options,
    headers: {
      "Api-Key": app.key,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const texte = await resp.text();
  let json;
  try { json = texte ? JSON.parse(texte) : {}; } catch { json = { brut: texte }; }
  if (!resp.ok) {
    throw new Error(`Sinao ${chemin} → ${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// --- Conversions d'unités ---------------------------------------------------
// Sinao stocke les montants en « centimes × 1000 » : 5 000 € → 500 000 000.
export const montantSinao = (euros) => Math.round(Number(euros || 0) * 100 * 1000);
// et les taux de TVA en pourcentage × 100 : 20 % → 2000.
export const tvaSinao = (pourcent) => Math.round(Number(pourcent || 0) * 100);

function normaliser(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Cherche une organisation existante par nom (évite de créer des doublons).
export async function trouverOrganisation(app, nom) {
  if (!nom) return null;
  const cible = normaliser(nom);
  const liste = await appel(app, `/organizations?per_page=200`);
  const rows = Array.isArray(liste) ? liste : liste.data || [];
  return rows.find((o) => normaliser(o.name) === cible || normaliser(o.billing_name) === cible) || null;
}

// Crée une facture en BROUILLON.
//   client : { id? , nom, adresse, adresse2, localisation }
//   lignes : [{ detail, quantite, montantHT, tvaPourcent }]
export async function creerFactureBrouillon(app, { client, lignes, dateISO, notes }) {
  const contact_infos = client.id
    ? { id: client.id, type: "organization" }
    : {
        new: true,
        type: "organization",
        name: client.nom,
        address: client.adresse || null,
        address2: client.adresse2 || null,
        location: client.localisation || null,
      };

  const accountId = Number(process.env.SINAO_SALES_ACCOUNT_ID || 55); // 706 Prestations de services

  const corps = {
    status: "draft",
    contact_infos,
    content: [
      {
        lines: lignes.map((l) => ({
          detail: l.detail,
          quantity: l.quantite ?? 1,
          amount_accurately: montantSinao(l.montantHT),
          vat_percent: tvaSinao(l.tvaPourcent ?? 20),
          type: "product",
          account_id: accountId,
        })),
      },
    ],
  };
  if (dateISO) corps.written_at = dateISO;
  if (notes) corps.notes = notes;

  return appel(app, "/invoices?expand[]=content", {
    method: "POST",
    body: JSON.stringify(corps),
  });
}

export const getFacture = (app, id) => appel(app, `/invoices/${id}?expand[]=content`);
export const supprimerFacture = (app, id) => appel(app, `/invoices/${id}`, { method: "DELETE" });

// URL de la facture dans l'interface Sinao.
export const urlFacture = (app, id) => `https://${app.entite}.sinao.app/invoices/${id}`;
