// Démarre le flux Google OAuth : redirige vers l'écran de consentement Google.
import { buildGoogleAuthUrl } from "../../lib/auth.js";

export default function handler(req, res) {
  try {
    const url = buildGoogleAuthUrl(req, res);
    res.writeHead(302, { Location: url });
    res.end();
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
