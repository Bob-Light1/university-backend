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
> **Statut** : v3.0 — cadrage établi d'après l'état **mesuré** du code au
> 2026-08-21, et non d'après le catalogue commercial qui le précède. Phase 1-A
> livrée ; phases 1-B à 4 non démarrées.
>
> **Prérequis de lecture** : `CLAUDE.md` (les quatre briques, les invariants
> d'isolation et de suppression). Documents dont cette feuille de route dérive :
> `QA_TEST_STRATEGY.md` (chantiers CH-0 à CH-7),
> `FEATURE_DELIVERY_DESIGN.md` (livraison sous licence, phases 0 à 6),
> `CAMPUS_ENTITLEMENT_DESIGN.md` (le registre de modules et ses paliers).
>
> **Il remplace `ERP_2026_v2.pdf`** (édition 2025–2027) comme référence de
> planification. La v2 reste l'archive commerciale de son époque ; ses écarts au
> code sont traités au §11, aucun n'est laissé ouvert.
>
> **Langue.** Prose en français, conforme aux documents voisins de
> `docs/architecture/`. **Tout artefact de code — identifiants, commentaires,
> JSDoc, messages de log, noms de fichiers — reste en anglais**, conformément au
> §0 de `CLAUDE.md`.
>
> **Révisions** : **v3.0 (2026-08-21)** — première rédaction. Quatre arbitrages
> porteur tranchés à l'écriture (§14, D-R1 à D-R4) : l'exploitation devient un
> chantier de phase 2, le durcissement de l'authentification rejoint la phase
> 1-B, les trois locales vendues et absentes seront livrées, et le document porte
> **deux** grilles commerciales au lieu d'une.

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
| **1-B** | L'inachevé, à fermer | `À FAIRE` | 1-A | 26–38 j | 2026-08-21 |
| **2** | Le socle de fabrication | `À FAIRE` | 1-B *(fixture recettée)* | 42–57 j | 2026-08-21 |
| **3** | L'ERP complet, sous filet | `À FAIRE` | 2 | 47–63 j | 2026-08-21 |
| **4-A** | Pédagogie & vie scolaire | `À FAIRE` | 3 | 20–28 j | 2026-08-21 |
| **4-B** | Infrastructure & industrialisation | `À FAIRE` | 2 *(contrat)*, 3 *(E2E)* | 71–80 j | 2026-08-21 |

**États autorisés** : `À FAIRE` · `EN COURS` · `BLOQUÉ (motif)` · `LIVRÉ` ·
`ABANDONNÉ (motif)`.

**Total hors application mobile native** : **206 à 266 jours·développeur**.
L'application mobile (25–35 j) fait l'objet d'un chiffrage séparé, comme dans la
v2.

**Chemin critique** : `1-B → 2 → 3 → 4-A`, soit **135 à 186 jours**. La voie 4-B
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

---

## §3 — La chaîne des phases et sa règle d'ordonnancement

```
  1-A ──▶ 1-B ──▶  2  ──▶  3  ──▶ 4-A
 livré   26–38 j  42–57 j  47–63 j  20–28 j
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
| Socle de test — CH-0 & CH-1 | `B1` | 63 suites unitaires ; fixture déterministe de 2 campus, 283 documents, 31 collections, 127 assertions, 18 comptes couvrant les 9 rôles, base éphémère sans MongoDB installé |

---

## §5 — Phase 1-B · L'inachevé, à fermer avant tout le reste

**État** : `À FAIRE` · **Charge** : **26–38 j** · **Dépend de** : 1-A

C'est la phase la plus rentable du document, et la moins visible. Chaque ligne
est un travail déjà payé à 70–90 % **dont la valeur reste nulle tant que la
dernière fraction manque** : un canal WhatsApp qui n'enverra jamais rien en
production, un pipeline de préinscription qui ne crée aucun étudiant, une
migration d'entitlement jamais lancée sur la base réelle.

Les quatre premières lignes sont des **dépendances directes de la phase 2**.

| # | Chantier | Briques | Ce qui existe déjà | Ce qui manque | Charge | État |
|---|---|---|---|---|---|---|
| 1 | Fixture déterministe (CH-0) | `B1` | Seed reproductible, empreinte SHA-256 identique d'une exécution à l'autre, 9 rôles qui se connectent réellement | Recette par une seconde personne ; arbitrage mémoire contre conteneur en CI ; 8 collections non seedées — GAET, notifications, préférences, file d'impression, transcripts finaux, pièces jointes GED — que les parcours E2E réclameront | 2–3 j | `À FAIRE` |
| 2 | Entitlement par campus | `B1·B2` | Six phases de conception livrées, code en place, toutes les décisions tranchées | Exécution de `migrate-entitlement.js` sur la base réelle, QA visuelle d'un campus migré, puis retrait des champs hérités du schéma. **Trois actions d'exploitation, zéro ligne de code** | 1–2 j | `À FAIRE` |
| 3 | Authentification — durcissement | `B1·B2` | JWT sur 9 rôles, bcrypt 12 tours, limiteur de débit sur les points de connexion, flux d'activation par jeton | Jetons de rafraîchissement, **révocation côté serveur** — aucun mécanisme n'existe aujourd'hui, un jeton volé vaut 7 jours — et verrouillage temporaire de compte après échecs répétés | 3–4 j | `À FAIRE` |
| 4 | Module IA — sortie de conception | `B1·B3` | M0 à M6 livrés, tests verts des deux côtés, charge mesurée sous SLO en local | QA visuelle réelle de l'UI, SLO du chat mesuré sur l'infrastructure cible, benchmark d'embedding hors ligne avant de figer l'index de production | 2–3 j | `À FAIRE` |
| 5 | Portail d'inscription en ligne | `B1·B4` | Pipeline de prospects en 7 statuts jusqu'à `enrolled`, anti-fraude, lien court et QR | Pièces jointes au dossier, workflow de validation directeur, **création effective de l'étudiant** au passage à `enrolled` — aujourd'hui seule la commission partenaire se déclenche — et notification du candidat | 3–4 j | `À FAIRE` |
| 6 | Frais — reçus et échéancier | `B1·B2` | Frais, encaissements, relance post-échéance avec réclamation atomique multi-instance | Reçu PDF auto-généré à l'encaissement — le pool Puppeteer existe déjà ; cadence **avant** échéance J-7 / J-3 / Jour J, aujourd'hui absente : la relance ne part qu'une fois l'impayé constaté | 2–3 j | `À FAIRE` |
| 7 | Notifications WhatsApp Business | `B1` | Canal Meta Cloud API en appel natif, inerte sans jeton, préférence par utilisateur | Gabarits approuvés par Meta — obligatoires hors de la fenêtre de 24 h, donc pour la quasi-totalité des envois ERP ; consentement explicite ; webhook de statut ; câblage des quatre événements vendus | 2–3 j | `À FAIRE` |
| 8 | Journal d'audit transverse | `B1` | Trois registres append-only : audit documentaire, registre de suppression, historique de statut des prospects | Journal unique de toutes les mutations post-publication, export d'audit, rétention configurable par campus. **Traite l'écart 3 du §11** | 3–4 j | `À FAIRE` |
| 9 | Dossiers RH enseignants | `B1·B2` | GED versionnée, documents rattachés à l'enseignant, champ d'expiration | Catégorie RH dédiée ; l'expiration actuelle est un index TTL qui **supprime** le document au lieu de prévenir ; historique des modifications de poste | 2–3 j | `À FAIRE` |
| 10 | Orientation & suivi scolaire | `B1·B2` | Détection précoce déjà calculée par les analytics d'examen et le service de résultats | Notes de suivi par élève, signalement explicite, recommandations d'orientation, restitution dans les portails parent et mentor | 2–3 j | `À FAIRE` |
| 11 | Catalogue de langues | `B2·B4` | 10 locales × 18 espaces de noms, RTL fonctionnel, sélecteur et préférence utilisateur | Les **trois locales vendues et absentes** — latin, lingala, haoussa — soit 54 fichiers de traduction. Le japonais et le portugais, livrés mais hors catalogue, sont conservés et entrent dans l'offre (D-R3). **Traite l'écart 2 du §11** | 3–4 j | `À FAIRE` |
| 12 | Import / export — volet tableur | `B1·B2` | CSV en lecture et en écriture partout : étudiants, enseignants, résultats, prospects | Lecture et écriture XLSX. La v2 inclut « migration depuis CSV/Excel » dans chaque palier et annonce un export Excel du tableau de bord financier ; aucune dépendance tableur n'est installée | 1–2 j | `À FAIRE` |

**Total Phase 1-B : 26–38 j**

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
| 2 | Contrat de plateforme | `B1·B2` | Étiquettes git, version produit réelle, déclaration des zones libres et du tronc, règle de lint refusant un import hors surface publique | **240 commits, zéro étiquette, `package.json` figé à `1.0.0`** : rien ne nomme aujourd'hui la version d'une installation. Toute la mécanique de livraison en dépend, et un correctif de sécurité ne sait pas à qui il s'applique | 4 j | `À FAIRE` |
| 3 | Éclatement du registre + graphe runtime | `B1·B2` | Chaque module déclare son entrée, ses montages, ses crons, ses modèles et ses dépendances dans son propre dossier ; agrégateur à échec bruyant ; déclaration des arêtes que Mongoose résout par nom | Le graphe déclaré est **incomplet** : deux arêtes non déclarées rendent déjà le palier `free` non fonctionnel, en silence. Et tant que le registre est un fichier du tronc, chaque module nouveau — donc chaque ligne des phases 3 et 4 — coûte la modification de six listes centrales | 7 j | `À FAIRE` |
| 4 | Exploitation — sauvegardes, reprise, supervision | `B1·B2·B3·B4` | Sauvegarde MongoDB quotidienne automatisée avec rétention 30 j et **restauration testée** ; procédure de bascule documentée (RPO < 24 h, RTO < 4 h) ; supervision de disponibilité ; conteneurisation des trois briques qui en sont dépourvues ; chaîne d'intégration et de déploiement complète | **C'est un engagement contractuel déjà vendu** dans le prix SaaS mensuel — SLA 99,5 %/mois — et un prérequis de la licence on-premise. Le dépôt contient un seul workflow d'intégration, aucun script de sauvegarde, et le conteneur n'existe que pour la brique IA. **Traite l'écart 5 du §11** (D-R1) | 8–12 j | `À FAIRE` |
| 5 | Documentation d'API | `B1` | Spécification OpenAPI **dérivée** de la table de routes produite par CH-2, publiée et vérifiée en intégration continue | La v2 vend « architecture REST documentée » et « intégration externe possible » ; aucun fichier de spécification n'existe. Dérivée de CH-2 elle coûte une fraction de ce qu'elle coûterait écrite à la main — d'où sa place juste après. **Traite l'écart 6 du §11** | 3–4 j | `À FAIRE` |
| 6 | Tests de composant frontend (CH-3) | `B2` | Vitest, Testing Library, interception réseau ; priorité aux schémas de validation, aux garde-fous de rôle et aux écrans de suppression | **256 fichiers de composants, zéro test, aucun outil installé** : le plus grand angle mort du projet. Chaque fonctionnalité des phases 3 et 4 ajoute des écrans à un ensemble non couvert | 10–15 j | `À FAIRE` |
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
| 7 | Paie des enseignants | `B1·B2` | Calcul sur les heures livrées — le modèle `TeacherSchedule` existe et **n'est consommé par personne** — bulletin PDF, intégration des présences et du contrat | 4–5 j | `À FAIRE` |
| 8 | Rapports officiels d'inspection | `B1·B2` | Génération des états statistiques exigés par la tutelle : effectifs, résultats, présences, enseignants. Le dépôt n'en contient aujourd'hui qu'une **mention**, dans un gabarit de bulletin | 3–4 j | `À FAIRE` |

### 7.2 Voie 2 · Le filet, une fois la surface stable

| # | Chantier | Briques | Contenu | Charge | État |
|---|---|---|---|---|---|
| 9 | End-to-end déterministe (CH-4) | `B1·B2·B4` | 30 à 60 parcours canoniques sous Playwright, captures de référence, bloquant en intégration continue. **Zéro test end-to-end existe aujourd'hui**, toutes briques confondues | 10–15 j | `À FAIRE` |
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
| 7 | Mode hors-ligne | `B2` | Application installable, fonctionnement sans réseau, synchronisation différée. **Aucun outillage n'est installé** — ni manifeste, ni agent de service | 6–9 j | `À FAIRE` |
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

## §9 — Récapitulatif de charge

| Phase | Nature | Charge | Cumul | Coût indicatif |
|---|---|---|---|---|
| **1-A** | Acquis — non rechiffré | — | — | — |
| **1-B** | Douze chantiers à fermer | 26–38 j | 26–38 j | 1,95–2,85 M XAF |
| **2** | Vérifiabilité, versionnage, exploitation | 42–57 j | 68–95 j | 3,15–4,28 M XAF |
| **3** | Huit manques métier + non-régression | 47–63 j | 115–158 j | 3,53–4,73 M XAF |
| **4** | Pédagogie + industrialisation | 91–108 j | 206–266 j | 6,83–8,10 M XAF |
| | **Total hors application mobile** | **206–266 j** | | **15,45–19,95 M XAF** |
| *hors total* | Application mobile native | 25–35 j | | 1,88–2,63 M XAF |

**Répartition par nature de travail** — utile pour arbitrer ce qui est
externalisable :

| Nature | Charge | Part |
|---|---|---|
| Fonctionnalités métier vendables | 57–80 j | ~29 % |
| Dispositif de test (CH-2 à CH-6) | 50–70 j | ~25 % |
| Machinerie de livraison sous licence | 51 j | ~22 % |
| Fermeture de l'inachevé (1-B) | 26–38 j | ~14 % |
| Exploitation, contrat, registre, documentation | 22–27 j | ~10 % |

Les cinq natures recomposent exactement le total (206–266 j) : aucune ligne du
document n'est comptée deux fois ni oubliée. **Deux tiers de la charge restante
ne sont pas des fonctionnalités** — c'est le constat central de cette feuille de
route, et ce que la v2 chiffrait à zéro.

Coûts au taux de la v2 — **75 000 XAF par jour·développeur senior**, hors TVA et
hors coefficient de licence.

---

## §10 — Les deux grilles commerciales

La v2 ne portait qu'une grille, adossée à des phases de développement. La v3 en
porte **deux**, adossées aux trois paliers que le registre d'entitlement sait
réellement appliquer (§1.3).

> **Ancrage.** Les niveaux de prix ci-dessous sont **repris de la v2**, où ils
> ont été posés commercialement et confrontés au marché. Ce document les
> **remappe** sur les paliers du code sans les recalculer : re-dériver une grille
> depuis les charges de la v3 suppose une version produit qui n'existera qu'à la
> fin de la phase 2. C'est une décision en attente (§12, D-R6).

### 10.1 Grille A — SaaS hébergé, par campus de 2 000 élèves

| Palier | Modules | Abonnement mensuel | Ce qui est inclus |
|---|---|---|---|
| **Essentiel** (`free`) | 15 | **195 000 XAF** | Scolarité, résultats, portails élève/parent/enseignant, suppression définitive. Hébergement ≤ 20 Go, mises à jour correctives, support L1 < 4 h |
| **Standard** (`standard`) | 22 | **355 000 XAF** | Essentiel + finance, examens SEMS, GED, annonces, impression académique, mentors et personnel |
| **Premium** (`premium`) | 26 | **560 000 XAF** | Standard + portail public, GAET, partenaires, module IA. Clé API du fournisseur IA à la charge du client |

Au-delà de 20 Go de stockage documentaire par campus : **+15 000 XAF / 10 Go /
mois**, comme en v2.

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

Six affirmations de `ERP_2026_v2.pdf` n'étaient pas soutenues par le code. **Les
six sont traitées** — quatre par un chantier positionné dans la roadmap, deux par
une correction du support de vente. Aucune n'est laissée ouverte.

| # | Affirmation v2 | Réalité mesurée | Traitement |
|---|---|---|---|
| **1** | « Mobile Money intégré — paiements MTN & Orange natifs avec rapprochement automatique et anti-fraude » *(p. 2, argument différenciant)* | `'Mobile Money'` est une valeur d'énumération sur le mode de paiement. Aucun appel réseau, aucune réconciliation. **Seul écart où l'argumentaire de couverture promet ce qu'aucune phase livrée ne contient** | **Phase 3**, lignes 1–2 · 7–10 j. En attendant : retirer de la page de couverture, conserver en « planifié » |
| **2** | « 11 langues » dont latin, lingala, haoussa *(p. 2 et p. 9)* | 10 locales livrées ; 8 seulement communes avec l'offre. Le japonais et le portugais sont livrés hors catalogue ; le lingala et le haoussa, qui **portent à eux seuls le positionnement panafricain**, sont absents | **Phase 1-B**, ligne 11 · 3–4 j. Les trois manquantes sont livrées ; `ja` et `pt` entrent au catalogue, qui passe à **13 langues** (D-R3) |
| **3** | « Audit log complet — chaque action est horodatée avec l'identité de l'utilisateur » *(p. 3)* | Trois registres append-only sur une soixantaine de collections. La consultation n'est journalisée nulle part | **Phase 1-B**, ligne 8 · 3–4 j |
| **4** | « JWT avec expiration courte + refresh tokens · sessions invalidées côté serveur · blacklist temporaire automatique » *(p. 3 et p. 5)* | Jeton de 7 jours, aucun rafraîchissement, aucune révocation, aucun verrouillage de compte. Seule la limitation par IP existe | **Phase 1-B**, ligne 3 · 3–4 j (D-R2) |
| **5** | « Sauvegarde quotidienne, restauration testée mensuellement, RPO < 24 h, RTO < 4 h, supervision 24/7 » + « Docker · Nginx · Certbot · CI/CD » *(p. 2 et p. 3)* | Un seul workflow d'intégration. Aucun script de sauvegarde. Le conteneur n'existe que pour la brique IA. **C'est un engagement contractuel adossé au prix SaaS mensuel** | **Phase 2**, ligne 4 · 8–12 j (D-R1) |
| **6** | « API-ready — architecture REST documentée, intégration externe possible dès la Phase 2 » *(p. 2)* | Aucun fichier de spécification d'API n'existe | **Phase 2**, ligne 5 · 3–4 j |

**Deux corrections à porter au support de vente sans attendre la livraison** :
le Mobile Money quitte la page de couverture jusqu'à la phase 3, et la mention
« 11 langues » devient « 10 langues, 13 à terme » jusqu'à la phase 1-B. Une
affirmation vérifiable en trente secondes de démonstration ne se laisse pas
courir.

---

## §12 — Décisions porteur en attente

Quatre arbitrages restent ouverts. Aucun n'est technique : chacun change ce qui
est construit, pas comment.

| # | Question | Options | Recommandation | Bloque |
|---|---|---|---|---|
| **D-K** | Politique de version de contrat | Cadence des versions majeures et durée de support de chacune | À trancher **avant** la phase 2 : c'est ce qui décide de la durée de vie commerciale d'un paquet | Phase 2, ligne 2 |
| **D-G** | Granularité de vente à l'unité | (a) La clé de registre est l'unité ; (b) sous-fonctionnalités sur le modèle de la grille IA | **(a) par défaut**, (b) seulement quand un module le justifie — le module IA le fait déjà | Phase 4-B |
| **D-J** | Le module `ai` en mode licencié | (a) Non vendu on-premise ; (b) vendu avec sa brique Python ; (c) hébergé chez l'éditeur | **(a) pour la V1** — les deux modules les plus chers sont les deux moins installables, et le vendre mal est pire que ne pas le vendre | Phase 4-B, §10.2 |
| **D-M** | Exploitation chez le client | La licence promet de se passer d'une équipe interne, mais exige replica set, stockage persistant, sauvegardes et reconstruction du frontend | **Un critère de qualification client.** Une offre d'infogérance réintroduirait un accès chez le client et doit rester un contrat distinct | Phase 4-B |
| **D-R6** | Re-dérivation de la grille | Les prix du §10 sont repris de la v2 et remappés, non recalculés | Recalculer après la phase 2, quand la version produit existera et que les charges seront confirmées par deux phases livrées | §10 |

---

## §13 — Articulation avec les documents voisins

| Document | Relation | Conséquence |
|---|---|---|
| `QA_TEST_STRATEGY.md` | **Fournit** les chantiers CH-0 à CH-7. CH-0 et CH-1 sont en phase 1-A/1-B, CH-2/3/7 en phase 2, CH-4/6 en phase 3, CH-5 en phase 4-B | Les deux tableaux de bord doivent rester cohérents. Un chantier CH terminé se répercute **ici** dans le même commit |
| `FEATURE_DELIVERY_DESIGN.md` | **Fournit** la voie 4-B. Ses phases 0 et 0 bis sont remontées en **phase 2** de ce document (contrat de plateforme, éclatement du registre) parce qu'elles ont une valeur propre hors licence | Ses phases 1 à 6 restent groupées en 4-B. L'ordre imposé de son §20.2 est préservé |
| `CAMPUS_ENTITLEMENT_DESIGN.md` | **Fondation.** Ses trois paliers sont la structure des deux grilles du §10 | Chantier clos. Seuls restent les trois gestes d'exploitation de la ligne 2 de la phase 1-B |
| `PHASE3_AI_DESIGN.md` | Le module IA, livré M0→M6 | Reste la ligne 4 de la phase 1-B. Sort du périmètre on-premise en V1 (D-J) |
| `POSTGRES_MIGRATION_ASSESSMENT.md` | Évalué, non engagé | Un changement de moteur serait un changement **majeur** de contrat, donc un nouveau snapshot de palier. À ne pas engager pendant les phases 2 à 4 |
| `docs/cours/` *(dépôt imbriqué)* | **Angle mort.** Douze fichiers de solution résolvent ce backend depuis leur position sur le disque, et certaines leçons comptent des figures réelles — modules, routes, modèles | Tout chantier qui déplace ou retire un module **fait mentir une leçon**. Lancer `docs/cours/check-solutions.sh` après les lignes 3 et 11 de la phase 4-B, après avoir réétalonné la ligne de base |

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

---

## §15 — Annexe · Méthode de mesure

Les chiffres de ce document ont été relevés sur les quatre dépôts le
**2026-08-21**. **Re-mesurez-les avant de vous en servir comme argument** ; les
commandes sont données pour que le relevé soit reproductible et non déclaratif.
Toutes s'exécutent depuis `~/Projects`.

| Indicateur | Valeur | Commande |
|---|---|---|
| Modules métier backend | **25** | `cd university/backend && ls modules/ \| wc -l` |
| Routes déclarées | **547** | `cd university/backend && grep -rhoE "router\.(get\|post\|put\|patch\|delete)\(" modules/ shared/ \| wc -l` |
| Fichiers de modèles Mongoose | **58** | `cd university/backend && find . -name "*.model.js" -not -path "./node_modules/*" -not -path "./docs/*" \| wc -l` |
| Clés du registre d'entitlement | **26** | `cd university/backend && node -e "console.log(require('./shared/constants/features.constants').FEATURE_KEYS.length)"` |
| Composition des paliers | **15 / 22 / 26** | `cd university/backend && node -e "const p=require('./shared/constants/features.constants').PLAN_PRESETS; for (const k of ['free','standard','premium']) console.log(k, p[k].length)"` |
| Suites unitaires backend | **63** | `cd university/backend && find tests/unit -name "*.test.js" \| wc -l` |
| Fichiers de composants frontend | **256** | `cd university/frontend && find src -name "*.jsx" \| wc -l` |
| Tests frontend | **0** | `cd university/frontend && grep -E "vitest\|jest\|playwright\|testing-library" package.json` |
| Tests end-to-end, toutes briques | **0** | — |
| Locales | **10** | `cd university/frontend && ls public/locales` |
| Rôles applicatifs connectés | **9** | `ADMIN · DIRECTOR · CAMPUS_MANAGER · TEACHER · STUDENT · PARENT · MENTOR · STAFF · PARTNER` |
| Étiquettes git | **0** sur 240 commits | `cd university/backend && git tag \| wc -l && git rev-list --count HEAD` |

> **Deux pièges de lecture.** `find src -name "*.jsx"` compte des **fichiers**,
> pas des composants : les « écrans significatifs » sont une estimation dérivée.
> Et le décompte des modèles se vérifie par deux commandes distinctes — fichiers
> `*.model.js` d'un côté, appels `mongoose.model()` de l'autre — parce qu'un
> fichier peut n'enregistrer aucun modèle et un modèle vivre hors d'un
> `*.model.js`.

---

*Fin du document. Mise à jour obligatoire du §0 et de la colonne « État » de la
phase concernée à chaque commit qui touche cette feuille de route.*
