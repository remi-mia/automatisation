// Webhook post-call ElevenLabs : reçoit la conversation du callbot Monego,
// la normalise et la stocke pour traitement via le MCP.
//
// Signature : header `ElevenLabs-Signature: t=<unix>,v0=<hex>` où
// hex = HMAC-SHA256(secret, "<t>.<corps brut>"). Tolérance 30 minutes.
import crypto from "node:crypto";
import { normaliserConversation, enregistrerConversation } from "../lib/postcall.js";
import { logExecution } from "../lib/db.js";

const AUTOMATION_ID = "postcall-monego";
const TOLERANCE_SECS = 30 * 60;

async function lireCorpsBrut(req) {
  const morceaux = [];
  for await (const m of req) morceaux.push(typeof m === "string" ? Buffer.from(m) : m);
  return Buffer.concat(morceaux).toString("utf8");
}

function verifierSignature(corpsBrut, entete, secret) {
  if (!entete) return { ok: false, raison: "signature absente" };
  const parties = Object.fromEntries(
    String(entete).split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = parties.t;
  const v0 = parties.v0;
  if (!t || !v0) return { ok: false, raison: "format de signature inattendu" };

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > TOLERANCE_SECS) {
    return { ok: false, raison: "horodatage hors tolérance (rejeu ?)" };
  }

  const attendu = crypto.createHmac("sha256", secret).update(`${t}.${corpsBrut}`).digest("hex");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(v0), Buffer.from(attendu))) {
      return { ok: false, raison: "signature invalide" };
    }
  } catch {
    return { ok: false, raison: "signature invalide" };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const t0 = Date.now();
  try {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    if (!secret) return res.status(500).json({ error: "ELEVENLABS_WEBHOOK_SECRET non configuré." });

    // Corps brut indispensable au calcul HMAC ; repli sur le corps déjà parsé
    // par le runtime (dans ce cas la signature ne peut pas être recalculée).
    let corpsBrut = await lireCorpsBrut(req);
    let sourceBrute = true;
    if (!corpsBrut && req.body) {
      corpsBrut = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      sourceBrute = false;
    }
    if (!corpsBrut) return res.status(400).json({ error: "Corps vide" });

    const verif = verifierSignature(corpsBrut, req.headers["elevenlabs-signature"], secret);
    if (!verif.ok) {
      console.warn(`[elevenlabs] rejet : ${verif.raison} (corps brut=${sourceBrute})`);
      return res.status(401).json({ error: `Signature refusée : ${verif.raison}` });
    }

    const payload = JSON.parse(corpsBrut);
    const type = payload?.type;

    if (type !== "post_call_transcription") {
      // post_call_audio / call_initiation_failure : non exploités ici.
      return res.status(200).json({ ok: true, ignore: type || "type inconnu" });
    }

    const row = normaliserConversation(payload.data || {});
    if (!row.conversation_id) return res.status(400).json({ error: "conversation_id manquant" });

    await enregistrerConversation(row);

    const duree = Date.now() - t0;
    await logExecution({
      automationId: AUTOMATION_ID,
      status: "success",
      durationMs: duree,
      meta: {
        conversation_id: row.conversation_id,
        duree_appel_s: row.duration_secs,
        appelant: row.caller_email || row.caller_number || row.caller_name || null,
      },
    });
    return res.status(200).json({ ok: true, conversation_id: row.conversation_id });
  } catch (err) {
    console.error("[elevenlabs-webhook]", err);
    await logExecution({
      automationId: AUTOMATION_ID, status: "error",
      error: String(err?.message || err), durationMs: Date.now() - t0,
    });
    return res.status(500).json({ error: String(err?.message || err) });
  }
}
