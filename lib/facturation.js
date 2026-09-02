// Règles de facturation Notion → Sinao.
//
// Deux opérations :
//   1. genererEcheancier(idContrat)  : crée les lignes de la base « Factures »
//      selon le cas de facturation (60/40, mariage 50/40/10, solde seul…).
//   2. envoyerVersSinao(idFacture)   : crée le BROUILLON de facture dans Sinao
//      et réécrit le résultat dans Notion.
import {
  getPage, queryDatabase, createPage, updatePage, prop,
  titre, txt, nombre, choix, date as dateProp, coche, lien, relation,
} from "./notion.js";
import { appPourEntite, trouverOrganisation, creerFactureBrouillon, urlFacture } from "./sinao.js";

const DB_FACTURES = () => process.env.NOTION_DB_FACTURES;

// Types de clients publics : pas d'acompte, on facture le solde après prestation.
const CLIENTS_SANS_ACOMPTE = ["office de tourisme", "communauté de communes", "mairie"];

const CAS = {
  "Société / Direct (60-40)": [
    { type: "Acompte", pct: 60, quand: "signature" },
    { type: "Solde", pct: 40, quand: "prestation" },
  ],
  "Chambre d'hôtes (60-40)": [
    { type: "Acompte", pct: 60, quand: "signature" },
    { type: "Solde", pct: 40, quand: "prestation" }, // daté au 1er jour d'arrivée
  ],
  "Mariage (50-40-10)": [
    { type: "Acompte", pct: 50, quand: "signature" },
    { type: "Échéance intermédiaire", pct: 40, quand: "prestation-90j" },
    { type: "Solde", pct: 10, quand: "prestation-21j" },
  ],
  "Booking.com (facture unique)": [
    // Le client est facturé du montant TOTAL ; la commission Booking est une
    // charge enregistrée séparément (hors périmètre de cette automatisation).
    { type: "Facture unique", pct: 100, quand: "prestation" },
  ],
  "Rétrocommission 10% (facture unique)": [
    { type: "Facture unique", pct: 10, quand: "prestation" },
  ],
  "Collectivité / OT (solde seul)": [
    { type: "Solde", pct: 100, quand: "prestation" },
  ],
};

function decalerJours(iso, jours) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + jours);
  return d.toISOString().slice(0, 10);
}

function dateEcheance(quand, dateSignature, datePrestation) {
  const presta = datePrestation || dateSignature;
  switch (quand) {
    case "signature": return dateSignature || presta;
    case "prestation": return presta;
    case "prestation-90j": return decalerJours(presta, -90);
    case "prestation-21j": return decalerJours(presta, -21);
    default: return presta;
  }
}

// --- Lecture du contexte d'un contrat --------------------------------------

async function contexteContrat(idContrat) {
  const contrat = await getPage(idContrat);

  const idsProjets = prop(contrat, "Projets") || [];
  const projet = idsProjets.length ? await getPage(idsProjets[0]) : null;

  const idsClients = projet ? prop(projet, "Client") || [] : [];
  const client = idsClients.length ? await getPage(idsClients[0]) : null;

  const idsPrestations = prop(contrat, "Prestations ") || prop(contrat, "Prestations") || [];
  const prestations = [];
  for (const id of idsPrestations) {
    const p = await getPage(id);
    prestations.push({
      libelle: prop(p, "Prestations") || "Prestation",
      montantHT: Number(prop(p, "Montant HT") || 0),
      tva: parseFloat(String(prop(p, "TVA") || "20").replace("%", "").replace(",", ".")) || 20,
    });
  }

  return {
    contrat,
    projet,
    client,
    prestations,
    numero: prop(contrat, "Numéro") || "",
    description: prop(contrat, "Description") || "",
    dateContrat: prop(contrat, "Date du contrat"),
    datePrestation: projet ? prop(projet, "Date") : null,
    montantHT: Number(prop(contrat, "Montant vente HT") || 0),
    entite: projet ? prop(projet, "Entité") : null,
    typeClient: client ? prop(client, "Type de client") : null,
    sansAcompte: Boolean(prop(contrat, "Sans acompte")),
    casChoisi: prop(contrat, "Cas de facturation"),
  };
}

// Détermine le cas de facturation applicable.
export function determinerCas(ctx) {
  if (ctx.sansAcompte) return "Collectivité / OT (solde seul)";
  if (ctx.casChoisi && CAS[ctx.casChoisi]) return ctx.casChoisi;
  const t = String(ctx.typeClient || "").toLowerCase();
  if (CLIENTS_SANS_ACOMPTE.some((c) => t.includes(c))) return "Collectivité / OT (solde seul)";
  return "Société / Direct (60-40)";
}

// --- 1) Génération de l'échéancier -----------------------------------------

