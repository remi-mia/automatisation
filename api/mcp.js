// Serveur MCP « Post-call Monego » exposé en HTTP (transport Streamable HTTP,
// JSON-RPC 2.0). À déclarer dans Claude Code :
//   claude mcp add --transport http postcall-monego \
//     https://automatisation-six.vercel.app/api/mcp \
//     --header "Authorization: Bearer <MCP_TOKEN>"
import { TOOLS, executerOutil } from "../lib/mcpTools.js";

const VERSIONS_SUPPORTEES = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_DEFAUT = "2025-06-18";

function autorise(req) {
  const attendu = process.env.MCP_TOKEN;
  if (!attendu) return false; // pas de token configuré => refus par sécurité
  const auth = req.headers["authorization"] || "";
  return auth === `Bearer ${attendu}`;
}

async function lireCorps(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
  const morceaux = [];
  for await (const m of req) morceaux.push(typeof m === "string" ? Buffer.from(m) : m);
  const brut = Buffer.concat(morceaux).toString("utf8");
  return brut ? JSON.parse(brut) : null;
}

function resultat(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function erreur(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Traite un message JSON-RPC. Renvoie null pour une notification (pas de réponse).
async function traiter(msg) {
  const { id, method, params } = msg || {};
  const estNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const demandee = params?.protocolVersion;
      const version = VERSIONS_SUPPORTEES.includes(demandee) ? demandee : VERSION_DEFAUT;
      return resultat(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "postcall-monego", version: "1.0.0" },
        instructions:
          "Suivi des appels du callbot Monego. Utiliser lister_conversations pour voir " +
          "les appels à traiter, lire_conversation pour le détail, puis creer_brouillon " +
          "(recommandé) ou envoyer_email, et enfin terminer_conversation.",
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return resultat(id, {});

    case "tools/list":
      return resultat(id, { tools: TOOLS });

    case "tools/call": {
      const nom = params?.name;
      const args = params?.arguments || {};
      try {
        const res = await executerOutil(nom, args);
        return resultat(id, res);
      } catch (e) {
        // Erreur d'exécution d'outil : renvoyée dans le résultat (isError) pour
        // que le modèle puisse la lire et se corriger.
        return resultat(id, {
          content: [{ type: "text", text: `Erreur : ${e?.message || e}` }],
          isError: true,
        });
      }
    }

    default:
      if (estNotification) return null;
      return erreur(id, -32601, `Méthode inconnue : ${method}`);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET" || req.method === "DELETE") {
    // Pas de flux SSE côté serveur ni de sessions : transport POST uniquement.
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Utiliser POST (JSON-RPC)." });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }
  if (!autorise(req)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Non autorisé" });
  }

  let corps;
  try {
    corps = await lireCorps(req);
  } catch {
    return res.status(400).json(erreur(null, -32700, "JSON invalide"));
  }
  if (!corps) return res.status(400).json(erreur(null, -32600, "Requête vide"));

  try {
    // Un lot (array) ou un message unique.
    if (Array.isArray(corps)) {
      const reponses = (await Promise.all(corps.map(traiter))).filter(Boolean);
      if (!reponses.length) return res.status(202).end();
      return res.status(200).json(reponses);
    }
    const reponse = await traiter(corps);
    if (!reponse) return res.status(202).end();
    return res.status(200).json(reponse);
  } catch (e) {
    console.error("[mcp]", e);
    return res.status(200).json(erreur(corps?.id ?? null, -32603, String(e?.message || e)));
  }
}
