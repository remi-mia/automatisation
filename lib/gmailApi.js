// Appels Gmail API v1 : lister les non-lus, lire un message, créer un brouillon.
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gapi(accessToken, path, options = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Gmail API ${path} → ${resp.status} ${t.slice(0, 200)}`);
  }
  return resp.json();
}

// Liste les IDs des messages non lus de la boîte de réception (fenêtre récente).
export async function listUnread(accessToken, { maxResults = 15, newerThanDays = 3 } = {}) {
  const q = encodeURIComponent(`is:unread in:inbox newer_than:${newerThanDays}d`);
  const data = await gapi(accessToken, `/messages?q=${q}&maxResults=${maxResults}`);
  return (data.messages || []).map((m) => m.id);
}

function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : "";
}

// Décode récursivement le corps texte (préférence text/plain).
function extractBody(payload) {
  const decode = (data) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  let plain = "";
  let html = "";
  const walk = (part) => {
    if (!part) return;
    const mt = part.mimeType || "";
    if (mt === "text/plain" && part.body?.data) plain += decode(part.body.data);
    else if (mt === "text/html" && part.body?.data) html += decode(part.body.data);
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  if (plain.trim()) return plain;
  // repli : HTML nettoyé grossièrement
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseEmailAddress(from) {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

// Récupère un message et le normalise.
export async function getMessage(accessToken, id) {
  const msg = await gapi(accessToken, `/messages/${id}?format=full`);
  const headers = msg.payload?.headers || [];
  const from = header(headers, "From");
  return {
    id: msg.id,
    threadId: msg.threadId,
    from,
    fromEmail: parseEmailAddress(from),
    subject: header(headers, "Subject"),
    messageIdHeader: header(headers, "Message-ID"),
    references: header(headers, "References"),
    body: extractBody(msg.payload),
  };
}

// Construit un message MIME brut (base64url) pour un brouillon de réponse HTML.
function buildRawReply({ toEmail, subject, htmlBody, inReplyTo, references }) {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${toEmail}`,
    `Subject: ${subj}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
  ];
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references || inReplyTo) lines.push(`References: ${references || inReplyTo}`);
  const raw = `${lines.join("\r\n")}\r\n\r\n${htmlBody}`;
  return Buffer.from(raw, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Crée un brouillon de réponse dans le thread d'origine.
export async function createDraft(accessToken, { toEmail, subject, htmlBody, threadId, inReplyTo, references }) {
  const raw = buildRawReply({ toEmail, subject, htmlBody, inReplyTo, references });
  return gapi(accessToken, "/drafts", {
    method: "POST",
    body: JSON.stringify({ message: { raw, threadId } }),
  });
}

// Marque un message comme lu (retire le label UNREAD).
export async function markRead(accessToken, id) {
  return gapi(accessToken, `/messages/${id}/modify`, {
    method: "POST",
    body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
  });
}