export async function genererEcheancier(idContrat) {
  const ctx = await contexteContrat(idContrat);

  // Idempotence : on ne régénère pas si des factures existent déjà.
  const existantes = prop(ctx.contrat, "Factures") || [];
  if (existantes.length) {
    await updatePage(idContrat, { "Préparer la facturation": coche(false) });
    return { ok: true, cree: 0, message: `Échéancier déjà présent (${existantes.length} facture(s)).` };
  }
  if (!ctx.montantHT) {
    await updatePage(idContrat, { "Préparer la facturation": coche(false) });
    return { ok: false, cree: 0, message: "Montant vente HT nul : rien à facturer." };
  }

  const nomCas = determinerCas(ctx);
  const echeances = CAS[nomCas];
  const creees = [];

  for (const e of echeances) {
    const montant = Math.round(ctx.montantHT * (e.pct / 100) * 100) / 100;
    const page = await createPage({
      parent: { database_id: DB_FACTURES() },
      properties: {
        "Référence": titre(`${ctx.numero || "Contrat"} — ${e.type} ${e.pct}%`),
        "Contrat": relation(idContrat),
        "Type": choix(e.type),
        "Pourcentage (%)": nombre(e.pct),
        "Montant HT": nombre(montant),
        "Date prévue": dateProp(dateEcheance(e.quand, ctx.dateContrat, ctx.datePrestation)),
        "Statut": choix("À envoyer"),
        "Message": txt(`Cas : ${nomCas}`),
      },
    });
    creees.push(page.id);
  }

  await updatePage(idContrat, {
    "Préparer la facturation": coche(false),
    "Cas de facturation": choix(nomCas),
  });

  return { ok: true, cree: creees.length, cas: nomCas, message: `${creees.length} facture(s) créée(s) — cas « ${nomCas} ».` };
}

// --- 2) Envoi d'une facture vers Sinao (brouillon) --------------------------

function infosClient(client) {
  if (!client) return { nom: "Client inconnu" };
  const cp = prop(client, "CPFacture") ?? prop(client, "CP");
  const ville = prop(client, "VilleFacture") || prop(client, "Ville");
  return {
    nom: prop(client, "NomSurFacture") || prop(client, "Nom") || "Client",
    adresse: prop(client, "AdresseFacture") || prop(client, "Adresse") || null,
    adresse2: prop(client, "Adresse2Facture") || prop(client, "Adresse2") || null,
    localisation: [cp, ville].filter(Boolean).join(" ") || null,
  };
}

// Construit les lignes envoyées à Sinao.
function construireLignes(ctx, typeFacture, pct, montantFacture) {
  // Facture au montant plein : on détaille les prestations.
  if (pct >= 100 && ctx.prestations.length) {
    return ctx.prestations.map((p) => ({
      detail: p.libelle,
      quantite: 1,
      montantHT: p.montantHT,
      tvaPourcent: p.tva,
    }));
  }
  // Sinon une ligne unique représentant l'échéance.
  const tva = ctx.prestations[0]?.tva ?? 20;
  const objet = ctx.description || ctx.numero || "Prestation";
  return [{
    detail: `${typeFacture} ${pct} % — ${objet}`,
    quantite: 1,
    montantHT: montantFacture,
    tvaPourcent: tva,
  }];
}

export async function envoyerVersSinao(idFacture) {
  const facture = await getPage(idFacture);

  const statut = prop(facture, "Statut");
  const numSinao = prop(facture, "N° facture Sinao");
  if (statut === "Brouillon créé" && numSinao) {
    await updatePage(idFacture, { "Envoyer vers Sinao": coche(false) });
    return { ok: true, deja: true, message: `Brouillon déjà créé (Sinao ${numSinao}).` };
  }

  const idsContrat = prop(facture, "Contrat") || [];
  if (!idsContrat.length) throw new Error("Cette facture n'est reliée à aucun contrat.");
  const ctx = await contexteContrat(idsContrat[0]);

  const typeFacture = prop(facture, "Type") || "Facture";
  const pct = Number(prop(facture, "Pourcentage (%)") ?? 100);
  const montant = Number(prop(facture, "Montant HT") ?? 0);
  const datePrevue = prop(facture, "Date prévue");

  try {
    const app = appPourEntite(ctx.entite);
    const client = infosClient(ctx.client);

    // Réutilise le client Sinao existant si le nom correspond.
    const orga = await trouverOrganisation(app, client.nom);
    if (orga) client.id = orga.id;

    const lignes = construireLignes(ctx, typeFacture, pct, montant);
    const res = await creerFactureBrouillon(app, {
      client,
      lignes,
      dateISO: datePrevue ? `${datePrevue}T00:00:00Z` : null,
      notes: `${ctx.numero || ""} — ${typeFacture} ${pct}%`.trim(),
    });

    const idSinao = res.id ?? res.data?.id;
    await updatePage(idFacture, {
      "Statut": choix("Brouillon créé"),
      "N° facture Sinao": txt(String(idSinao)),
      "Lien Sinao": lien(urlFacture(app, idSinao)),
      "Message": txt(`Brouillon créé le ${new Date().toLocaleString("fr-FR")} (${app.entite}).`),
      "Envoyer vers Sinao": coche(false),
    });
    return { ok: true, idSinao, entite: app.entite, message: `Brouillon Sinao #${idSinao} créé.` };
  } catch (e) {
    await updatePage(idFacture, {
      "Statut": choix("Erreur"),
      "Message": txt(String(e?.message || e).slice(0, 1900)),
      "Envoyer vers Sinao": coche(false),
    });
    throw e;
  }
}

// Utilitaire : liste les factures « À envoyer » (diagnostic).
export async function listerAEnvoyer() {
  const d = await queryDatabase(DB_FACTURES(), {
    filter: { property: "Statut", select: { equals: "À envoyer" } },
    page_size: 50,
  });
  return d.results.map((p) => ({
    id: p.id,
    reference: prop(p, "Référence"),
    montant: prop(p, "Montant HT"),
    statut: prop(p, "Statut"),
  }));
}
