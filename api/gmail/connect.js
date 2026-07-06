// Démarre la connexion d'une boîte Gmail : redirige vers le consentement Google
// (accès hors-ligne pour obtenir un refresh_token).
import { buildConnectUrl } from "../../lib/gmailAuth.js";

export default function handler(req, res) {
  try {
    const url = buildConnectUrl(req, res);
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
