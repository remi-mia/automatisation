// Endpoint webhook Tally -> génère le brief docx -> l'envoie par email.
// Méthode : POST. Déployé sur Vercel comme fonction serverless.
import crypto from "node:crypto";
import { mapTallyToTemplateData } from "../lib/tally.js";
import { renderBrief, briefFilename } from "../lib/docx.js";
import { sendBriefEmail } from "../lib/mailer.js";

// Lit le corps brut de la requête (nécessaire pour vérifier la signature).
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Vérifie la signature Tally (header `tally-signature`) si un secret est configuré.
function verifySignature(rawBody, signature) {
  const secret = process.env.TALLY_SIGNING_SECRET;
  if (!secret) return true; // pas de secret => vérification désactivée
  if (!signature) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("base64");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    // Récupère le corps brut, avec repli sur le corps déjà parsé par Vercel.
    const raw = await readRawBody(req);
    let payload;
    if (raw && raw.length > 0) {
      if (!verifySignature(raw, req.headers["tally-signature"])) {
        return res.status(401).json({ error: "Signature invalide" });
      }
      payload = JSON.parse(raw.toString("utf8"));
    } else if (req.body) {
      // Corps déjà consommé par le runtime : signature non vérifiable ici.
      payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } else {
      return res.status(400).json({ error: "Corps de requête vide" });
    }

    if (payload?.eventType && payload.eventType !== "FORM_RESPONSE") {
      return res.status(200).json({ ignored: payload.eventType });
    }

    // 1) Mapping Tally -> données du template
    const data = mapTallyToTemplateData(payload);

    // 2) Génération du docx
    const buffer = renderBrief(data);
    const filename = briefFilename(data);

    // 3) Envoi par email
    const subject = `Nouveau brief — ${data.reference_projet || data.nom_produit || "sans référence"}`;
    const text = [
      "Un nouveau brief a été généré depuis le formulaire Tally.",
      "",
      `Référence projet : ${data.reference_projet || "—"}`,
      `Produit : ${data.nom_produit || "—"} (${data.type_produit || "—"})`,
      `Quantité : ${data.quantite || "—"}`,
      `Livraison souhaitée : ${data.date_livraison || "—"}`,
      "",
      "Le brief complet est en pièce jointe.",
    ].join("\n");

    await sendBriefEmail({ subject, text, filename, buffer });

    return res.status(200).json({ ok: true, filename });
  } catch (err) {
    console.error("[tally-webhook] erreur:", err);
    return res
      .status(500)
      .json({ error: "Échec du traitement", detail: String(err?.message || err) });
  }
}
