// Statistiques des automatisations (protégé par session Google).
import { requireAuth } from "../lib/auth.js";
import { getStats, getRecentExecutions } from "../lib/db.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const [automations, recent] = await Promise.all([
      getStats(),
      getRecentExecutions(25),
    ]);
    res.status(200).json({ automations, recent });
  } catch (err) {
    console.error("[stats]", err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}
