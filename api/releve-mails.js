// Relève les mails non lus des boîtes Gmail connectées, appelle l'API Cortex,
// et crée un brouillon de réponse dans le thread. Déclenché par Cron Vercel
// (header Authorization: Bearer CRON_SECRET) ou par Make (?token=VEILLE_TOKEN).
import { getAccessToken } from "../lib/gmailAuth.js";
import { listUnread, getMessage, createDraft } from "../lib/gmailApi.js";
import { listAccounts, claimMessage } from "../lib/emailStore.js";
import { genererReponse } from "../lib/cortex.js";
import { logExecution } from "../lib/db.js";

const AUTOMATION_ID = "reponses-email";

// Domaines/mots internes : les mails dont l'expéditeur correspond ne sont pas
// traités (pas de brouillon). Configurable via INTERNAL_DOMAINS (séparés par des
// virgules) ; défaut "monego" (couvre monego.fr, monego-ra.fr…).
const INTERNAL_TOKENS = (process.env.INTERNAL_DOMAINS || "monego")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function estInterne(fromEmail, compteEmail) {
  const e = (fromEmail || "").toLowerCase();
  if (!e) return false;
  if (e === (compteEmail || "").toLowerCase()) return true; // soi-même
  return INTERNAL_TOKENS.some((tok) => e.includes(tok));
}

function autorise(req) {
  const auth = req.headers["authorization"] || "";
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true; // Cron Vercel
  const token = req.headers["x-veille-token"] || req.query?.token;
  if (process.env.VEILLE_TOKEN && token === process.env.VEILLE_TOKEN) return true; // Make
  return false;
}

async function traiterCompte(compte, stats) {
  const accessToken = await getAccessToken(compte.refresh_token);
  const ids = await listUnread(accessToken);
  for (const id of ids) {
    stats.lus++;
    // Claim d'abord (idempotence : un seul traitement par message, jamais de doublon).
    const nouveau = await claimMessage(id, compte.email);
    if (!nouveau) continue;
    stats.traites++;
    try {
      const msg = await getMessage(accessToken, id);
      // On ne traite pas les mails internes (collègues monego / soi-même).
      if (estInterne(msg.fromEmail, compte.email)) {
        stats.ignores++;
        continue;
      }
      const rep = await genererReponse({
        from: msg.fromEmail,
        subject: msg.subject,
        body: msg.body,
      });
      if (rep && rep.hasAiResponse !== false && rep.draft) {
        await createDraft(accessToken, {
          toEmail: msg.fromEmail,
          subject: msg.subject,
          htmlBody: rep.draft,
          threadId: msg.threadId,
          inReplyTo: msg.messageIdHeader,
          references: msg.references,
        });
        stats.brouillons++;
      }
    } catch (e) {
      stats.erreurs++;
      console.error(`[releve-mails] ${compte.email} msg ${id}:`, e?.message || e);
    }
  }
}

export default async function handler(req, res) {
  if (!autorise(req)) return res.status(401).json({ error: "Non autorisé" });

  const t0 = Date.now();
  const stats = { comptes: 0, lus: 0, traites: 0, ignores: 0, brouillons: 0, erreurs: 0 };
  try {
    const comptes = await listAccounts();
    stats.comptes = comptes.length;
    for (const compte of comptes) {
      try {
        await traiterCompte(compte, stats);
      } catch (e) {
        stats.erreurs++;
        console.error(`[releve-mails] compte ${compte.email}:`, e?.message || e);
      }
    }
    const durationMs = Date.now() - t0;
    await logExecution({
      automationId: AUTOMATION_ID,
      status: stats.erreurs ? "error" : "success",
      error: stats.erreurs ? `${stats.erreurs} erreur(s)` : null,
      durationMs,
      meta: stats,
    });
    return res.status(200).json({ ok: true, ...stats, duree_ms: durationMs });
  } catch (err) {
    const durationMs = Date.now() - t0;
    console.error("[releve-mails]", err);
    await logExecution({
      automationId: AUTOMATION_ID, status: "error",
      error: String(err?.message || err), durationMs, meta: stats,
    });
    return res.status(500).json({ error: String(err?.message || err), ...stats });
  }
}
