# Feuille de route produit — phases, charges et offre

> Rédigé le 2026-08-21. Document de **pilotage produit** : il décrit *ce qui est
> construit*, *ce qui reste à construire*, *dans quel ordre*, *pour quelle
> charge* et *sous quelle offre*, sur les **quatre briques** de la plateforme.
>
> **Public visé** : le porteur du projet, et tout intervenant qui reprend une
> phase sans contexte de la discussion d'origine. Ce document est la source de
> vérité de l'avancement produit — au même titre que le §0 de
> `QA_TEST_STRATEGY.md` l'est pour le dispositif de test, dont il reprend
> volontairement la convention.
>
> **Statut** : v4.1 — cadrage établi d'après l'état **mesuré** du code, et non
> d'après le catalogue commercial qui le précède. Mesures refaites sur les
> **quatre** briques le **2026-08-22** (§15). Phase 1-A livrée ; **phase 1-B en
> cours** — sa ligne 6 (frais — reçu et échéancier) est **livrée le 2026-09-02**,
> première ligne de la phase à l'être ; phases 2 à 4 non démarrées.
>
> **Prérequis de lecture** : `CLAUDE.md` (les quatre briques, les invariants
> d'isolation et de suppression). Documents dont cette feuille de route dérive :
> `QA_TEST_STRATEGY.md` (chantiers CH-0 à CH-7),
> `FEATURE_DELIVERY_DESIGN.md` (livraison sous licence, phases 0 à 6),
> `CAMPUS_ENTITLEMENT_DESIGN.md` (le registre de modules et ses paliers).
>
> **Il remplace `ERP_2026_v2.pdf`** (édition 2025–2027) comme référence de
> planification. Ses écarts au code sont traités au §11, aucun n'est laissé
> ouvert.
>
> ⚠️ **Le fichier `~/Downloads/claudePdf/Global_Roadmap/ERP_2026_v2.pdf` ne
> contient plus le catalogue de 2025–2027** : il porte, depuis le 2026-08-22, la
> vue rendue de ce document (décision du porteur). Le catalogue ne subsiste que
> par les citations relevées au §11 — c'est désormais la seule trace de ce qui a
> été affirmé, et la raison pour laquelle ces citations sont conservées mot pour
> mot plutôt que résumées. Le `v1` du même dossier n'a pas été touché.
>
> **Langue.** Prose en français, conforme aux documents voisins de
> `docs/architecture/`. **Tout artefact de code — identifiants, commentaires,
> JSDoc, messages de log, noms de fichiers — reste en anglais**, conformément au
> §0 de `CLAUDE.md`.
>
> **Révisions** : **v4.1 (2026-09-02)** — **clôture de la ligne 6 de la phase
> 1-B** (D-R18). L'étape 10 du patron §12 est jouée et promue en harnais
> permanent, ce qui fait remonter un défaut d'en-tête CORS invisible à toute la
> suite d'intégration. Le restant de la phase passe de 32–47 à **30–44 j**, le
> total de 212–275 à **210–272 j**, et les tableaux monétaires du §9 suivent.
> **v4.0 (2026-08-22)** — **audit du document contre le code des
> quatre briques et contre les documents voisins de `docs/architecture/`**. Cinq
> affirmations que le code contredit sont corrigées (§4.3, §5 l. 9 et 11, §6 l. 4
> et 5, §7.1 l. 7, §8.2 l. 7, §11 écarts 2/5/6) ; **une contradiction de prix
> entre trois documents** devient un arbitrage (D-R8) ; **la grille vendait
> au-dessus des quotas que le code applique** (D-R10) ; trois chantiers absents
> entrent en phase 1-B (portail sans CI ni test, TTL du GED hors danger zone,
> quotas dérivés du palier) ; le **§9 est entièrement refait** — valeur de
> reconstruction de la phase 1-A, coût de revient d'exploitation, marge par
> palier, points morts, TVA, sensibilité au taux. Total restant **206–265 →
> 212–275 j**.
> **v3.1 (2026-08-22)** — absorption des trois commits parallèles
> du chantier entitlement (D-R7). La ligne 2 de la phase 1-B rétrécit : migration
> constatée faite, QA visuelle jouée 16/16 et promue en harnais permanent. Deux
> effets de bord enregistrés (§4.3, §7.2). Total 206–266 → **206–265 j**.
> **v3.0 (2026-08-21)** — première rédaction. Quatre arbitrages porteur tranchés
> à l'écriture (§14, D-R1 à D-R4) : l'exploitation devient un chantier de phase
> 2, le durcissement de l'authentification rejoint la phase 1-B, les trois
> locales vendues et absentes seront livrées, et le document porte **deux**
> grilles commerciales au lieu d'une.

---

## Comment utiliser ce document

**Si vous prenez le relais sur une phase, lisez dans cet ordre :**

1. **§0 — Tableau de bord.** L'état réel de chaque phase. C'est la seule section
   qui fait foi sur l'avancement. Toute autre affirmation, dans un commit, un
   ticket ou une conversation, lui est subordonnée.
2. **§3 — La règle d'ordonnancement.** Elle explique *pourquoi* l'ordre est
   celui-là. Trois inversions y sont explicitement interdites.
3. **La section de la phase que vous prenez** (§4 à §8). Chaque ligne porte ce
   qui existe déjà, ce qui manque, et pourquoi elle est placée là.
4. **§14 — Journal des décisions.** Ne rouvrez une décision qu'en ajoutant une
   entrée datée, jamais en réécrivant l'ancienne.

**Quand vous terminez ou interrompez un chantier**, vous mettez à jour, dans le
même commit que le code :

- la ligne de la phase dans le **§0 Tableau de bord** ;
- la colonne **État** de la ligne concernée dans la section de sa phase ;
- une entrée dans le **§14 Journal des décisions** si vous avez tranché quelque
  chose.

Une ligne laissée en `EN COURS` sans état à jour est un chantier perdu pour la
personne suivante — y compris pour vous, trois semaines plus tard. C'est la seule
faute de procédure qui compte vraiment ici.

**Vue rendue.** Une version mise en page de ce document est publiée comme
artifact, régénérée depuis ce fichier aux jalons où elle doit être montrée. Ce
fichier fait foi ; la vue rendue est un instantané daté, jamais l'inverse.

---

## §0 — Tableau de bord des phases

> **Source de vérité de l'avancement produit.** À mettre à jour à chaque commit
> qui termine ou démarre un chantier de ce document.

| ID | Phase | État | Dépend de | Charge | Dernière MAJ |
|---|---|---|---|---|---|
| **1-A** | Le socle livré | `LIVRÉ` | — | — | 2026-08-21 |
| **1-B** | L'inachevé, à fermer | `EN COURS` | 1-A | 30–44 j | 2026-09-02 |
| **2** | Le socle de fabrication | `À FAIRE` | 1-B *(fixture recettée)* | 42–57 j | 2026-08-21 |
| **3** | L'ERP complet, sous filet | `À FAIRE` | 2 | 47–63 j | 2026-08-21 |
| **4-A** | Pédagogie & vie scolaire | `À FAIRE` | 3 | 20–28 j | 2026-08-21 |
| **4-B** | Infrastructure & industrialisation | `À FAIRE` | 2 *(contrat)*, 3 *(E2E)* | 71–80 j | 2026-08-21 |

**États autorisés** : `À FAIRE` · `EN COURS` · `BLOQUÉ (motif)` · `LIVRÉ` ·
`ABANDONNÉ (motif)`.

**Total hors application mobile native** : **210 à 272 jours·développeur**, soit
**15,75 à 20,40 M XAF** au taux du §9. L'application mobile (25–35 j) fait l'objet
d'un chiffrage séparé, comme dans la v2.

**La phase 1-A est chiffrée depuis la v4** — non comme un devis, mais comme une
**valeur de reconstruction** : **204 à 284 j**, soit 15,3 à 21,3 M XAF (§9.2). Le
livré et le reste-à-faire sont donc **du même ordre de grandeur**. Le programme
est à **43–57 % de sa charge totale**, et non aux quatre cinquièmes que suggère
un décompte de modules livrés.

**Chemin critique** : `1-B → 2 → 3 → 4-A`, soit **139 à 192 jours**. La voie 4-B
se mène en parallèle de la phase 3 dès que le contrat de plateforme de la phase 2
est acquis, et CH-3, CH-7 et le chantier d'exploitation de la phase 2 sont eux
aussi parallélisables. **Ce sont des charges, pas des délais** : à deux
intervenants, le calendrier se resserre d'environ un tiers sans que l'effort
diminue.

**Si une seule chose peut être financée** : `1-B` puis la **matrice d'isolation
campus** de la phase 2. Un défaut d'isolation entre établissements est le seul
bug de ce projet capable de coûter le produit entier.

---

## §1 — Ce que la v3 change

Quatre déplacements séparent ce document de `ERP_2026_v2.pdf`. Aucun n'est
cosmétique : chacun change ce qu'on construit ensuite, et dans quel ordre.

### 1.1 Le produit n'est plus un dépôt, c'est quatre briques

La v2 décrivait un « ERP » au singulier avec une pile technique unique. La
réalité est quatre dépôts git autonomes, dont deux consomment l'API du premier.
Une fonctionnalité n'est pas livrée tant que chaque consommateur ne l'a pas
suivie — c'est la contrainte de conception n° 1 de `CLAUDE.md`, et elle
renchérit toute évolution de contrat d'API.

### 1.2 Les phases ne sont plus commerciales, elles sont factuelles

« Fondations / Croissance / Premium » décrivait une ambition. Les cinq phases de
la v3 décrivent un état mesuré : **1-A** ce qui tourne, **1-B** ce qui est
commencé et pas fini, puis **2**, **3** et **4** pour ce qui n'existe pas —
rangées de sorte que ce qui sert à construire la suite passe devant ce qui se
contente d'être vendu.

### 1.3 Ce qui est vendu n'est plus une phase, c'est un palier

C'est la correction structurelle de fond. La v2 vendait des **phases de
développement** : « Phase 1 seule », « Phase 1+2 », « Phase 1+2+3 ». Un client ne
peut pas observer une phase, et rien dans le code ne savait en appliquer une.

Le registre d'entitlement, lui, déclare **trois paliers** que la plateforme sait
réellement faire respecter, gate par gate, campus par campus :

| Palier | Clés | Composition |
|---|---|---|
| `free` | **15** | Le noyau de 9 clés + `result` `subject` `course` `level` `department` `parent` |
| `standard` | **22** | `free` + `finance` `exam` `document` `announcement` `academic-print` `mentor` `staff` |
| `premium` | **26** | `standard` + `public-portal` `gaet` `partner` `ai` |

Les deux grilles du §10 s'adossent à ces trois paliers. Les phases redeviennent
ce qu'elles doivent être : un **calendrier de production**, interne, que le
client n'a pas à connaître.

### 1.4 Deux chantiers structurants apparaissent, absents de la v2

La **qualité vérifiable** (`QA_TEST_STRATEGY.md`) et la **livraison sous
licence** (`FEATURE_DELIVERY_DESIGN.md`) ne sont pas des fonctionnalités : ce
sont les conditions pour que les suivantes soient construisibles et vendables. La
v2 les chiffrait à zéro parce qu'elle ne les voyait pas. Elles pèsent ensemble
**101 à 121 jours** dans ce document — près de la moitié de la charge restante.

---

## §2 — Les quatre briques

Toute ligne de ce document est étiquetée par les briques qu'elle touche. Une
ligne marquée `B1·B2` n'est terminée que lorsque les deux dépôts sont à jour :
les valeurs d'énumération, les chaînes de statut et les codes d'erreur ont le
backend pour **source unique de vérité**.

| # | Brique | Chemin | Pile · port | Rôle |
|---|---|---|---|---|
| **B1** | Backend ERP | `university/backend` | Node · Express · Mongoose — `:5000` | L'API et la source de vérité de chaque énumération, statut et code d'erreur |
| **B2** | Frontend ERP | `university/frontend` | React · Vite · MUI — `:5173` | Le back-office signé : dix portails, de l'admin au mentor |
| **B3** | AI-service | `university/ai-service` | Python · FastAPI · pgvector — `:8000` | RAG, embeddings, chat. Joignable uniquement à travers B1 |
| **B4** | Portail public | `~/Projects/partner` ⚠️ | Next.js 15 · next-intl — `:3000` | Préinscription, programmes, quiz, concours, liens courts partenaires |

⚠️ Le portail public **ne vit pas** sous `university/`. Son dossier s'appelle
`partner`, il siège à côté de projets sans rapport, et rien sur le disque ne le
relie aux trois autres.

**Les quatre briques ne sont pas également instrumentées**, et ce document doit
le porter : chaque phase suivante s'appuie sur cet état (mesuré le 2026-08-22).

| Brique | Volume | Tests | Intégration continue | Conteneur | Version déclarée |
|---|---|---|---|---|---|
| **B1** backend | 78 255 l. de code · 17 425 l. de test | **1 407** en 68 suites — **3 rouges, instables** (§4.3) | `backend.yml` | — | `1.0.0`, figée |
| **B2** frontend | 82 629 l. · 23 813 l. de traduction | **0** — aucun outil installé | `frontend.yml` | — | `0.0.0` |
| **B3** ai-service | 8 583 l. | 19 fichiers | `ci.yml` | `Dockerfile` + compose | `0.1.0` |
| **B4** portail | 3 989 l. | **0** — aucun outil installé | **aucune** | — | — |

**B4 est la seule brique sans aucune chaîne d'intégration** — et la seule exposée
à un public non authentifié. Aucune ligne de la v3 ne lui en donnait avant la
phase 3 ; la v4 corrige (phase 1-B, ligne 13).

---

## §3 — La chaîne des phases et sa règle d'ordonnancement

```
  1-A ──▶ 1-B ──▶  2  ──▶  3  ──▶ 4-A
 livré   30–44 j  42–57 j  47–63 j  20–28 j
                     │                 
                     └──────▶ 4-B  (parallélisable dès le contrat acquis)
                              71–80 j
```

**La règle** : une ligne passe devant une autre si elle **réduit le coût ou le
risque** de celle-ci.

C'est pourquoi la matrice d'isolation campus précède le Mobile Money, et pourquoi
l'éclatement du registre de modules précède tout module nouveau : la première
rend le second démontrable, le troisième rend chaque module de phase 3 et 4
sensiblement moins cher à écrire.

**Trois inversions sont interdites**, chacune pour une raison mesurée :

1. **L'extracteur de snapshot avant le graphe de dépendances runtime.** Mongoose
   résout des modèles par nom à l'exécution. Le registre ne connaît pas ces
   arêtes, aucun test ne les épingle, et **l'une d'elles rend déjà le palier
   `free` non fonctionnel**. Bâtir l'extracteur d'abord, c'est industrialiser un
   défaut — et le faire *en silence*, puisque les validations passent.
2. **Les tests end-to-end avant que les parcours qu'ils figent soient stables.**
   Écrire les parcours canoniques avant la messagerie interne ou le Mobile Money,
   c'est les réécrire ensuite.
3. **L'agent d'exploration en premier.** C'est la tentation naturelle et c'est un
   transporteur écrit avant la chose à transporter : posé sur un frontend sans
   aucun test, il trouve de vrais défauts deux semaines, puis les noie sous les
   faux positifs et cesse d'être lu.

---

## §4 — Phase 1-A · Le socle livré

**État** : `LIVRÉ` · **Charge restante** : 0 j · **Portée** : les quatre briques

Ce que la v2 appelait « Phase 1 — Fondations, 26 modules, ~165 jours » est
dépassé sur presque tous les axes. **Trois chantiers majeurs livrés depuis n'y
figurent à aucun titre** : le module IA complet, l'entitlement commercial par
campus, et le système de suppression définitive.

Cette phase n'est délibérément **pas rechiffrée**. Le travail livré est un
acquis, pas une ligne de devis, et lui attribuer un nombre de jours rétrospectif
produirait un chiffre invérifiable.

### 4.1 Socle & sécurité

| Acquis | Briques | Ce que cela couvre |
|---|---|---|
| Isolation campus & RBAC 9 rôles | `B1·B2` | `buildCampusFilter()` fail-closed ; jamais de `campusId` issu du corps de requête pour un rôle scopé. Neuf rôles connectés, dont `PARTNER` et sa famille d'isolation **intra**-campus |
| Suppression douce harmonisée | `B1` | Trois conventions coexistantes (`status`, `isDeleted`, `deletedAt`), un helper qui dérive le filtre du modèle et **échoue** plutôt que de renvoyer un filtre vide |
| Suppression définitive — danger zone | `B1·B2` | Quatre contrôles obligatoires (ticket HMAC, phrase, mot de passe, motif), archive préalable, registre append-only, 15 entités, UI câblée sur les 15 |
| Entitlement commercial par campus | `B1·B2` | 26 clés, 32 montages, 7 crons, graphe de dépendances, gates dérivées du registre, trois états par module, pilotage depuis l'interface |

### 4.2 Académique

| Acquis | Briques | Ce que cela couvre |
|---|---|---|
| Scolarité complète | `B1·B2` | Campus, départements, niveaux, classes, matières, cours, étudiants, enseignants, parents, mentors, personnel — CRUD, archivage, filtres, pagination, import/export CSV |
| Résultats, transcripts, impression | `B1·B2` | Workflow Draft → Submitted → Published, barèmes, moyennes pondérées par coefficient, bulletins PDF verrouillés, signature parent, file d'impression persistée avec réclamation atomique |
| Examens SEMS | `B1·B2` | Banque de questions, sessions, inscriptions, passage en ligne, anti-triche nocturne, correction, appels, analytics sur worker, certificats à QR |
| GAET — génération d'emploi du temps | `B1·B2` | Machine à 7 états, worker sur fil isolé, service de conflits, reprise des zombies au démarrage, aperçu hebdomadaire |
| GED versionnée | `B1·B2` | Versions, publication, verrouillage, partage par lien signé, piste d'audit, QR d'authenticité, rétention hebdomadaire, corbeille |

### 4.3 Finance, communication, IA, public

| Acquis | Briques | Ce que cela couvre |
|---|---|---|
| Finance — frais, dépenses, recettes | `B1·B2` | Frais par étudiant, encaissements, ledger étudiant en libre-service, dépenses avec workflow d'approbation, recettes, balayage nocturne des impayés, tableau de bord campus |
| Notifications multi-canal | `B1·B2` | In-app, e-mail, gabarits, langue du destinataire depuis ses préférences, cron de reprise des envois externes toutes les 10 minutes |
| Module IA — chat, RAG, analytics narrés | `B1·B3·B2` | Passerelle inerte sans configuration, jeton S2S à courte durée, ingestion de la GED, recherche hybride RRF, chat SSE, budget consolidé et alerte à 80 %, métriques Prometheus, purge de rétention |
| Portail public & parrainage | `B4·B1` | Préinscription, programmes, quiz et classement, concours avec clôture mensuelle, liens courts `/r/{code}`, QR à la volée, anti-fraude unifiée, analytics QR contre lien |
| Thème clair / sombre & 10 locales | `B2·B4` | Fabrique de thème, jetons de statut comme source unique des surfaces, RTL, 10 locales × 18 espaces de noms |
| Socle de test — CH-0 & CH-1 | `B1` | **1 407 tests / 68 suites** — **instable au 2026-08-22** : deux exécutions complètes donnent 3 rouges chacune, mais **pas les mêmes** (pool Puppeteer du GED, service de stockage), voir §15. Un socle dont CH-2 à CH-6 dépendent se tient vert **et reproductible** ; celui-ci n'est ni l'un ni l'autre aujourd'hui ; fixture déterministe de 2 campus, 283 documents, 31 collections, 127 assertions, 18 comptes couvrant les 9 rôles, base éphémère sans MongoDB installé |
| Deux harnais hors Jest | `B1·B2` | `npm run test:journey` (21 contrôles, vraie base, replica set jetable, l'app réelle) et `npm run test:visual` (16 contrôles, SPA **buildée** servie en statique, Chrome sans tête via `puppeteer-core`) — ce dernier couvre **2 portails sur 8**, campus et enseignant. Nés du chantier entitlement, ils sont le premier précédent E2E du dépôt |

---

## §5 — Phase 1-B · L'inachevé, à fermer avant tout le reste

**État** : `EN COURS` · **Charge** : **30–44 j** · **Dépend de** : 1-A

C'est la phase la plus rentable du document, et la moins visible. Chaque ligne
est un travail déjà payé à 70–90 % **dont la valeur reste nulle tant que la
dernière fraction manque** : un canal WhatsApp qui n'enverra jamais rien en
production, un pipeline de préinscription qui ne crée aucun étudiant, une
migration d'entitlement jamais lancée sur la base réelle.

Les quatre premières lignes sont des **dépendances directes de la phase 2**.

| # | Chantier | Briques | Ce qui existe déjà | Ce qui manque | Charge | État |
|---|---|---|---|---|---|---|
| 1 | Fixture déterministe (CH-0) | `B1` | Seed reproductible, empreinte SHA-256 identique d'une exécution à l'autre, 9 rôles qui se connectent réellement | Recette par une seconde personne ; arbitrage mémoire contre conteneur en CI ; 8 collections non seedées — GAET, notifications, préférences, file d'impression, transcripts finaux, pièces jointes GED — que les parcours E2E réclameront | 2–3 j | `À FAIRE` |
| 2 | Entitlement par campus | `B1·B2` | Six phases livrées. **Migration faite le 2026-08-20** (constatée le 21 : `--dry-run` rapporte 3 skip, audit `actorRole: SYSTEM`, même horodatage à la milliseconde sur les trois campus). **QA visuelle faite le 2026-08-22, 16/16** (`npm run test:visual`), et promue en harnais permanent | Dans cet ordre : (1) étendre `test:visual` aux portails non rendus — **le portail étudiant l'est depuis le 2026-09-02** (D-R18), restent **parent, mentor, staff** — seul contrôle capable de fermer la case §4.1.2 de la DoD, et le seul qui épingle la correspondance route ↔ garde, silencieuse dans les deux sens ; (2) **ensuite seulement**, retrait de `features` / `aiEntitlement` du schéma et de la route `ai-entitlement`, qui n'a plus de client depuis la phase 4 | 1 j | `À FAIRE` |
| 3 | Authentification — durcissement | `B1·B2` | JWT sur 9 rôles, bcrypt 12 tours, limiteur de débit sur les points de connexion, flux d'activation par jeton | Jetons de rafraîchissement, **révocation côté serveur** — aucun mécanisme n'existe aujourd'hui, un jeton volé vaut 7 jours — et verrouillage temporaire de compte après échecs répétés | 3–4 j | `À FAIRE` |
| 4 | Module IA — sortie de conception | `B1·B3` | M0 à M6 livrés, tests verts des deux côtés, charge mesurée sous SLO en local | QA visuelle réelle de l'UI, SLO du chat mesuré sur l'infrastructure cible, benchmark d'embedding hors ligne avant de figer l'index de production | 2–3 j | `À FAIRE` |
| 5 | Portail d'inscription en ligne | `B1·B4` | Pipeline de prospects en 7 statuts jusqu'à `enrolled`, anti-fraude, lien court et QR | Pièces jointes au dossier, workflow de validation directeur, **création effective de l'étudiant** au passage à `enrolled` — aujourd'hui seule la commission partenaire se déclenche — et notification du candidat | 3–4 j | `À FAIRE` |
| 6 | Frais — reçus et échéancier | `B1·B2` | Reçu PDF rendu à la demande (`GET /finance/payments/:id/receipt`, langue de l'**étudiant**, pool Puppeteer partagé) ; cadence avant échéance J-7 / J-3 / Jour J sur son propre marqueur `remindersSent[]` ; les deux briques câblées, i18n × 10 | **Rien — les dix étapes du §12 sont tenues.** L'étape 10 a été jouée le 2026-09-02 et **écrite dans `npm run test:visual`** plutôt que passée à la main (précédent D-R7) : le harnais passe de 16 à **36 contrôles**, tous verts — deux thèmes par la *préférence* de l'utilisateur, `CAMPUS_MANAGER` + `STUDENT`, et les trois états d'entitlement dont `hidden`, refusé tant que le module porte des écritures et donc **vu** sur un campus vidé des siennes. Elle a trouvé un défaut que rien d'autre ne pouvait voir : le nom du reçu ne survivait pas au cross-origin (§9⑲ de la note), corrigé et fermé par un test vu rouge. 1 566 tests verts. Détail : `docs/architecture/features/fee-receipts-and-reminders.md` §9⑲ | 2–3 j | `LIVRÉ` |
| 7 | Notifications WhatsApp Business | `B1` | Canal Meta Cloud API en appel natif, inerte sans jeton, préférence par utilisateur | Gabarits approuvés par Meta — obligatoires hors de la fenêtre de 24 h, donc pour la quasi-totalité des envois ERP ; consentement explicite ; webhook de statut ; câblage des quatre événements vendus | 2–3 j | `À FAIRE` |
| 8 | Journal d'audit transverse | `B1` | Trois registres append-only : audit documentaire, registre de suppression, historique de statut des prospects | Journal unique de toutes les mutations post-publication, export d'audit, rétention configurable par campus. **Traite l'écart 3 du §11** | 3–4 j | `À FAIRE` |
| 9 | Dossiers RH enseignants | `B1·B2` | GED versionnée, documents rattachés à l'enseignant, champ `expiresAt` déclaré | Catégorie RH dédiée ; **prévenir au lieu de supprimer** — le seul mécanisme d'expiration disponible est un index TTL, et c'est ce chantier qui l'armerait : lire la ligne 14 avant d'écrire une date d'expiration sur un document ; historique des modifications de poste | 2–3 j | `À FAIRE` |
| 10 | Orientation & suivi scolaire | `B1·B2` | Détection précoce déjà calculée par les analytics d'examen et le service de résultats | Notes de suivi par élève, signalement explicite, recommandations d'orientation, restitution dans les portails parent et mentor | 2–3 j | `À FAIRE` |
| 11 | Catalogue de langues — **et sa réconciliation entre briques** | `B2·B4` | B2 : 10 locales × 18 espaces de noms, RTL fonctionnel, sélecteur et préférence utilisateur. B4 : **8 locales**, dont **le latin déjà livré et complet** (`partner/src/messages/la.json`, 288 lignes comme toutes les autres) | **Les deux catalogues divergent, et personne ne l'avait relevé** : 5 codes strictement communs, `zh-CN` sur B2 contre `zh` sur B4, `el` livré sur B4 et vendu nulle part, `es`/`ja`/`pt`/`ru` absents de B4. Manquent sur B2 : lingala, haoussa **et latin** (36 + 18 fichiers, ce dernier traduisible depuis B4) ; sur B4 : lingala et haoussa. Plus l'arbitrage du catalogue canonique et l'alignement des codes de locale entre les deux briques. **Traite l'écart 2 du §11** (D-R9) | 5–7 j | `À FAIRE` |
| 12 | Import / export — volet tableur | `B1·B2` | CSV en lecture et en écriture partout : étudiants, enseignants, résultats, prospects | Lecture et écriture XLSX. La v2 inclut « migration depuis CSV/Excel » dans chaque palier et annonce un export Excel du tableau de bord financier ; aucune dépendance tableur n'est installée | 1–2 j | `À FAIRE` |
| 13 | Portail public — intégration continue et socle de test | `B4` | Application Next.js 15 livrée : 3 989 lignes, 8 locales, tunnel de préinscription, anti-fraude, liens courts, agent de service et manifeste | **Aucun test et aucune chaîne d'intégration** — seule brique dans ce cas, et **seule brique exposée à un public non authentifié**. Vitest et un socle minimal sur le tunnel et l'anti-fraude, plus un `ci.yml` aligné sur les trois autres. Sans quoi B4 n'est couvert qu'à la phase 3, par CH-4 | 2–3 j | `À FAIRE` |
| 14 | GED — l'expiration TTL contourne la danger zone | `B1` | Suppression définitive harmonisée (`shared/lib/hard-delete/`) ; teardown complet du GED dans `document.service.hardDeleteDocument` — fichier importé, instantané PDF, QR, instantanés de **chaque** version, liens de partage, ré-ingestion ai-service | `document.model.js` déclare `index({ expiresAt: 1 }, { expireAfterSeconds: 0 })`. **Aucun code n'écrit ce champ aujourd'hui : le piège est armé, pas déclenché.** Le jour où il l'est, Mongo retire la ligne **hors** du seul chemin de suppression autorisé (§5.2 de `CLAUDE.md`) : rien ne nettoie les fichiers, rien ne purge les liens de partage, rien ne ré-ingère côté IA, et **aucune ligne n'arrive au registre de suppression**. Soit le champ est retiré, soit son expiration passe par le service | 1–2 j | `À FAIRE` |
| 15 | Quotas dérivés du palier | `B1·B2` | `Campus.quotas` réellement appliqué par `canAddStudent` / `canAddTeacher` / `canAddClass` / `canAddDocumentStorage` | **La grille du §10 vend au-dessus de ce que le code applique** : elle facture « par campus de **2 000 élèves** » et « hébergement **≤ 20 Go** » quand `DEFAULT_QUOTAS` vaut **1 000 élèves et 5 Go** — le 1 001ᵉ élève et le 5,1ᵉ Go sont refusés à un client qui a payé pour le double et le quadruple. Les quotas sont aujourd'hui une dérogation par campus, jamais une propriété du palier : les dériver de `PLAN_PRESETS`, ou aligner la grille (D-R10) | 1–2 j | `À FAIRE` |

**Total Phase 1-B : 30–44 j** — *la v3 annonçait 26–37 j ; l'audit de la v4 a
ajouté trois lignes (13 à 15) et élargi la ligne 11 (32–47 j) ; la **ligne 6 est
livrée** le 2026-09-02 et sort du restant (−2 à −3 j).*

---

## §6 — Phase 2 · Le socle de fabrication

**État** : `À FAIRE` · **Charge** : **42–57 j** · **Dépend de** : 1-B (fixture recettée)

Aucune ligne de cette phase n'est vendable en démonstration, et c'est la seule
qui rende les deux suivantes finançables. Elle répond à trois questions
auxquelles le projet ne sait aujourd'hui **pas** répondre :

- *La frontière entre établissements tient-elle ?*
- *Quelle version un client exécute-t-il ?*
- *Combien coûte l'ajout du prochain module ?*

| # | Chantier | Briques | Contenu | Pourquoi ici et pas plus tard | Charge | État |
|---|---|---|---|---|---|---|
| 1 | Matrice API — auth · rôle · isolation (CH-2) | `B1` | 547 routes × 9 rôles = 180 contextes, cinq familles de cas, table de routes **générée** et non écrite à la main, exécution en secondes, bloquante en intégration continue | Meilleur rapport risque évité sur effort de tout le document. La table de routes qu'elle produit alimente ensuite les tests de composant, la documentation d'API et le scan de sécurité — trois chantiers pour le prix d'un | 5–10 j | `À FAIRE` |
| 2 | Contrat de plateforme | `B1·B2` | Étiquettes git, version produit réelle, déclaration des zones libres et du tronc, règle de lint refusant un import hors surface publique | **388 commits sur les quatre briques, zéro étiquette, `package.json` figé à `1.0.0` côté backend et `0.0.0` côté frontend** : rien ne nomme aujourd'hui la version d'une installation. Toute la mécanique de livraison en dépend, et un correctif de sécurité ne sait pas à qui il s'applique | 4 j | `À FAIRE` |
| 3 | Éclatement du registre + graphe runtime | `B1·B2` | Chaque module déclare son entrée, ses montages, ses crons, ses modèles et ses dépendances dans son propre dossier ; agrégateur à échec bruyant ; déclaration des arêtes que Mongoose résout par nom | Le graphe déclaré est **incomplet** : deux arêtes non déclarées rendent déjà le palier `free` non fonctionnel, en silence. Et tant que le registre est un fichier du tronc, chaque module nouveau — donc chaque ligne des phases 3 et 4 — coûte la modification de six listes centrales | 7 j | `À FAIRE` |
| 4 | Exploitation — sauvegardes, reprise, supervision | `B1·B2·B3·B4` | Sauvegarde MongoDB quotidienne automatisée avec rétention 30 j et **restauration testée** ; procédure de bascule documentée (RPO < 24 h, RTO < 4 h) ; supervision de disponibilité ; conteneurisation des trois briques qui en sont dépourvues ; chaîne d'intégration et de déploiement complète | **C'est un engagement contractuel déjà vendu** dans le prix SaaS mensuel — SLA 99,5 %/mois — et un prérequis de la licence on-premise. **Trois briques sur quatre ont une chaîne d'intégration** (`backend.yml`, `frontend.yml`, `ci.yml`) — le portail public n'en a aucune (fermé en phase 1-B, ligne 13). Restent entiers : **aucun script de sauvegarde**, aucune restauration jamais testée, aucune supervision, et un conteneur qui n'existe que pour la brique IA. **Traite l'écart 5 du §11** (D-R1) | 8–12 j | `À FAIRE` |
| 5 | Documentation d'API | `B1` | Spécification OpenAPI **dérivée** de la table de routes produite par CH-2, publiée et vérifiée en intégration continue | La v2 vend « architecture REST documentée » et « intégration externe possible » ; **aucune spécification exploitable par une machine n'existe**. Le seul contrat écrit — `partner/docs/api-contract.md`, la surface `/api/public/*`, vérifiée de bout en bout le 2026-06-07 — vit **dans la brique cliente** : il dérive en silence dès que B1 bouge, et ne couvre que 1 % des routes. Il sert d'amorce et de modèle de rédaction, pas de socle. Dérivée de CH-2, la spécification coûte une fraction de ce qu'elle coûterait écrite à la main — d'où sa place juste après. **Traite l'écart 6 du §11** | 3–4 j | `À FAIRE` |
| 6 | Tests de composant frontend (CH-3) | `B2` | Vitest, Testing Library, interception réseau ; priorité aux schémas de validation, aux garde-fous de rôle et aux écrans de suppression | **265 fichiers de composants, zéro test, aucun outil installé** : le plus grand angle mort du projet. Chaque fonctionnalité des phases 3 et 4 ajoute des écrans à un ensemble non couvert | 10–15 j | `À FAIRE` |
| 7 | Revue d'architecture — passage à l'échelle (CH-7) | `B1` | Les 7 crons ne survivent pas à une réplication horizontale ; le limiteur de débit n'est partagé entre instances que si Redis est configuré ; instruction des points de contention | Parallélisable dès aujourd'hui, et **aucun agent ni aucun test ne trouvera ces défauts** : ils ne se manifestent qu'au second processus. Les corriger après avoir doublé le nombre de crons coûte davantage | 5 j | `À FAIRE` |

**Total Phase 2 : 42–57 j**

---

## §7 — Phase 3 · L'ERP complet, sous filet

**État** : `À FAIRE` · **Charge** : **47–63 j** · **Dépend de** : 2

C'est la phase que le marché juge. Elle ferme les huit fonctionnalités que la v2
annonce en « Croissance » et qui n'existent à aucun degré — Mobile Money en tête,
qui figure pourtant en page 2 comme argument différenciant.

**L'ordre interne compte** : les fonctionnalités d'abord, le filet ensuite, pour
que les parcours end-to-end figent une surface stable plutôt que d'être réécrits
à chaque ajout.

### 7.1 Voie 1 · Les huit manques métier

| # | Fonctionnalité | Briques | Contenu | Charge | État |
|---|---|---|---|---|---|
| 1 | Mobile Money MTN & Orange | `B1·B2` | Intégration des deux API camerounaises, réconciliation automatique, détection d'anomalies, alertes de fraude. Aujourd'hui « Mobile Money » n'est qu'une **valeur d'énumération** sur le mode de paiement : aucun appel réseau, aucun rapprochement. **Traite l'écart 1 du §11** | 6–8 j | `À FAIRE` |
| 2 | Rapprochement manuel des paiements | `B1·B2` | Validation par un administrateur quand le rappel opérateur échoue — cas fréquent sur ces API. Journal horodaté, justificatif PDF | 1–2 j | `À FAIRE` |
| 3 | Messagerie interne | `B1·B2` | Fil sécurisé directeur ↔ enseignant ↔ parent ↔ étudiant, pièces jointes, accusé de lecture. Le module de notifications est **unidirectionnel** : il n'existe aujourd'hui aucune notion de conversation | 4–6 j | `À FAIRE` |
| 4 | Carnet de correspondance numérique | `B1·B2` | Remplace le carnet papier, signature numérique du parent, historique, rappels automatiques | 3–4 j | `À FAIRE` |
| 5 | Bourses et aides financières | `B1·B2` | Enregistrement des bourses d'État et privées, déduction automatique sur les frais dus, historique par étudiant | 2–3 j | `À FAIRE` |
| 6 | Congés & absences du personnel | `B1·B2` | Demande en ligne, validation directeur, solde, suggestion de remplacement si un cours est planifié, liaison à l'emploi du temps | 4–6 j | `À FAIRE` |
| 7 | Paie des enseignants | `B1·B2` | Calcul sur les heures livrées, bulletin PDF, intégration des présences et du contrat. **`TeacherSchedule` n'est pas un modèle libre** : 17 fichiers le référencent — GAET l'écrit à la publication (`syncTeacherSchedule`), `teacher.service` en maintient le miroir, les sessions d'examen s'y répercutent par référence, et le portail personnel le liste. Ce qui manque n'est pas le modèle mais **l'agrégation d'heures livrées** au-dessus : la paie s'y branche en lecture et n'en devient pas propriétaire | 4–5 j | `À FAIRE` |
| 8 | Rapports officiels d'inspection | `B1·B2` | Génération des états statistiques exigés par la tutelle : effectifs, résultats, présences, enseignants. Le dépôt n'en contient aujourd'hui qu'une **mention**, dans un gabarit de bulletin | 3–4 j | `À FAIRE` |

### 7.2 Voie 2 · Le filet, une fois la surface stable

| # | Chantier | Briques | Contenu | Charge | État |
|---|---|---|---|---|---|
| 9 | End-to-end déterministe (CH-4) | `B1·B2·B4` | 30 à 60 parcours canoniques sous Playwright, captures de référence, bloquant en intégration continue. **Précédent acquis** : `test:visual` prouve déjà qu'on sait servir la SPA buildée et la piloter sans tête sur la fixture, et a payé deux pièges de mesure — le tiroir est un rail à groupes repliés, et `AppShell` persiste leur état, ce qui rendait un comptage aléatoire d'un run à l'autre. Reste l'écart d'échelle : 16 contrôles sur 2 portails contre 30–60 parcours sur 4 briques avec captures de référence | 10–15 j | `À FAIRE` |
| 10 | Charge · performance · sécurité · accessibilité (CH-6) | `B1·B2·B3·B4` | Quatre disciplines, quatre outils dédiés : plan de charge, budgets de performance, scan de sécurité alimenté par la table de routes, audit d'accessibilité | 10 j | `À FAIRE` |

**Total Phase 3 : 47–63 j**

---

## §8 — Phase 4 · Premium & autonomie commerciale

**État** : `À FAIRE` · **Charge** : **91–108 j** · **Deux voies parallélisables**

La dernière phase n'est pas un fourre-tout : c'est ce qui ne peut honnêtement
être construit qu'après. La voie A suppose une plateforme dont les parcours ne
régressent plus ; la voie B suppose un contrat de plateforme versionné et un
registre éclaté, sans lesquels **chaque installation client modifierait le tronc
et se déclasserait elle-même**.

### 8.1 Voie A · Pédagogie & vie scolaire — 20–28 j

| # | Fonctionnalité | Briques | Contenu | Charge | État |
|---|---|---|---|---|---|
| 1 | Bibliothèque numérique | `B1·B2` | Dépôt de cours PDF et vidéo par l'enseignant, accès structuré par classe. Un dépôt pédagogique organisé, pas une plateforme de cours en ligne | 4–5 j | `À FAIRE` |
| 2 | Devoirs & rendu en ligne | `B1·B2` | Publication avec échéance, soumission de fichier par l'étudiant, note reversée dans le module de résultats | 5–7 j | `À FAIRE` |
| 3 | Suivi des compétences | `B1·B2` | Progression par compétence, visualisation en radar par étudiant, adapté aux programmes par approche compétences | 5–7 j | `À FAIRE` |
| 4 | Sanctions & discipline | `B1·B2` | Incidents, sanctions, avertissements, notification automatique du parent, historique par élève | 2–3 j | `À FAIRE` |
| 5 | Calendrier d'événements & galerie | `B1·B2` | Réunions de parents, sorties, cérémonies ; galerie par événement, parents notifiés | 2–3 j | `À FAIRE` |
| 6 | Module alumni | `B1·B2·B4` | Suivi des anciens, répertoire, statistiques d'insertion. Base d'un réseau et d'un canal marketing | 2–3 j | `À FAIRE` |

### 8.2 Voie B · Infrastructure & industrialisation — 71–80 j

| # | Chantier | Briques | Contenu | Charge | État |
|---|---|---|---|---|---|
| 7 | Mode hors-ligne | `B2` | Application installable, fonctionnement sans réseau, synchronisation différée. **Aucun outillage n'est installé sur B2** — ni manifeste, ni agent de service. **B4 porte déjà les trois** (`public/sw.js`, `src/app/manifest.ts`, `ServiceWorkerRegistration.tsx`) : c'est un précédent à reprendre, et un passif à traiter au passage — un agent de service en production sur le portail public est un cache qu'il faut savoir invalider, et personne ne l'a jamais eu à faire | 6–9 j | `À FAIRE` |
| 8 | Tableau de bord éditeur | `B1·B2` | Vue cross-campus : revenu récurrent, campus actifs, usage par module — les compteurs existent déjà dans le registre d'entitlement — alertes de santé serveur | 4–5 j | `À FAIRE` |
| 9 | Agent d'exploration (CH-5) | `B1·B2` | Parcours nocturne des 180 contextes avec jugement de rendu, **jamais bloquant**, alimente les parcours E2E en spécifications. Un cinquième du dispositif de test, et le dernier | 10–15 j | `À FAIRE` |
| 10 | Licence & vérification | `B1` | Paire de clés **asymétrique** — toute la cryptographie du dépôt est aujourd'hui symétrique — émetteur hors ligne, vérificateur embarqué, lecture des quotas. La licence s'applique à l'installation, **jamais à l'exécution** : une licence illisible n'éteint pas l'ERP d'une université | 4 j | `À FAIRE` |
| 11 | Extracteur de snapshot | `B1·B2` | Taille un build par palier sur deux briques, élague les dépendances, pré-calcule les verrous, produit un manifeste signé. Le même outil sert dans les deux sens : tailler un palier et empaqueter un module | 10 j | `À FAIRE` |
| 12 | ABI de plugin | `B1·B2` | Six listes rendues contributives : montage des routeurs, crons, modèles, suppression définitive, navigation frontend, espaces de noms i18n. Test d'acceptation mécanique : retirer puis réinstaller un module doit rendre un arbre **identique au bit près** | 13 j | `À FAIRE` |
| 13 | Runner client & porte d'installation | `B1·B2` | Diagnostic, essai à blanc, **reconstruction du frontend chez le client** — l'étape qu'on oublie et qui fait échouer le reste — migrations expand-only réversibles, double journal d'audit. Le vendeur ne détient aucun accès : tout fonctionne hors ligne | 12 j | `À FAIRE` |
| 14 | Catalogue & bords | `B1·B2` | Écran de catalogue, badges calculés, historique, désinstallation, double écriture i18n, navigation contributive sur les dix portails | 8 j | `À FAIRE` |
| 15 | Canal de correctifs de sécurité | `B1` | Delta de tronc signé, vérification d'empreinte, porte allégée, diffusion à toute la flotte. **Gratuit et prioritaire** : un modèle qui monnaie ses correctifs de sécurité ne survit pas au premier incident public | 4 j | `À FAIRE` |

### 8.3 Hors phase — application mobile native

**25 à 35 j, chiffrage séparé.** Parents et étudiants, notifications poussées,
deux magasins d'applications. Comme dans la v2, elle n'entre pas dans le total :
son périmètre dépend d'arbitrages de publication qui ne sont pas rendus.

---

## §9 — Coûts : production, reconstruction, exploitation

> **Refait en v4.** La v3 ne portait qu'un tableau : la charge restante,
> multipliée par un taux journalier hérité. Il manquait trois choses sans
> lesquelles aucune décision commerciale n'est prenable — **ce que vaut le code
> déjà livré**, **ce que coûte de le faire tourner**, et **à partir de combien de
> campus l'ensemble se rembourse**. Le §10 vend un abonnement mensuel avec un
> engagement de service ; jusqu'ici, rien en face ne portait un coût.

### 9.1 Le taux, la devise, et ce qu'ils portent

| Paramètre | Valeur | Source |
|---|---|---|
| Taux journalier | **75 000 XAF** / jour·développeur senior | Repris de la v2, jamais recalculé (D-R6) |
| Parité euro | **1 € = 655,957 XAF** | Parité fixe du franc CFA — non révisable |
| Parité dollar | **≈ 610 XAF** *(hypothèse)* | Taux flottant — **à re-vérifier avant tout engagement** |
| TVA | **19,25 %** (Cameroun) | Tous les prix de ce document sont **hors taxes** |

Au taux retenu, un jour·développeur vaut **114 €**. C'est le multiplicateur de
tout ce qui suit : il porte à lui seul une trentaine de millions de francs, et il
n'a jamais été discuté. Sa sensibilité est donnée en §9.7.

**Ce que le taux inclut** : la production, sa recette et sa documentation.
**Ce qu'il n'inclut pas** : l'exploitation (§9.4), la vente, le support de niveau
2 et 3, et les coûts non salariaux de la production elle-même (§9.5).

### 9.2 Phase 1-A — valeur de reconstruction

La v3 refusait de chiffrer le livré, au motif qu'un nombre rétrospectif serait
invérifiable. Le motif est juste **pour un devis** ; il ne l'est pas pour les
trois usages où le porteur a besoin du chiffre : **valoriser l'actif**, **fixer
un prix plancher de licence** (le §10.2 vend une licence perpétuelle de 3 à
11,5 M XAF sans savoir ce que le code a coûté), et **répondre à une diligence**.

La v4 le chiffre donc — comme une **valeur de reconstruction au taux du marché** :
ce qu'il en coûterait de faire rebâtir l'existant, à périmètre égal, par une
équipe qui ne l'a pas écrit. Trois ancres indépendantes ont été posées ; elles ne
concordent pas, et **c'est le désaccord qui dit laquelle retenir**.

| Ancre | Méthode | Résultat | Verdict |
|---|---|---|---|
| **A — calendrier** | 2026-01-14 → 2026-08-22 sur les quatre dépôts, 388 commits, 7,3 mois | ~152 j à une personne à plein temps (21 j ouvrés/mois) | **Plancher.** Mesure une capacité, pas un périmètre : elle serait identique si la moitié du code n'existait pas |
| **B — volume** | 190 881 lignes de code livrées (78 255 B1 + 17 425 tests B1 + 82 629 B2 + 8 583 B3 + 3 989 B4) + 23 813 lignes de traduction, à 200–400 lignes/jour | **477 – 954 j** | **Écartée.** La norme intègre des frais d'organisation que ce projet ne porte pas, et 10 locales × 18 espaces gonflent le décompte sans effort proportionnel |
| **C — comparables** | Chaque bloc livré chiffré **au taux que la v3 applique déjà à un travail équivalent** (une fonctionnalité métier sur socle existant : 3–5 j ; un chantier structurant : 7–13 j) | **204 – 284 j** | **Retenue.** Seule méthode homogène avec le reste du document : le livré et le restant sont chiffrés à la même règle |

**Détail de l'ancre C** — le découpage suit le §4, bloc pour bloc :

| Bloc livré | Briques | j |
|---|---|---|
| Socle & sécurité — isolation campus, RBAC 9 rôles, authentification, activation par jeton, suppression douce dérivée, danger zone 15 entités + UI | `B1·B2` | 25–35 |
| Entitlement commercial par campus — 26 clés, 32 montages, 7 crons, graphe, gates, trois états, pilotage, i18n, 2 harnais | `B1·B2` | 18–25 |
| Académique — 11 domaines CRUD complets, archivage, filtres, pagination, import/export CSV | `B1·B2` | 22–33 |
| Résultats, transcripts, impression — workflow 3 états, barèmes, moyennes pondérées, PDF verrouillés, file d'impression à réclamation atomique | `B1·B2` | 12–16 |
| Examens SEMS — banque, sessions, passage en ligne, anti-triche, correction, appels, analytics sur worker, certificats à QR | `B1·B2` | 15–20 |
| GAET — 7 états, worker isolé, service de conflits, reprise des zombies | `B1·B2` | 12–16 |
| GED versionnée — versions, publication, verrouillage, partage signé, audit, QR, rétention, corbeille | `B1·B2` | 12–16 |
| Finance — frais, encaissements, dépenses à approbation, recettes, ledger étudiant, cron impayés, tableau de bord | `B1·B2` | 10–14 |
| Notifications multi-canal — 3 canaux, gabarits, langue du destinataire, cron de reprise | `B1·B2` | 6–9 |
| Module IA M0→M6 — brique Python complète, module Node, entitlement IA, RAG hybride, chat SSE, observabilité, budget | `B1·B3·B2` | 25–35 |
| Portail public & parrainage — brique Next.js entière, backend public, quiz, concours, liens courts, anti-fraude | `B4·B1` | 15–20 |
| Thème clair/sombre & 10 locales × 18 espaces — 23 813 lignes de traduction | `B2·B4` | 10–14 |
| Socle de test CH-0 & CH-1 — 68 suites, fixture déterministe, 2 harnais hors Jest | `B1` | 12–16 |
| Migration monolithe → modulaire — 22 modules, 26 shims résorbés | `B1` | 10–15 |
| **Total phase 1-A** | | **204–284 j** |

**Valeur de reconstruction : 15,30 – 21,30 M XAF** (23 300 – 32 500 €).

**Ce que ce chiffre est, et n'est pas.** C'est une valeur de **remplacement** au
taux du marché. Ce n'est **ni** un coût historique — le livré n'a pas été produit
à ce rythme ni dans ces conditions —, **ni** une valeur comptable, **ni** un
devis opposable. Il se cite pour fixer un plancher de licence, valoriser l'actif
ou instruire une diligence ; il ne se facture pas.

**Le résultat qui compte** : l'ancre C place le livré à **204–284 j** et le
restant à **210–272 j**. Les deux sont **du même ordre**. Compter les modules
donne l'impression d'un produit aux quatre cinquièmes fait ; compter la charge
le place à **43–57 %**. Les deux tiers du restant ne sont d'ailleurs pas des
fonctionnalités (§9.3) — ce que la v2 chiffrait à zéro.

### 9.3 Charge et coût de production restants

| Phase | Nature | Charge | Cumul | Coût |
|---|---|---|---|---|
| **1-A** | Acquis — **valeur de reconstruction**, §9.2 | *(204–284 j)* | — | *(15,30–21,30 M XAF)* |
| **1-B** | Quinze chantiers, dont un livré | 30–44 j | 30–44 j | 2,25–3,30 M XAF |
| **2** | Vérifiabilité, versionnage, exploitation | 42–57 j | 72–101 j | 3,15–4,28 M XAF |
| **3** | Huit manques métier + non-régression | 47–63 j | 119–164 j | 3,53–4,73 M XAF |
| **4** | Pédagogie + industrialisation | 91–108 j | 210–272 j | 6,83–8,10 M XAF |
| | **Total restant, hors mobile** | **210–272 j** | | **15,75–20,40 M XAF** |
| *hors total* | Application mobile native | 25–35 j | | 1,88–2,63 M XAF |
| | **Programme complet — 1-A incluse** | **414–556 j** | | **31,05–41,70 M XAF** |

**Répartition par nature de travail** — utile pour arbitrer ce qui est
externalisable :

| Nature | Charge | Part |
|---|---|---|
| Fonctionnalités métier vendables | 57–80 j | ~28 % |
| Dispositif de test (**CH-2 à CH-7**) | 50–70 j | ~25 % |
| Machinerie de livraison sous licence | 51 j | ~21 % |
| Fermeture de l'inachevé (1-B) | 30–44 j | ~15 % |
| Exploitation, contrat, registre, documentation | 22–27 j | ~10 % |

Les cinq natures recomposent **exactement** le total (210–272 j) : aucune ligne
n'est comptée deux fois ni oubliée. *La v3 intitulait la deuxième nature « CH-2 à
CH-6 » tout en y comptant les 5 jours de CH-7, qui n'apparaissaient dans aucune
autre — l'intitulé est corrigé, pas le chiffre.* **Deux tiers de la charge
restante ne sont pas des fonctionnalités** : c'est le constat central de cette
feuille de route.

### 9.4 Coût de revient d'exploitation — ce que le §10 n'avait pas

Le §10 vend un abonnement mensuel adossé à un engagement de service (99,5 %/mois,
stockage inclus, support L1 < 4 h) sans qu'aucune charge lui réponde. Une grille
de prix sans coût de revient n'est pas une grille.

Les coûts ci-dessous sont calculés sur **l'unité vendue** — un campus de 2 000
élèves — et non sur le quota que le code applique aujourd'hui (1 000 élèves,
5 Go). C'est délibéré : la grille se tarife sur ce qu'elle promet. Si D-R10 est
tranchée en alignant la grille sur le code plutôt que l'inverse, **les coûts
marginaux de ce tableau baissent à peu près de moitié, et les marges montent**.

> **Statut des chiffres de cette section.** Ce sont des **hypothèses de tarifs
> publics, en ordre de grandeur**, posées pour rendre l'arithmétique vérifiable —
> pas des relevés. Chaque ligne est à confirmer auprès du fournisseur avant tout
> engagement, exactement comme le §15 l'exige des mesures de code. **L'important
> ici n'est pas le montant, c'est la structure** : un socle fixe, un coût
> marginal par campus, et un poste qui domine tous les autres.

**Socle de plateforme** — fixe, indépendant du nombre de campus :

| Poste | Hypothèse | XAF / mois |
|---|---|---|
| MongoDB en jeu de réplicas géré (3 nœuds, 10 Go) | ~57 $ | 34 800 |
| VPS applicatif Node (2 vCPU / 4 Go) | ~20 € | 13 100 |
| Frontend statique + portail Next.js | ~20 $ | 12 200 |
| Conteneur ai-service (4 Go) | ~25 € | 16 400 |
| Postgres + pgvector, résidence UE (D4) | ~19 $ | 11 600 |
| Sauvegardes externalisées + supervision | ~15 $ | 9 200 |
| Domaine + certificats | ~2 $ | 1 200 |
| **Total socle** | | **≈ 98 500** |

**Coût marginal par campus** (2 000 élèves), par palier :

| Poste | Essentiel | Standard | Premium |
|---|---|---|---|
| Stockage documentaire + diffusion | 1 200 | 3 500 | 5 000 |
| E-mails transactionnels (~10 000/mois) | 900 | 900 | 900 |
| Jetons LLM au plafond du budget *(200 k / 1 M / 5 M)* | — | — | 20 100 |
| Support L1 < 4 h — 1 agent chargé pour 20 campus | 20 000 | 20 000 | 20 000 |
| **Sous-total hors WhatsApp** | **22 100** | **24 400** | **46 000** |
| **WhatsApp Business** — gabarits utilitaires hors fenêtre 24 h, 3 messages/élève/mois | **73 200 – 146 400** | **73 200 – 146 400** | **73 200 – 146 400** |
| **Total avec WhatsApp actif** | **95 300 – 168 500** | **97 600 – 170 800** | **119 200 – 192 400** |

**Le poste WhatsApp est le résultat de cette section**, et il n'apparaissait nulle
part. Meta facture au message dès qu'on sort de la fenêtre de 24 heures — donc
pour la quasi-totalité des envois d'un ERP, comme la ligne 7 de la phase 1-B le
dit déjà. Or **`notification` est une clé du noyau, présente dans `free`** : le
canal est vendu **dès l'Essentiel**. À trois messages par élève et par mois — une
hypothèse basse pour des absences, des notes publiées et des échéances de frais —
il consomme **38 à 75 % du prix de l'Essentiel à lui seul**. Trois issues, aucune
gratuite : le mettre sous quota, le remonter au Standard, ou le facturer au
message en sus. C'est un arbitrage porteur (D-R11), pas un détail de mise en
œuvre.

**Marge de contribution par campus et par mois** *(WhatsApp compté au bas de la
fourchette)* :

| Palier | Prix HT | Coût marginal | **Marge** | Taux |
|---|---|---|---|---|
| Essentiel | 195 000 | 95 300 | **99 700** | 51 % |
| Standard | 355 000 | 97 600 | **257 400** | 73 % |
| Premium | 560 000 | 119 200 | **440 800** | 79 % |
| *Essentiel, WhatsApp inactif* | *195 000* | *22 100* | *172 900* | *89 %* |

### 9.5 Coûts non salariaux de la production

Petits montants, mais deux d'entre eux sont **bloquants et à délai long** — ce
sont des dépendances de calendrier déguisées en lignes de frais.

| Poste | Montant | Nature |
|---|---|---|
| Vérification d'entreprise Meta + validation des gabarits WhatsApp | 0 XAF, **1 à 3 semaines** | **Bloque la ligne 7 de la phase 1-B** — à lancer avant, pas pendant |
| Benchmark d'embedding hors ligne (D2) — téléchargement d'un modèle de ~2 Go | 0 XAF, à faire hors bac à sable | **Bloque tout index de production** ; le refaire après coup impose une ré-indexation complète |
| Compte développeur Apple | ~99 $/an | Application mobile — hors total |
| Compte développeur Google Play | ~25 $, une fois | Application mobile — hors total |
| Clés de fournisseur LLM pendant le développement | ~50 $/mois pendant les phases IA | Absorbé |
| Nom de domaine, certificats, minutes d'intégration continue | ≈ paliers gratuits | Absorbé |

### 9.6 Prix affichés et TVA

Tous les prix de ce document sont **hors taxes**. À 19,25 % :

| | HT | **TTC** |
|---|---|---|
| SaaS Essentiel / mois | 195 000 | **232 538** |
| SaaS Standard / mois | 355 000 | **423 338** |
| SaaS Premium / mois | 560 000 | **667 800** |
| Licence Essentiel | 3 000 000 | **3 577 500** |
| Licence Standard | 6 500 000 | **7 751 250** |
| Licence Premium | 11 500 000 | **13 716 250** |

### 9.7 Sensibilité au taux journalier

Le taux est hérité, non recalculé (D-R6). Ce qu'il change :

| Taux | Restant (210–272 j) | Phase 1-A (204–284 j) | **Programme complet** |
|---|---|---|---|
| 60 000 XAF | 12,60–16,32 M | 12,24–17,04 M | **24,84–33,36 M** |
| **75 000 XAF** *(retenu)* | **15,75–20,40 M** | **15,30–21,30 M** | **31,05–41,70 M** |
| 90 000 XAF | 18,90–24,48 M | 18,36–25,56 M | **37,26–50,04 M** |

### 9.8 Points morts

Le seul seuil que portait la v3 concernait la **vente à l'unité** (§10.3), pas le
produit. Voici celui du produit.

**Point mort d'exploitation** — couvrir le socle de plateforme (98 500 XAF/mois) :
**un seul campus Essentiel y suffit**. L'exploitation n'est pas le problème.

**Point mort du programme** — amortir 31,05 à 41,70 M XAF de production *et* le
socle, en marge de contribution :

| Horizon | Marge mensuelle nécessaire | Essentiel seul | Standard seul | Premium seul |
|---|---|---|---|---|
| **24 mois** | 1,39 – 1,84 M XAF | **14 à 19 campus** | **6 à 8 campus** | **4 à 5 campus** |
| **36 mois** | 0,96 – 1,26 M XAF | **10 à 13 campus** | **4 à 5 campus** | **3 campus** |

*Les parcs sont inchangés : la marge nécessaire bouge de ~1 %, les marges par
campus (99 450 / 232 000 / 442 400 XAF) ne bougent pas, et aucun arrondi ne
franchit un seuil.*

Trois lectures, et elles commandent la stratégie commerciale plus que n'importe
quelle ligne technique de ce document :

1. **Le parc de rentabilité est petit** — de l'ordre de la dizaine de campus, pas
   de la centaine. Le produit est finançable.
2. **Le palier vendu compte plus que le nombre de clients.** Un campus Premium
   vaut 4,4 campus Essentiel en marge. Vendre dix Essentiel ou trois Premium
   amortit la même chose, pour un coût de support trois fois moindre.
3. **L'Essentiel est le palier fragile.** À 51 % de marge WhatsApp actif, contre
   79 % au Premium, c'est celui qui supporte le moins bien une hypothèse de coût
   qui déraperait — et c'est celui dont le nom, `free`, dit l'inverse de son prix
   (§10, D-R8).

---

## §10 — Les deux grilles commerciales

La v2 ne portait qu'une grille, adossée à des phases de développement. La v3 en
porte **deux**, adossées aux trois paliers que le registre d'entitlement sait
réellement appliquer (§1.3).

> **Ancrage.** Les niveaux de prix ci-dessous sont **repris de la v2**, où ils
> ont été posés commercialement et confrontés au marché. Ce document les
> **remappe** sur les paliers du code sans les recalculer : re-dériver une grille
> depuis les charges de la v3 suppose une version produit qui n'existera qu'à la
> fin de la phase 2. C'est une décision en attente (§12, D-R6). Leur **coût de
> revient** est établi au §9.4, et les points morts qui en découlent au §9.8.

> ⚠️ **Trois documents, deux grilles, les mêmes trois noms.**
> `free` / `standard` / `premium` désignent **deux grilles distinctes** que rien
> ne distingue aujourd'hui : les **paliers de modules** (15 / 22 / 26 clés,
> tarifés ici) et les **plans du module IA** (budgets de 200 k / 1 M / 5 M jetons,
> tarifés 0 / 99 / 299 € par `PHASE3_AI_DESIGN.md` D10). `CAMPUS_ENTITLEMENT_DESIGN.md`
> D-D a recopié les seconds sur les premiers en écrivant « une seule grille
> commerciale » — d'où un Essentiel **gratuit** dans un document et à
> **195 000 XAF** dans un autre, et un Premium à 299 € contre 854 €. Le nom
> `free` porté par un palier facturé est un piège commercial en soi. **Arbitrage
> D-R8, à trancher avant toute proposition écrite à un client.**

### 10.1 Grille A — SaaS hébergé, par campus

> **L'unité de vente ne correspond pas au quota que le code applique.** La v2
> facture « par campus de 2 000 élèves » et « hébergement ≤ 20 Go » ;
> `DEFAULT_QUOTAS` vaut **1 000 élèves et 5 Go**, et `canAddStudent` /
> `canAddDocumentStorage` refusent au-delà. Tant que la ligne 15 de la phase 1-B
> n'est pas faite, **tout campus vendu sur cette grille doit être provisionné
> avec une dérogation explicite**, sinon il bute à la moitié de ce qu'il a payé
> (D-R10).

| Palier | Modules | Abonnement mensuel | Ce qui est inclus |
|---|---|---|---|
| **Essentiel** (`free`) | 15 | **195 000 XAF** | Scolarité, résultats, portails élève/parent/enseignant, suppression définitive. Hébergement ≤ 20 Go, mises à jour correctives, support L1 < 4 h |
| **Standard** (`standard`) | 22 | **355 000 XAF** | Essentiel + finance, examens SEMS, GED, annonces, impression académique, mentors et personnel |
| **Premium** (`premium`) | 26 | **560 000 XAF** | Standard + portail public, GAET, partenaires, module IA — **jetons inclus dans la limite du budget mensuel du plan IA**, voir ci-dessous |

Au-delà du stockage inclus : **+15 000 XAF / 10 Go / mois**, comme en v2.

**La clé du fournisseur IA ne peut pas être « à la charge du client »**, comme
l'écrivait la v3. Elle est un profil de l'environnement du service
(`LLM_PROFILE_<NOM>_API_KEY`, `ai-service/app/config.py`) : **une par
déploiement, jamais une par campus**. Toute la mécanique livrée suppose l'inverse
de ce que la phrase promettait — budget mensuel de jetons par campus, garde
`enforce_budget`, alerte à 80 %, compteur de dépense en USD. **C'est l'éditeur
qui achète les jetons et les refacture dans le prix du palier** ; le coût
correspondant est au §9.4 (~20 100 XAF/mois au plafond du plan `premium`).

### 10.2 Grille B — Licence de code source on-premise

| Palier | Licence perpétuelle | Ratio L / (SaaS × 12) | Support & mises à jour |
|---|---|---|---|
| **Essentiel** (`free`) | **3 000 000 XAF** | ×1,28 | 12 mois inclus, renouvelable |
| **Standard** (`standard`) | **6 500 000 XAF** | ×1,53 | 12 mois inclus, renouvelable |
| **Premium** (`premium`) | **11 500 000 XAF** | ×1,71 | 12 mois inclus, renouvelable |

**Ce que la licence est, précisément** — quatre points qui doivent figurer au
contrat, tous issus de `FEATURE_DELIVERY_DESIGN.md` :

1. **L'établissement devient propriétaire du code du palier acheté.** Il
   l'héberge lui-même, peut le modifier, et les données ne quittent jamais
   l'établissement. C'est l'argument de vente n° 1 sur ce segment.
2. **Le snapshot livré ne contient que les modules du palier.** Un module de
   palier supérieur n'est pas endormi : il est **absent**. Il n'y a donc rien à
   « activer » — il faut le livrer.
3. **La licence s'applique à l'installation, jamais à l'exécution.** Une licence
   expirée ou illisible n'éteint pas l'ERP d'un établissement en cours d'année.
4. **Les correctifs de sécurité ne sont pas un produit.** Gratuits, prioritaires,
   poussés à toute la flotte, y compris aux installations divergentes.

**Le module IA n'est pas vendu on-premise en V1** (§12, D-J) : il exige une
brique Python, une base vectorielle et une clé de fournisseur chez le client. Un
palier Premium licencié se livre donc **sans** `ai`, avec une remise à fixer.

### 10.3 La vente à l'unité — méthode, pas grille

Le prix d'une fonctionnalité vendue après l'achat **n'est pas dérivable de sa
charge**. Il se dérive du parc installé, et cette arithmétique doit être posée
avant de promettre le modèle :

- Une fonctionnalité de 4 jours coûte **300 000 XAF** à produire, **une fois**.
- Le dispositif qui permet de la livrer — licence, extracteur, ABI, runner,
  catalogue, canal de sécurité — pèse **51 jours, soit 3 825 000 XAF**, à
  amortir sur l'ensemble des ventes à l'unité.
- **Au-dessous d'une dizaine d'installations actives, la vente à l'unité ne
  rembourse pas son propre outillage.** C'est la tension T-2 de
  `FEATURE_DELIVERY_DESIGN.md` : c'est un commerce de service, pas une rente
  logicielle, et aucune technique ne le corrigera.

Ce que le client paie réellement, et qui ne se réplique pas d'un prompt : une
fonctionnalité **spécifiée** et cohérente avec 58 modèles, **testée** contre les
schémas réels, **traduite** en 10 locales, **migrée** avec un chemin de retour,
et **garantie** sur une plage de versions annoncée.

---

## §11 — Écarts au discours commercial : traitement

Six affirmations du catalogue commercial 2025–2027 n'étaient pas soutenues par le
code. Les citations ci-dessous, avec leurs numéros de page, **sont tout ce qui
subsiste de ce document** depuis que son fichier a été remplacé (voir l'en-tête).
**Les six sont traitées** — quatre par un chantier positionné dans la roadmap, deux par
une correction du support de vente. Aucune n'est laissée ouverte.

| # | Affirmation v2 | Réalité mesurée | Traitement |
|---|---|---|---|
| **1** | « Mobile Money intégré — paiements MTN & Orange natifs avec rapprochement automatique et anti-fraude » *(p. 2, argument différenciant)* | `'Mobile Money'` est une valeur d'énumération sur le mode de paiement. Aucun appel réseau, aucune réconciliation. **Seul écart où l'argumentaire de couverture promet ce qu'aucune phase livrée ne contient** | **Phase 3**, lignes 1–2 · 7–10 j. En attendant : retirer de la page de couverture, conserver en « planifié » |
| **2** | « 11 langues » dont latin, lingala, haoussa *(p. 2 et p. 9)* | **Deux catalogues divergents, jamais réconciliés** : 10 locales sur B2, 8 sur B4, **5 codes strictement communs**, `zh-CN` contre `zh`. Le **latin est livré — sur B4 seulement** ; le grec l'est aussi et n'est vendu nulle part. Absents des deux : le lingala et le haoussa, qui **portent à eux seuls le positionnement panafricain** | **Phase 1-B**, ligne 11 · 5–7 j. Les manquantes sont livrées sur les deux briques, `ja`/`pt`/`el` entrent au catalogue et les codes sont alignés : **14 langues** (D-R3 révisée, D-R9) |
| **3** | « Audit log complet — chaque action est horodatée avec l'identité de l'utilisateur » *(p. 3)* | Trois registres append-only sur une soixantaine de collections. La consultation n'est journalisée nulle part | **Phase 1-B**, ligne 8 · 3–4 j |
| **4** | « JWT avec expiration courte + refresh tokens · sessions invalidées côté serveur · blacklist temporaire automatique » *(p. 3 et p. 5)* | Jeton de 7 jours, aucun rafraîchissement, aucune révocation, aucun verrouillage de compte. Seule la limitation par IP existe | **Phase 1-B**, ligne 3 · 3–4 j (D-R2) |
| **5** | « Sauvegarde quotidienne, restauration testée mensuellement, RPO < 24 h, RTO < 4 h, supervision 24/7 » + « Docker · Nginx · Certbot · CI/CD » *(p. 2 et p. 3)* | **Trois briques sur quatre ont une chaîne d'intégration** ; le portail public n'en a aucune. Restent entiers : aucun script de sauvegarde, aucune restauration jamais testée, aucune supervision, un conteneur pour la seule brique IA. **C'est un engagement contractuel adossé au prix SaaS mensuel** | **Phase 2**, ligne 4 · 8–12 j (D-R1) ; CI du portail en **phase 1-B**, ligne 13 |
| **6** | « API-ready — architecture REST documentée, intégration externe possible dès la Phase 2 » *(p. 2)* | **Aucune spécification exploitable par une machine.** Le seul contrat écrit — `partner/docs/api-contract.md` — couvre `/api/public/*`, soit ~1 % des 547 routes, et vit **dans la brique cliente** : il dérive en silence dès que B1 bouge | **Phase 2**, ligne 5 · 3–4 j |

**Trois corrections à porter au support de vente sans attendre la livraison** :
le Mobile Money quitte la page de couverture jusqu'à la phase 3 ; la mention
« 11 langues » devient « 10 langues dans l'ERP, 14 à terme » jusqu'à la phase
1-B ; et **la capacité annoncée par campus s'aligne sur le quota réellement
appliqué** — 1 000 élèves et 5 Go — ou le campus est provisionné en dérogation
avant la signature (§10.1, D-R10). Une affirmation vérifiable en trente secondes
de démonstration ne se laisse pas courir ; celle sur la capacité se vérifie à
l'usage, ce qui est pire.

---

## §12 — Décisions porteur en attente

Dix arbitrages restent ouverts. Aucun n'est technique : chacun change ce qui est
construit, ou ce qui est vendu — pas comment.

**Les cinq premiers sont urgents** : quatre portent sur ce qu'un client va lire
dans une proposition écrite, le cinquième sur une opération irréversible.

| # | Question | Options | Recommandation | Bloque |
|---|---|---|---|---|
| **D-R8** | **Quelle grille de prix fait foi ?** Trois documents en portent deux, sous les mêmes trois noms : paliers de modules à 195 / 355 / 560 k XAF (ici) contre 0 / 99 / 299 € (`CAMPUS_ENTITLEMENT_DESIGN.md` D-D, recopiés de la grille du module IA) | (a) Ce §10 fait foi, le 0/99/299 € redevient la grille du **seul add-on IA**, et D-D est corrigée ; (b) l'inverse ; (c) une troisième grille recalculée | **(a)** — c'est la seule des deux qui ait un coût de revient en face (§9.4) et un point mort (§9.8). Et **renommer les paliers commerciaux** : un palier facturé 195 000 XAF ne peut pas s'appeler `free`, même si la clé technique le reste | **Toute proposition écrite à un client**, et §10 tout entier |
| **D-R9** | **Quel est le catalogue de langues canonique ?** B2 en porte 10, B4 en porte 8, 5 codes seulement sont communs, `zh-CN` d'un côté et `zh` de l'autre | (a) Union alignée sur les deux briques ; (b) intersection ; (c) catalogue par brique, assumé et documenté | **(a)** — un visiteur qui passe du portail à l'ERP ne doit pas perdre sa langue. Soit 14 langues après la phase 1-B | Phase 1-B, ligne 11 · support de vente |
| **D-R10** | **Quelle capacité est vendue par campus ?** La grille facture 2 000 élèves et 20 Go ; le code en applique 1 000 et 5 Go | (a) Dériver les quotas du palier (`PLAN_PRESETS`) ; (b) aligner la grille sur `DEFAULT_QUOTAS` ; (c) dérogation manuelle à chaque vente | **(a)** — (c) est l'état actuel, et il tient uniquement tant que personne n'oublie | Phase 1-B, ligne 15 · §10.1 |
| **D-R11** | **Comment WhatsApp est-il facturé ?** Le canal est dans `notification`, clé du noyau, donc vendu dès l'Essentiel ; Meta facture au message hors fenêtre de 24 h, soit 38 à 75 % du prix de ce palier (§9.4) | (a) Quota mensuel de messages par palier ; (b) canal remonté au Standard ; (c) refacturation au message | **(a)** — un quota se met dans le registre, qui sait déjà les appliquer, et ne retire rien à personne | Phase 1-B, ligne 7 · marge de l'Essentiel |
| **D2** *(de `PHASE3_AI_DESIGN.md`)* | **Benchmark d'embedding hors ligne**, jamais exécuté faute de réseau dans le bac à sable | Le lancer avant de figer l'index, ou l'assumer | **Le lancer.** C'est un préalable **irréversible** : figer un index de production sur le mauvais modèle se paie par une ré-indexation complète du corpus | Phase 1-B, ligne 4 — et tout index de production |
| **D-K** | Politique de version de contrat | Cadence des versions majeures et durée de support de chacune | À trancher **avant** la phase 2 : c'est ce qui décide de la durée de vie commerciale d'un paquet | Phase 2, ligne 2 |
| **D-G** | Granularité de vente à l'unité | (a) La clé de registre est l'unité ; (b) sous-fonctionnalités sur le modèle de la grille IA | **(a) par défaut**, (b) seulement quand un module le justifie — le module IA le fait déjà | Phase 4-B |
| **D-J** | Le module `ai` en mode licencié | (a) Non vendu on-premise ; (b) vendu avec sa brique Python ; (c) hébergé chez l'éditeur | **(a) pour la V1** — les deux modules les plus chers sont les deux moins installables, et le vendre mal est pire que ne pas le vendre | Phase 4-B, §10.2 |
| **D-M** | Exploitation chez le client | La licence promet de se passer d'une équipe interne, mais exige replica set, stockage persistant, sauvegardes et reconstruction du frontend | **Un critère de qualification client.** Une offre d'infogérance réintroduirait un accès chez le client et doit rester un contrat distinct | Phase 4-B |
| **D-R6** | Re-dérivation de la grille | Les prix du §10 sont repris de la v2 et remappés, non recalculés | Recalculer après la phase 2, quand la version produit existera et que les charges seront confirmées par deux phases livrées | §10 |

---

## §13 — Articulation avec les documents voisins

| Document | Relation | Conséquence |
|---|---|---|
| `QA_TEST_STRATEGY.md` | **Fournit** les chantiers CH-0 à CH-7. CH-0 et CH-1 sont en phase 1-A/1-B, CH-2/3/7 en phase 2, CH-4/6 en phase 3, CH-5 en phase 4-B | Les deux tableaux de bord doivent rester cohérents, **dans les deux sens**. La v3 n'énonçait que l'aller — un CH terminé se répercute ici — et le retour a manqué aussitôt : D-R7 a inscrit `test:journey` et `test:visual` en acquis de phase 1-A pendant que le §1 de `QA_TEST_STRATEGY.md` continuait de mesurer « tests end-to-end, toutes briques : **0** ». **Un fait mesuré ici se répercute là dans le même commit** |
| `FEATURE_DELIVERY_DESIGN.md` | **Fournit** la voie 4-B. Ses phases 0 et 0 bis sont remontées en **phase 2** de ce document (contrat de plateforme, éclatement du registre) parce qu'elles ont une valeur propre hors licence | Ses phases 1 à 6 restent groupées en 4-B. L'ordre imposé de son §20.2 est préservé |
| `CAMPUS_ENTITLEMENT_DESIGN.md` | **Fondation.** Ses trois paliers sont la structure des deux grilles du §10 — mais **sa décision D-D leur attache d'autres prix que ceux du §10** (0/99/299 €, recopiés de la grille du module IA) : contradiction ouverte en D-R8 | Chantier clos, migration faite, QA visuelle faite. Reste la ligne 2 de la phase 1-B : les deux dernières cases de sa DoD (§15). Ses deux harnais de QA sont devenus un acquis transverse — voir §4.3 |
| `PHASE3_AI_DESIGN.md` | Le module IA, livré M0→M6 | Reste la ligne 4 de la phase 1-B. Sort du périmètre on-premise en V1 (D-J). **Deux de ses réserves remontent au §12** : le benchmark d'embedding D2, jamais exécuté et **irréversible une fois l'index de production figé**, et les SLO de chat non mesurés faute de cible déployée |
| `POSTGRES_MIGRATION_ASSESSMENT.md` | Évalué, non engagé | Un changement de moteur serait un changement **majeur** de contrat, donc un nouveau snapshot de palier. À ne pas engager pendant les phases 2 à 4 |
| `docs/cours/` *(dépôt imbriqué)* | **Angle mort, et le seul poste de charge que ce document ne porte pas.** **35** fichiers de solution résolvent ce backend depuis leur position sur le disque — et la leçon `f1.1` résout **les quatre briques**, portail compris. Certaines leçons comptent des figures réelles : modules, routes, modèles, surfaces exportées | Tout chantier qui déplace ou retire un module **fait mentir une leçon**. Lancer `docs/cours/check-solutions.sh` après les lignes 3 et 11 de la phase 4-B, après avoir réétalonné la ligne de base. Le garde tourne en deux phases (résolution des chemins cités, puis 57 solutions exécutables) et est vert au 2026-08-24. La reprise de la prose des leçons **n'est chiffrée nulle part** : à instruire quand la phase 4-B démarre, pas au moment où la suite passe au rouge |

---

## §14 — Journal des décisions

| # | Date | Décision | Motif |
|---|---|---|---|
| **D-R1** | 2026-08-21 | **L'exploitation devient un chantier de phase 2** (sauvegardes, reprise après sinistre, supervision, conteneurisation, CI/CD — 8–12 j) plutôt qu'un chantier hors roadmap | C'est déjà vendu dans le prix SaaS mensuel sous forme de SLA, et c'est un prérequis de la licence on-premise. Le laisser hors roadmap revient à porter un engagement contractuel qu'aucun plan ne couvre |
| **D-R2** | 2026-08-21 | **Le durcissement de l'authentification rejoint la phase 1-B** (3–4 j) plutôt que la phase 2 ou une correction de discours | L'authentification existe et fonctionne sur 9 rôles ; il lui manque sa dernière fraction — c'est exactement la définition de 1-B. Un jeton de 7 jours sans révocation est un risque, pas seulement un écart de discours |
| **D-R3** | 2026-08-21 | **Les trois locales vendues et absentes seront livrées** — latin, lingala, haoussa. Le japonais et le portugais, livrés hors catalogue, sont conservés et entrent dans l'offre : **13 langues** | La conformité à la promesse est totale, et retirer deux traductions déjà payées et fonctionnelles n'a aucun bénéfice |
| **D-R4** | 2026-08-21 | **Le document porte deux grilles commerciales** — SaaS hébergé et licence on-premise — au lieu d'une | La licence on-premise est un modèle de revenu à part entière dont la voie 4-B construit la machinerie. Ne pas la tarifer reviendrait à financer 51 jours d'outillage sans énoncer ce qu'ils vendent |
| **D-R5** | 2026-08-21 | **Les grilles s'adossent aux paliers du registre**, pas aux phases de développement | Un client ne peut pas observer une phase, et rien dans le code ne sait en appliquer une. Les trois paliers `free`/`standard`/`premium` sont en revanche appliqués gate par gate, campus par campus |
| **D-R6** | 2026-08-21 | **Les niveaux de prix sont repris de la v2 et remappés, non recalculés** | Re-dériver une grille depuis les charges de la v3 suppose une version produit qui n'existera qu'à la fin de la phase 2. Décision rouverte à ce moment-là |
| **D-R7** | 2026-08-22 | **Absorption des trois commits parallèles du chantier entitlement** (`98f2a79`, `c02fb51`, `e778496`). La ligne 2 de la phase 1-B passe de 1–2 j à 1 j : la migration était déjà faite au 2026-08-20, la QA visuelle a été jouée le 2026-08-22 (16/16) et **promue en harnais permanent**. Ne restent que les deux dernières cases de la DoD du chantier | **Premier exercice de la règle de maintenance** de ce document, et il valide son intérêt : la ligne était périmée le jour même de sa rédaction. Deux effets de bord enregistrés — le socle de test de la phase 1-A passe à 1 407 tests / 68 suites, et `test:visual` devient un précédent qui dé-risque CH-4 sans en réduire la charge |
| **D-R12** | 2026-08-22 | **Cinq affirmations du document, contredites par le code, sont corrigées** : `TeacherSchedule` est consommé par 17 fichiers et non « par personne » ; le latin est livré, sur B4 ; trois briques sur quatre ont une chaîne d'intégration ; un contrat d'API existe, côté portail ; B4 porte déjà un agent de service et un manifeste | Un document de pilotage qui se trompe sur l'existant fait décider **dans le sens rassurant** : on croit partir de zéro là où un actif existe, et libre là où une contrainte existe. Le cas de `TeacherSchedule` est le plus coûteux — la paie s'y serait branchée en propriétaire d'un miroir dont GAET est propriétaire |
| **D-R13** | 2026-08-22 | **Trois chantiers absents entrent en phase 1-B** (lignes 13 à 15) : intégration continue et socle de test du portail public, TTL du GED qui contourne la danger zone, quotas dérivés du palier. La ligne 11 passe de 3–4 à 5–7 j. Total 1-B : **26–37 → 32–47 j** | Les trois étaient invisibles pour la même raison : aucun ne se voit en lisant le code d'un module, seulement en confrontant deux briques, deux documents, ou une grille de prix à une constante. Celui du TTL est **armé et non déclenché** — et c'est la ligne 9 du même tableau qui l'aurait déclenché |
| **D-R14** | 2026-08-22 | **La phase 1-A est chiffrée** — non comme un devis, mais comme une **valeur de reconstruction** (204–284 j, 15,3–21,3 M XAF), établie par comparables au taux que le document applique déjà à un travail équivalent. Les deux autres méthodes essayées, calendrier et volume de code, sont conservées au §9.2 avec leur verdict | La v3 refusait le chiffre pour ne pas produire un nombre invérifiable. Le motif tient pour une facture ; il ne tient pas pour **fixer un prix plancher de licence**, ce que le §10.2 faisait pourtant déjà à 3–11,5 M XAF. Le résultat vaut à lui seul l'exercice : le livré et le restant sont du même ordre, donc le programme est à mi-charge et non aux quatre cinquièmes |
| **D-R15** | 2026-08-22 | **Le coût de revient d'exploitation entre au document** (§9.4) avec les marges par palier, les points morts (§9.8), la TVA et la sensibilité au taux. Ses montants sont des **hypothèses de tarifs publics explicitement étiquetées**, jamais des relevés | Le §10 vendait un abonnement mensuel adossé à un engagement de service sans qu'aucune charge lui réponde. La structure importait plus que les montants, et elle a livré un résultat que rien n'annonçait : **WhatsApp, vendu dès l'Essentiel parce que `notification` est une clé du noyau, consomme 38 à 75 % du prix de ce palier** |
| **D-R16** | 2026-08-22 | **La contradiction de prix n'est pas tranchée ici, elle devient un arbitrage ouvert** (§12, D-R8). Trois documents portent deux grilles sous les mêmes trois noms `free`/`standard`/`premium` | Ce n'est pas une coquille à corriger d'un côté : c'est une **collision de vocabulaire** entre les paliers de modules et les plans du module IA, que `CAMPUS_ENTITLEMENT_DESIGN.md` D-D a fusionnés en croyant unifier. Trancher unilatéralement reviendrait à fixer un prix dans un document de planning — précisément ce que D-R5 refuse |
| **D-R17** | 2026-08-27 | **La ligne 6 tient les étapes 1 à 9 du patron §12 et s'arrête à deux cases**, énoncées plutôt que contournées : la garde du cours est rouge et la QA navigateur n'est pas jouée. Trois constats d'audit fermés en chemin, chacun par un test rouge avant correction — `{name}` jamais interpolé dans **toutes** les relances de frais (« Bonjour , » depuis l'origine du gabarit d'impayé), date d'échéance en ISO quelle que soit la langue, et le reçu — seul rendu PDF de la plateforme atteignable par un `STUDENT` — laissé derrière le quota générique par IP au lieu du budget par utilisateur que la GED applique déjà. Ce dernier devient `pdfLimiter` dans `shared/middleware/rate-limiter.js`, la copie locale du GED est supprimée, et la règle entre au §7 de `CLAUDE.md`. Effet de bord enregistré : le socle de test passe de 1 426 à **1 546 tests / 71 suites** (D-R7 en notait 1 407 / 68) | La règle de maintenance de ce document dit d'écrire ce qui reste, pas d'arrondir. Les deux cases ouvertes ne sont pas du même genre : la QA navigateur est du temps d'opérateur, la garde du cours est un **arbitrage de contenu** — la piste 09 s'intitule *Seven Jobs, Four Postures* et compte sept jobs sur toute sa narration, or il y en a huit depuis ce chantier. Substituer le chiffre partout ou assumer la date de gel de la leçon est une décision d'auteur, prise dans le dépôt du cours et pas ici |
| **D-R18** | 2026-09-02 | **La ligne 6 de la phase 1-B est livrée**, et son étape 10 — la QA navigateur — est **écrite dans le harnais** (`npm run test:visual`, 16 → **36 contrôles**) plutôt que jouée à la main. Le portail étudiant y est rendu pour la première fois, ce qui entame la ligne 2. Restant 1-B : **32–47 → 30–44 j** ; total **212–275 → 210–272 j**, tableaux monétaires du §9 recomposés | La QA manuelle prouve l'état d'un jour ; le harnais le prouve à chaque exécution, et c'est le précédent posé par D-R7. Le bénéfice est immédiat et vérifie la règle : elle a trouvé ce qu'aucun test existant ne pouvait voir — `exposedHeaders` n'exposait pas `Content-Disposition`, donc **tout téléchargement binaire arrivait sous un nom de repli** dès lors que le SPA et l'API ne partagent pas une origine, c'est-à-dire toujours. Le reçu perdait son numéro, l'export GED son nom de fichier ; supertest, same-origin, lisait l'en-tête et ne voyait rien. Corrigé en une ligne d'`app.js`, fermé par un test vu rouge |

---

## §15 — Annexe · Méthode de mesure

Les chiffres de ce document ont été relevés sur les quatre dépôts le
**2026-08-22**. **Re-mesurez-les avant de vous en servir comme argument** ; les
commandes sont données pour que le relevé soit reproductible et non déclaratif.
Toutes s'exécutent depuis `~/Projects`.

| Indicateur | Valeur | Commande |
|---|---|---|
| Modules métier backend | **25** | `cd university/backend && ls modules/ \| wc -l` |
| Routes déclarées | **547** | `cd university/backend && grep -rhoE "router\.(get\|post\|put\|patch\|delete)\(" modules/ shared/ \| wc -l` |
| Fichiers de modèles Mongoose | **58** | `cd university/backend && find . -name "*.model.js" -not -path "./node_modules/*" -not -path "./docs/*" \| wc -l` |
| Clés du registre d'entitlement | **26** — dont **9** de noyau | `cd university/backend && node -e "const f=require('./shared/constants/features.constants'); console.log(f.FEATURE_KEYS.length, f.CORE_FEATURE_KEYS.length)"` |
| Composition des paliers | **15 / 22 / 26** | `cd university/backend && node -e "const p=require('./shared/constants/features.constants').PLAN_PRESETS; for (const k of ['free','standard','premium']) console.log(k, p[k].length)"` |
| Montages déclarés au registre | **32** + 4 non gardés | `cd university/backend && node -e "const f=require('./shared/constants/features.constants'); let m=0; for (const k of f.FEATURE_KEYS) m+=(f.FEATURE_REGISTRY[k].routers\|\|[]).length; console.log(m, f.UNGATED_MOUNTS.length)"` |
| Quotas par défaut d'un campus | **1 000 élèves · 100 enseignants · 50 classes · 5 Go** | `cd university/backend && node -e "console.log(require('./shared/constants/features.constants').DEFAULT_QUOTAS)"` |
| Suites backend, tous projets Jest | **68** — 64 unitaires · 3 d'intégration · 1 de contrat | `cd university/backend && find tests -name "*.test.js" \| wc -l` |
| Tests backend | **1 407** — **1 404 verts, 3 rouges** | `cd university/backend && npx jest --silent` |
| Harnais hors Jest | **2** — `test:journey` · `test:visual` | `cd university/backend && grep -E '"test:(journey\|visual)"' package.json` |
| Fichiers de composants frontend | **265** | `cd university/frontend && find src -name "*.jsx" \| wc -l` |
| Tests frontend | **0** | `cd university/frontend && grep -E "vitest\|jest\|playwright\|testing-library" package.json` |
| Tests portail public | **0**, et **aucune CI** | `cd partner && grep -E "vitest\|jest\|playwright" package.json ; ls .github/workflows 2>/dev/null` |
| Chaînes d'intégration | **3 briques sur 4** | `for d in university/backend university/frontend university/ai-service partner; do ls $d/.github/workflows 2>/dev/null; done` |
| Locales | **10** sur B2, **8** sur B4, **5** codes communs | `cd university/frontend && ls public/locales ; cd ../../partner && ls src/messages` |
| Rôles applicatifs connectés | **9** | `ADMIN · DIRECTOR · CAMPUS_MANAGER · TEACHER · STUDENT · PARENT · MENTOR · STAFF · PARTNER` |
| Étiquettes git | **0** sur **388** commits, les quatre briques réunies | `for d in …; do (cd $d && git tag \| wc -l && git rev-list --count HEAD); done` |
| Lignes de code livrées | **190 881** + 23 813 de traduction | Détail par brique au §2 |

> **Trois pièges de lecture.**
>
> `find src -name "*.jsx"` compte des **fichiers**, pas des composants : les
> « écrans significatifs » sont une estimation dérivée, jamais une mesure.
>
> Le décompte des modèles se vérifie par **deux** commandes distinctes — fichiers
> `*.model.js` d'un côté, appels `mongoose.model()` de l'autre — parce qu'un
> fichier peut n'enregistrer aucun modèle et un modèle vivre hors d'un
> `*.model.js`.
>
> **Une mesure prise sur un arbre sale n'est pas reproductible.** Au 2026-08-22
> le dépôt frontend porte une trentaine de modifications non commitées, dont dix
> fichiers de locale et les écrans d'entitlement : c'est ce qui explique l'écart
> entre les 256 fichiers relevés le 2026-08-21 et les 265 d'aujourd'hui. Relevez
> après avoir commité, ou datez le relevé.

### 15.1 — L'instabilité du socle de test, mesurée

Le chiffre de 1 407 tests est exact. **Sa couleur ne l'est pas** : deux
exécutions complètes le 2026-08-22 donnent chacune **3 tests rouges, sur des
suites différentes** — `document.pdf.pool.test.js` (pool Puppeteer) à l'une,
`document.storage.service.test.js` (service de stockage du GED) à l'autre, la
première ayant tourné pendant que d'autres mesures occupaient la machine.

C'est **un symptôme de contention, pas une régression fonctionnelle** — et c'est
pire pour ce qui vient. CH-2 à CH-6 posent des suites bloquantes en intégration
continue au-dessus de ce socle : une suite instable y rejette des commits sains,
et la première réaction d'une équipe devant un rouge intermittent est de cesser
de le lire. **À stabiliser avant CH-2**, pas pendant.

---

*Fin du document. Mise à jour obligatoire du §0 et de la colonne « État » de la
phase concernée à chaque commit qui touche cette feuille de route.*
