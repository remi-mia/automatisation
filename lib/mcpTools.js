// Outils MCP « Post-call Monego » : consulter les conversations issues du
// callbot ElevenLabs, préparer des brouillons et envoyer des mails.
import {
  listerConversations, getConversation, marquerTraitee, journaliserAction,
} from "./postcall.js";
import { listAccounts, getAccount } from "./emailStore.js";
import { getAccessToken } from "./gmailAuth.js";
import { createDraftMessage, sendMessage } from "./gmailApi.js";

// Domaines autorisés en destinataire (garde-fou anti-envoi accidentel).
const DOMAINES_AUTORISES = (process.env.POSTCALL_ALLOWED_DOMAINS || "monego.fr")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// Boîte utilisée par défaut pour les envois.
const BOITE_ENVOI = process.env.POSTCALL_SEND_FROM || "contact@monego.fr";

const MAX_PJ_OCTETS = 8 * 1024 * 1024; // 8 Mo par pièce jointe

// --- Utilitaires ---------------------------------------------------------

function enTableau(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.filter(Boolean) : [v].filter(Boolean);
}

function verifierDestinataires(listes) {
  const tous = listes.flat().map((e) => String(e).trim().toLowerCase());
  const refuses = tous.filter((e) => {
    const dom = e.split("@")[1] || "";
    return !DOMAINES_AUTORISES.includes(dom);
  });
  if (refuses.length) {
    throw new Error(
      `Destinataire(s) non autorisé(s) : ${refuses.join(", ")}. ` +
      `Seuls les domaines suivants sont permis : ${DOMAINES_AUTORISES.join(", ")}. ` +
      `Pour en autoriser d'autres, ajouter le domaine à la variable POSTCALL_ALLOWED_DOMAINS.`
    );
  }
  return tous;
}

// Résout les pièces jointes : soit contenu base64 fourni, soit URL à télécharger.
async function resoudrePiecesJointes(attachments = []) {
  const out = [];
  for (const pj of attachments) {
    if (!pj || (!pj.content_base64 && !pj.url)) {
      throw new Error("Chaque pièce jointe doit avoir 'content_base64' ou 'url'.");
    }
    if (pj.content_base64) {
      const taille = Buffer.from(pj.content_base64, "base64").length;
      if (taille > MAX_PJ_OCTETS) throw new Error(`Pièce jointe ${pj.filename} trop volumineuse (${Math.round(taille / 1e6)} Mo, max 8 Mo).`);
      out.push({ filename: pj.filename || "piece-jointe", mimeType: pj.mimeType, content_base64: pj.content_base64 });
      continue;
    }
    const resp = await fetch(pj.url, { signal: AbortSignal.timeout(60000) });
    if (!resp.ok) throw new Error(`Téléchargement de ${pj.url} échoué (${resp.status}).`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_PJ_OCTETS) throw new Error(`Pièce jointe ${pj.url} trop volumineuse (${Math.round(buf.length / 1e6)} Mo, max 8 Mo).`);
    out.push({
      filename: pj.filename || decodeURIComponent(new URL(pj.url).pathname.split("/").pop() || "piece-jointe"),
      mimeType: pj.mimeType || resp.headers.get("content-type") || "application/octet-stream",
      content_base64: buf.toString("base64"),
    });
  }
  return out;
}

async function tokenPourBoite(email) {
  const compte = await getAccount(email);
  if (!compte) {
    const dispo = (await listAccounts()).map((c) => c.email).join(", ");
    throw new Error(`Boîte « ${email} » non connectée. Boîtes disponibles : ${dispo || "aucune"}.`);
  }
  return getAccessToken(compte.refresh_token);
}

function formaterTranscript(transcript) {
  if (!Array.isArray(transcript) || !transcript.length) return "(transcript indisponible)";
  return transcript
    .filter((t) => t && (t.message || "").trim())
    .map((t) => {
      const qui = t.role === "agent" ? "Agent" : t.role === "user" ? "Appelant" : (t.role || "?");
      const ts = t.time_in_call_secs != null ? ` [${t.time_in_call_secs}s]` : "";
      return `${qui}${ts} : ${t.message}`;
    })
    .join("\n");
}

function texte(contenu) {
  return { content: [{ type: "text", text: contenu }] };
}

// --- Définition des outils exposés --------------------------------------

const PJ_SCHEMA = {
  type: "array",
  description:
    "Pièces jointes. Chaque entrée fournit SOIT 'content_base64' (petits fichiers) " +
    "SOIT 'url' (le serveur télécharge le fichier lui-même — à préférer pour les gros fichiers).",
  items: {
    type: "object",
    properties: {
      filename: { type: "string", description: "Nom du fichier affiché dans le mail (ex. plaquette.pdf)." },
      content_base64: { type: "string", description: "Contenu encodé en base64." },
      url: { type: "string", description: "URL publique du fichier à joindre." },
      mimeType: { type: "string", description: "Type MIME (déduit si absent)." },
    },
    required: ["filename"],
  },
};

