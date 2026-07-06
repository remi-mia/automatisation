// Callback OAuth : enregistre le refresh_token de la boîte Gmail connectée,
// puis affiche une page de confirmation.
import { exchangeCode } from "../../lib/gmailAuth.js";
import { saveAccount } from "../../lib/emailStore.js";

function page(titre, message, ok = true) {
  const couleur = ok ? "#16a34a" : "#dc2626";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titre}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e7ebf2;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#151922;border:1px solid #262c39;border-radius:16px;padding:40px;max-width:440px;text-align:center}
.badge{width:56px;height:56px;border-radius:50%;background:${couleur};display:grid;place-items:center;margin:0 auto 18px;font-size:28px;color:#fff}
h1{font-size:20px;margin:0 0 8px}p{color:#8b94a7;font-size:14px;line-height:1.5}</style></head>
<body><div class="card"><div class="badge">${ok ? "✓" : "!"}</div><h1>${titre}</h1><p>${message}</p></div></body></html>`;
}

export default async function handler(req, res) {
  try {
    const account = await exchangeCode(req);
    await saveAccount(account);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).end(
      page(
        "Boîte connectée ✅",
        `<b>${account.email}</b> est maintenant connectée. Les réponses IA seront préparées en brouillon dans cette boîte. Tu peux fermer cette page.`
      )
    );
  } catch (err) {
    console.error("[gmail/callback]", err);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(400).end(
      page("Connexion échouée", `Une erreur est survenue : ${String(err?.message || err)}. Réessaie depuis le lien de connexion.`, false)
    );
  }
}
