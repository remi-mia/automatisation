// Appel à l'API Cortex qui génère la réponse à un email.
// Renvoie l'objet JSON de la réponse (attendu : { hasAiResponse, draft, ... }).
const DEFAULT_URL = "https://cortex-api.apps.coolify.monego-ra.fr/incoming-email";

export async function genererReponse({ from, subject, body }) {
  const url = process.env.CORTEX_URL || DEFAULT_URL;
  const token = process.env.CORTEX_TOKEN;
  if (!token) throw new Error("CORTEX_TOKEN non défini.");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, subject, body }),
    signal: AbortSignal.timeout(120000),
  });
  if (!resp.ok) {
    throw new Error(`Cortex ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  return resp.json();
}
