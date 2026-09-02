// Serveur MCP « Post-call Monego » — accès par header Authorization.
// Destiné à Claude Code :
//   claude mcp add --transport http postcall-monego \
//     https://automatisation-six.vercel.app/api/mcp \
//     --header "Authorization: Bearer <MCP_TOKEN>"
import { servir } from "../lib/mcpServer.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return servir(req, res);
  const attendu = process.env.MCP_TOKEN;
  const fourni = req.headers["authorization"] || "";
  if (!attendu || fourni !== `Bearer ${attendu}`) {
    res.setHeader("WWW-Authenticate", "Bearer");
    return res.status(401).json({ error: "Non autorisé" });
  }
  return servir(req, res);
}
