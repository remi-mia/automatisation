// Cœur du serveur MCP « Post-call Monego » : traitement des messages JSON-RPC 2.0.
// Partagé par les deux voies d'accès HTTP :
//   - api/mcp.js            → header Authorization: Bearer MCP_TOKEN (Claude Code)
//   - api/mcp-url/[token].js → token dans l'URL (Claude web / Cowork, qui ne
//     permettent pas d'ajouter un header personnalisé)
import { TOOLS, executerOutil } from "./mcpTools.js";

const VERSIONS_SUPPORTEES = ["2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_DEFAUT = "2025-06-18";

export function resultat(id, result) {
  return { jsonrpc: "2.0", id, result };
}
export function erreur(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// Lit le corps de la requête (déjà parsé par le runtime, ou brut).
export async function lireCorps(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
  const morceaux = [];
  for await (const m of req) morceaux.push(typeof m === "string" ? Buffer.from(m) : m);
  const brut = Buffer.concat(morceaux).toString("utf8");
  return brut ? JSON.parse(brut) : null;
}

// Traite un message JSON-RPC. Renvoie null pour une notification (pas de réponse).
export async function traiter(msg) {
  const { id, method, params } = msg || {};
  const estNotification = id === undefined || id === null;

  switch (method) {
    case "initialize": {
      const demandee = params?.protocolVersion;
      const version = VERSIONS_SUPPORTEES.includes(demandee) ? demandee : VERSION_DEFAUT;
      return resultat(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "postcall-monego", version: "1.1.0" },
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

    case "resources/list":
      return resultat(id, { resources: [] });
    case "prompts/list":
      return resultat(id, { prompts: [] });

    case "tools/call": {
      try {
        const res = await executerOutil(params?.name, params?.arguments || {});
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

// Traitement complet d'une requête HTTP déjà authentifiée.
export async function servir(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    // Pas de flux SSE côté serveur : transport POST uniquement (conforme au
    // spec Streamable HTTP, qui impose 405 quand GET n'est pas proposé).
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Utiliser POST (JSON-RPC)." });
  }

  let corps;
  try {
    corps = await lireCorps(req);
  } catch {
    return res.status(400).json(erreur(null, -32700, "JSON invalide"));
  }
  if (!corps) return res.status(400).json(erreur(null, -32600, "Requête vide"));

  try {
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