export const TOOLS = [
  {
    name: "lister_conversations",
    description:
      "Liste les conversations du callbot Monego (ElevenLabs). Par défaut, celles qui " +
      "restent à traiter. Renvoie un résumé de chaque appel (appelant, durée, synthèse).",
    inputSchema: {
      type: "object",
      properties: {
        statut: { type: "string", enum: ["nouveau", "traite", "tous"], description: "Filtre de statut (défaut : nouveau)." },
        limit: { type: "number", description: "Nombre maximum de conversations (défaut 20, max 100)." },
      },
    },
  },
  {
    name: "lire_conversation",
    description:
      "Affiche le détail complet d'une conversation : transcript intégral, synthèse, " +
      "critères d'évaluation et données collectées par l'agent.",
    inputSchema: {
      type: "object",
      properties: { conversation_id: { type: "string", description: "Identifiant de la conversation." } },
      required: ["conversation_id"],
    },
  },
  {
    name: "lister_boites",
    description:
      "Liste les boîtes Gmail Monego connectées (pour créer des brouillons) et rappelle " +
      "la boîte d'envoi ainsi que les domaines destinataires autorisés.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "creer_brouillon",
    description:
      "Crée un brouillon d'email dans une boîte Monego connectée. Le brouillon n'est PAS " +
      "envoyé : la personne le relit et l'envoie depuis Gmail. Accepte des pièces jointes.",
    inputSchema: {
      type: "object",
      properties: {
        boite: { type: "string", description: "Boîte où créer le brouillon (ex. qmesnard@monego.fr). Voir lister_boites." },
        to: { type: "array", items: { type: "string" }, description: "Destinataire(s)." },
        cc: { type: "array", items: { type: "string" }, description: "Copie(s)." },
        subject: { type: "string", description: "Objet du mail." },
        body_html: { type: "string", description: "Corps du mail en HTML." },
        attachments: PJ_SCHEMA,
        conversation_id: { type: "string", description: "Conversation liée (pour l'audit)." },
      },
      required: ["boite", "to", "subject", "body_html"],
    },
  },
  {
    name: "envoyer_email",
    description:
      "ENVOIE réellement un email depuis la boîte contact@monego.fr (action irréversible). " +
      "Utiliser de préférence creer_brouillon si un relecteur humain est souhaité. " +
      "Les destinataires doivent appartenir aux domaines autorisés.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Destinataire(s)." },
        cc: { type: "array", items: { type: "string" }, description: "Copie(s)." },
        subject: { type: "string", description: "Objet du mail." },
        body_html: { type: "string", description: "Corps du mail en HTML." },
        attachments: PJ_SCHEMA,
        conversation_id: { type: "string", description: "Conversation liée (pour l'audit)." },
      },
      required: ["to", "subject", "body_html"],
    },
  },
  {
    name: "terminer_conversation",
    description:
      "Marque une conversation comme traitée : elle disparaît de la liste des conversations " +
      "à traiter. À appeler une fois le suivi effectué (brouillon créé ou mail envoyé).",
    inputSchema: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Identifiant de la conversation." },
        note: { type: "string", description: "Note libre : ce qui a été fait." },
      },
      required: ["conversation_id"],
    },
  },
];

// --- Exécution ------------------------------------------------------------

