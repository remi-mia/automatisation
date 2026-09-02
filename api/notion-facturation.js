// Webhook appelé par les boutons / automatisations Notion.
//
//   POST /api/notion-facturation?action=preparer   ← bouton sur la base Contrat
//   POST /api/notion-facturation?action=envoyer    ← bouton sur la base Factures
//
// Authentification : header personnalisé `x-webhook-secret` (configurable dans
// l'action webhook Notion) ou `?token=` dans l'URL.
//
// Le format exact du payload des automatisations Notion n'est pas documenté :
// on extrait donc simplement l'ID de page, puis on relit tout via l'API Notion.
// `?debug=1` renvoie le payload reçu sans rien exécuter (utile au 1er branchement).
import { trouverPageId } from "../lib/notion.js";
import { genererEcheancier, envoyerVersSinao } from "../lib/facturation.js";
import { logExecution } from "../lib/db.js";

const AUTOMATION_ID = "notion-sinao";

function autorise(req) {
  const attendu = process.env.NOTION_WEBHOOK_SECRET;
  if (!attendu) return false;
  const header = req.headers["x-webhook-secret"] || req.headers["x-notion-secret"];
  return header === attendu || req.query?.token === attendu;
}

async function lireCorps(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch { return { brut: req.body }; }
  }
  const morceaux = [];
  for await (const m of req) morceaux.push(typeof m === "string" ? Buffer.from(m) : m);
  const brut = Buffer.concat(morceaux).toString("utf8");
  if (!brut) return {};
  try { return JSON.parse(brut); } catch { return { brut }; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Utiliser POST." });
  }
  if (!autorise(req)) return res.status(401).json({ error: "Non autorisé" });

  const t0 = Date.now();
  const action = req.query?.action;
  const payload = await lireCorps(req);

  // Mode diagnostic : renvoie ce que Notion a réellement envoyé.
  if (req.query?.debug) {
    return res.status(200).json({
      ok: true,
      debug: true,
      action,
      page_id_detecte: trouverPageId(payload),
      payload,
    });
  }

  try {
    const pageId = trouverPageId(payload);
    if (!pageId) {
      throw new Error(
        "Aucun ID de page trouvé dans le payload Notion. " +
        "Rejouer l'appel avec ?debug=1 pour inspecter le contenu reçu."
      );
    }

    let resultat;
    if (action === "preparer") {
      resultat = await genererEcheancier(pageId);
    } else if (action === "envoyer") {
      resultat = await envoyerVersSinao(pageId);
    } else {
      throw new Error(`Action inconnue : « ${action} » (attendu : preparer ou envoyer).`);
    }

    const duree = Date.now() - t0;
    await logExecution({
      automationId: AUTOMATION_ID,
      status: "success",
      durationMs: duree,
      meta: { action, page_id: pageId, ...resultat },
    });
    return res.status(200).json({ ok: true, action, page_id: pageId, ...resultat });
  } catch (err) {
    const duree = Date.now() - t0;
    console.error("[notion-facturation]", err);
    await logExecution({
      automationId: AUTOMATION_ID, status: "error",
      error: String(err?.message || err), durationMs: duree, meta: { action },
    });
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
