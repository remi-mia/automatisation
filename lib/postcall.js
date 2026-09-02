// Accès aux conversations post-call (schéma Supabase `automatisation`).
// Les conversations restent en base jusqu'à ce qu'elles soient marquées « traité »
// via l'outil MCP dédié.
import { createClient } from "@supabase/supabase-js";

let client = null;

export function db() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Configuration Supabase manquante.");
  client = createClient(url, key, {
    auth: { persistSession: false },
    db: { schema: "automatisation" },
  });
  return client;
}

// --- Enregistrement depuis le webhook ElevenLabs ------------------------------

// Extrait les infos utiles du payload `data` d'un post_call_transcription.
export function normaliserConversation(data) {
  const meta = data.metadata || {};
  const analysis = data.analysis || {};
  const init = data.conversation_initiation_client_data || {};
  const vars = init.dynamic_variables || {};

  // Le numéro / l'email de l'appelant peuvent arriver sous plusieurs clés selon
  // la configuration de l'agent : on prend la première renseignée.
  const pick = (...cles) => {
    for (const c of cles) {
      const v = vars[c] ?? meta[c];
      if (v != null && String(v).trim() !== "") return String(v).trim();
    }
    return null;
  };

  const startUnix = meta.start_time_unix_secs;

  return {
    conversation_id: data.conversation_id,
    agent_id: data.agent_id || null,
    agent_name: data.agent_name || null,
    call_status: data.status || null,
    call_successful: analysis.call_successful || null,
    caller_number: pick("system__caller_id", "caller_id", "phone_number", "from_number"),
    caller_email: pick("email", "caller_email", "user_email"),
    caller_name: pick("name", "caller_name", "user_name", "prenom"),
    started_at: startUnix ? new Date(startUnix * 1000).toISOString() : null,
    duration_secs: meta.call_duration_secs ?? null,
    summary: analysis.transcript_summary || null,
    transcript: data.transcript || null,
    analysis: Object.keys(analysis).length ? analysis : null,
    dynamic_variables: Object.keys(vars).length ? vars : null,
  };
}

// Insère (ou met à jour) une conversation. Idempotent sur conversation_id.
export async function enregistrerConversation(row) {
  const { error } = await db()
    .from("postcall_conversations")
    .upsert(row, { onConflict: "conversation_id" });
  if (error) throw new Error(`enregistrerConversation: ${error.message}`);
}

// --- Lecture / traitement (utilisé par le MCP) --------------------------------

export async function listerConversations({ statut = "nouveau", limit = 20 } = {}) {
  let q = db()
    .from("postcall_conversations")
    .select("conversation_id, statut, agent_name, caller_number, caller_email, caller_name, started_at, duration_secs, summary, call_successful, note, traite_at")
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(Math.min(limit, 100));
  if (statut && statut !== "tous") q = q.eq("statut", statut);
  const { data, error } = await q;
  if (error) throw new Error(`listerConversations: ${error.message}`);
  return data;
}

export async function getConversation(conversationId) {
  const { data, error } = await db()
    .from("postcall_conversations")
    .select("*")
    .eq("conversation_id", conversationId)
    .maybeSingle();
  if (error) throw new Error(`getConversation: ${error.message}`);
  return data;
}

export async function marquerTraitee(conversationId, note) {
  const { data, error } = await db()
    .from("postcall_conversations")
    .update({ statut: "traite", note: note || null, traite_at: new Date().toISOString() })
    .eq("conversation_id", conversationId)
    .select("conversation_id, statut, traite_at")
    .maybeSingle();
  if (error) throw new Error(`marquerTraitee: ${error.message}`);
  return data;
}

// Journalise une action (brouillon créé, mail envoyé) pour l'audit.
export async function journaliserAction({ conversationId, action, mailbox, recipients, subject, detail }) {
  try {
    await db().from("postcall_actions").insert({
      conversation_id: conversationId || null,
      action,
      mailbox: mailbox || null,
      recipients: Array.isArray(recipients) ? recipients.join(", ") : recipients || null,
      subject: subject || null,
      detail: detail || null,
    });
  } catch (e) {
    console.error("[postcall] journalisation action échouée:", e?.message || e);
  }
}