export async function executerOutil(nom, args = {}) {
  switch (nom) {
    case "lister_conversations": {
      const rows = await listerConversations({
        statut: args.statut || "nouveau",
        limit: args.limit || 20,
      });
      if (!rows.length) return texte("Aucune conversation à traiter.");
      const lignes = rows.map((c) => {
        const date = c.started_at ? new Date(c.started_at).toLocaleString("fr-FR") : "date inconnue";
        const duree = c.duration_secs != null ? `${Math.floor(c.duration_secs / 60)}m${String(c.duration_secs % 60).padStart(2, "0")}` : "?";
        const qui = c.caller_name || c.caller_email || c.caller_number || "appelant inconnu";
        return [
          `• ${c.conversation_id} [${c.statut}]`,
          `  ${date} · ${duree} · ${qui}${c.caller_email ? ` <${c.caller_email}>` : ""}`,
          `  Synthèse : ${c.summary || "(aucune)"}`,
        ].join("\n");
      });
      return texte(`${rows.length} conversation(s) :\n\n${lignes.join("\n\n")}`);
    }

    case "lire_conversation": {
      const c = await getConversation(args.conversation_id);
      if (!c) return texte(`Conversation « ${args.conversation_id} » introuvable.`);
      const bloc = [
        `Conversation ${c.conversation_id} [${c.statut}]`,
        `Agent : ${c.agent_name || c.agent_id || "?"}`,
        `Date : ${c.started_at ? new Date(c.started_at).toLocaleString("fr-FR") : "?"} · Durée : ${c.duration_secs ?? "?"}s`,
        `Appelant : ${c.caller_name || "?"}${c.caller_email ? ` <${c.caller_email}>` : ""}${c.caller_number ? ` (${c.caller_number})` : ""}`,
        `Issue de l'appel : ${c.call_successful || "?"}`,
        "",
        `SYNTHÈSE :\n${c.summary || "(aucune)"}`,
      ];
      const dc = c.analysis?.data_collection_results;
      if (dc && Object.keys(dc).length) {
        const items = Object.entries(dc).map(([k, v]) => `  - ${k} : ${v?.value ?? JSON.stringify(v)}`);
        bloc.push("", `DONNÉES COLLECTÉES :\n${items.join("\n")}`);
      }
      const ec = c.analysis?.evaluation_criteria_results;
      if (ec && Object.keys(ec).length) {
        const items = Object.entries(ec).map(([k, v]) => `  - ${k} : ${v?.result ?? "?"}${v?.rationale ? ` — ${v.rationale}` : ""}`);
        bloc.push("", `CRITÈRES D'ÉVALUATION :\n${items.join("\n")}`);
      }
      if (c.dynamic_variables && Object.keys(c.dynamic_variables).length) {
        bloc.push("", `VARIABLES : ${JSON.stringify(c.dynamic_variables)}`);
      }
      bloc.push("", `TRANSCRIPT :\n${formaterTranscript(c.transcript)}`);
      if (c.note) bloc.push("", `NOTE DE TRAITEMENT : ${c.note}`);
      return texte(bloc.join("\n"));
    }

    case "lister_boites": {
      const comptes = await listAccounts();
      const lignes = comptes.map((c) => `• ${c.email}${c.name ? ` (${c.name})` : ""}`);
      return texte(
        [
          `Boîtes connectées (brouillons possibles) :`,
          lignes.join("\n") || "  (aucune)",
          "",
          `Boîte d'envoi (envoyer_email) : ${BOITE_ENVOI}`,
          `Domaines destinataires autorisés : ${DOMAINES_AUTORISES.join(", ")}`,
        ].join("\n")
      );
    }

    case "creer_brouillon": {
      const to = enTableau(args.to);
      const cc = enTableau(args.cc);
      if (!to.length) throw new Error("Au moins un destinataire est requis.");
      verifierDestinataires([to, cc]);
      const token = await tokenPourBoite(args.boite);
      const attachments = await resoudrePiecesJointes(args.attachments);
      const res = await createDraftMessage(token, {
        to, cc, subject: args.subject, htmlBody: args.body_html, attachments,
      });
      await journaliserAction({
        conversationId: args.conversation_id, action: "brouillon", mailbox: args.boite,
        recipients: to, subject: args.subject,
        detail: { draft_id: res.id, pieces_jointes: attachments.map((p) => p.filename) },
      });
      return texte(
        `Brouillon créé dans ${args.boite} (id ${res.id}).\n` +
        `À : ${to.join(", ")}${cc.length ? ` · Cc : ${cc.join(", ")}` : ""}\n` +
        `Objet : ${args.subject}` +
        (attachments.length ? `\nPièces jointes : ${attachments.map((p) => p.filename).join(", ")}` : "") +
        `\nIl reste à le relire et l'envoyer depuis Gmail.`
      );
    }

    case "envoyer_email": {
      const to = enTableau(args.to);
      const cc = enTableau(args.cc);
      if (!to.length) throw new Error("Au moins un destinataire est requis.");
      verifierDestinataires([to, cc]);
      const token = await tokenPourBoite(BOITE_ENVOI);
      const attachments = await resoudrePiecesJointes(args.attachments);
      const res = await sendMessage(token, {
        to, cc, subject: args.subject, htmlBody: args.body_html, attachments,
      });
      await journaliserAction({
        conversationId: args.conversation_id, action: "envoi", mailbox: BOITE_ENVOI,
        recipients: to, subject: args.subject,
        detail: { message_id: res.id, pieces_jointes: attachments.map((p) => p.filename) },
      });
      return texte(
        `Email ENVOYÉ depuis ${BOITE_ENVOI} (id ${res.id}).\n` +
        `À : ${to.join(", ")}${cc.length ? ` · Cc : ${cc.join(", ")}` : ""}\n` +
        `Objet : ${args.subject}` +
        (attachments.length ? `\nPièces jointes : ${attachments.map((p) => p.filename).join(", ")}` : "")
      );
    }

    case "terminer_conversation": {
      const res = await marquerTraitee(args.conversation_id, args.note);
      if (!res) return texte(`Conversation « ${args.conversation_id} » introuvable.`);
      return texte(`Conversation ${res.conversation_id} marquée comme traitée${args.note ? ` (note : ${args.note})` : ""}.`);
    }

    default:
      throw new Error(`Outil inconnu : ${nom}`);
  }
}
