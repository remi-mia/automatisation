// Accès Supabase (schéma `automatisation`) côté serveur, via la clé service_role.
// Sert à journaliser les exécutions et à lire les statistiques du dashboard.
import { createClient } from "@supabase/supabase-js";

let client = null;

function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Configuration Supabase manquante (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)."
    );
  }
  client = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "automatisation" },
  });
  return client;
}

// Indique si la journalisation est configurée (sinon on n'échoue pas l'automatisation).
export function dbEnabled() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Enregistre (ou met à jour) une automatisation dans le registre.
export async function upsertAutomation({ id, name, description }) {
  if (!dbEnabled()) return;
  await db().from("automations").upsert({ id, name, description });
}

// Journalise une exécution. Ne lève jamais : un échec de log ne doit pas
// faire échouer l'automatisation elle-même.
export async function logExecution({ automationId, status, error, durationMs, meta }) {
  if (!dbEnabled()) return;
  try {
    await db().from("executions").insert({
      automation_id: automationId,
      status,
      error: error ? String(error).slice(0, 2000) : null,
      duration_ms: durationMs ?? null,
      meta: meta ?? null,
    });
  } catch (e) {
    console.error("[db] échec journalisation:", e);
  }
}

// Statistiques agrégées par automatisation (pour le dashboard).
export async function getStats() {
  const { data, error } = await db()
    .from("automation_stats")
    .select("*");
  if (error) throw error;
  return data;
}

// Dernières exécutions (toutes automatisations confondues).
export async function getRecentExecutions(limit = 20) {
  const { data, error } = await db()
    .from("executions")
    .select("id, automation_id, status, error, duration_ms, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}
