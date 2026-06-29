# Correspondance formulaire Tally « Brief Charles - Paris » → variables du template docx

Formulaire Tally : ZjZKkz. Template : BRIEF_Charles_Paris_template.docx (4 pages : Brief, Monture, Retour décor, Pré-départ).

Toutes les variables sont au format `{{nom}}` et restent un seul bloc de texte (compatibles Docxtemplater, docxtpl/python-docx-template, ou « Remplacer le texte » dans Make/Google Docs).

## Variables alimentées par Tally

| Variable docx | Question Tally | Page Tally | Type |
|---|---|---|---|
| `{{pays_installation}}` | Pays d'installation | 1 Infos générales | texte |
| `{{reference_projet}}` | Référence du projet | 1 | texte |
| `{{date_commande}}` | Date de la commande | 1 | date |
| `{{date_livraison}}` | Date de livraison souhaitée | 1 | date |
| `{{reference_produit}}` | Référence produit | 1 | texte |
| `{{nom_produit}}` | Nom du produit | 1 | texte |
| `{{quantite}}` | Quantité de pièces | 1 | nombre |
| `{{numeros_serie}}` | Numéro(s) de série | 1 | texte |
| `{{type_produit}}` | Quel type de produit ? | 2 | choix |
| `{{finition}}` | Type de finition (+ Finition standard / Finition sur mesure / Préciser la finition) | 3-4 | choix + texte |
| `{{dimensions}}` | Longueur / Largeur / Diamètre / Hauteur (à composer dans Make) | 3-4 | nombres |
| `{{matiere_fil}}` | Matière du fil | 3 Lampe | choix |
| `{{position_commande}}` | Position du dispositif de commande (+ Distance sur mesure) | 3 Lampe | choix + nombre |
| `{{longueur_fil}}` | Longueur de fil (+ Longueur sur mesure) | 3 Lampe | choix + nombre |
| `{{couleur_fil}}` | Couleur du fil de soie tressée | 3 Lampe | dropdown |
| `{{couleur_switch}}` | Couleur du switch / variateur | 3 Lampe | dropdown |
| `{{couleur_fiche}}` | Couleur de la fiche | 3 Lampe | dropdown |
| `{{certification}}` | Certification (UL Listing / CE Compliant / Autre) | 3 Lampe | cases à cocher |
| `{{exposition_humidite}}` | Exposition à l'humidité | 7 Exposition & Montage | choix |
| `{{exposition_marin}}` | Exposition à un environnement marin | 7 | choix |
| `{{vernis_marin}}` | Vernis marin requis ? | 7 | choix |
| `{{montage_bateau}}` | Montage bateau ? (+ Épaisseur du support) | 7 | choix + nombre |
| `{{longueur_tige_filetee}}` | Longueur tige filetée | 7 | nombre |

## Variables sans source Tally (à remplir à la main ou par constante Make)

| Variable docx | Remarque |
|---|---|
| `{{adv}}` | Pas de champ ADV dans Tally. À remplir par une constante (nom de l'ADV) ou manuellement. |
| `{{temperature}}` | Pas de question température de couleur (°K) dans Tally. Manuel. |
| `{{dimensions_pouces}}` | Conversion mm → pouces : à calculer dans Make, pas saisie dans Tally. |

## À composer dans Make avant la fusion

- `{{dimensions}}` : concaténer les cotes selon le produit, ex.
  - Lampe : `L {Longueur} × l {Largeur} × H {Hauteur} mm`
  - Lampadaire : `L {Longueur} × l {Largeur} × Ø {Diamètre} × H {Hauteur hors tout} mm`
- `{{dimensions_pouces}}` : conversion des cotes ci-dessus (mm / 25,4).
- `{{finition}}` : si Type de finition = Standard → reprendre « Finition standard », sinon « Finition sur mesure ».

## Points de divergence template Charles ↔ Tally (à arbitrer)

1. Bloc ELECTRIFICATION = champs de la branche **Lampe**. Pour un **Lampadaire**, Tally capture Voltage, Système domotique, Type de transformateur, Driver, Type de J-BOX — qui n'ont pas de case dans la fiche Charles. Ces réponses seraient perdues en l'état.
2. Champs Tally sans emplacement dans la fiche : Type de commande, N° de commande, Nom du client, Échantillon client fourni ?, Fiche technique à jour ?, Éclaté de décor à jour ?, Orientation (présente sur la fiche mais en case manuelle), Abat-jour ? / Tissu / Finition métal abat-jour, Indice IP, Voltage, Système domotique, Dispositif de commande, Le dos du luminaire visible ?
3. Cases à cocher de la fiche (Plan de fabrication, Éclaté de décor, Présence fiche technique, Orientation Gauche/Droite, Oui/Non signature) restées manuelles : elles ont des équivalents Tally (Fiche technique à jour ?, Éclaté de décor à jour ?, Orientation) si tu veux les automatiser.
