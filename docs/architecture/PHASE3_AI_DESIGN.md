# Phase 3 — Conception des fonctionnalités IA (« Premium »)

> Rédigé le 2026-06-18. Document de **conception et de cadrage** : il décrit
> *quoi* construire, *comment*, et *dans quel ordre*, pour que la Phase 3 soit
> bâtie professionnellement **sans casser l'existant** et **dans la trajectoire
> du projet** (monolithe modulaire → PostgreSQL, multi-tenant campus, i18n,
> socle notifications).
>
> **Public visé** : un développeur IA qui rejoint le projet. Il connaît Python,
> les LLM et le RAG, mais **pas** ce backend. Ce document est sa source de vérité.
> Il doit le lire **en entier** avant d'écrire une ligne.
>
> **Statut** : conception approuvée ; **M0 à M6 réalisés (M0–M3 le 2026-07-03,
> M4, M5 et M5b le 2026-07-04, M6 le 2026-07-05)** — décisions D1–D12 tranchées
> (§15), squelette `ai-service/` livré (dépôt frère : FastAPI, Postgres+pgvector,
> S2S, Docker, CI), **module Node `ai` livré** (passerelle inerte + entitlement
> Campus §11.3), **ingestion + recherche hybride livrées** (Feature 3), **chat
> RAG SSE livré** (Feature 1), **analytics assisté livré** (Feature 2 — chiffres
> ERP narrés, jamais calculés par le LLM), **moteur quantitatif + advisors
> livrés** (§6.5/§6.6 — heuristiques D8 versionnées, mode proposition strict),
> **durcissement échelle livré** (M6 — cache Redis-optionnel, observabilité
> Prometheus + request-id, budget consolidé + alerting, purge de rétention,
> eval RAG étendue, harnais de charge) — **tests de sécurité §4.6 verts**
> (recherche, chat, analytics ET advisors). **Tous les jalons M0→M6 sont
> réalisés** ; **décisions porteur D10 (prix) et D4 (hébergement) tranchées le
> 2026-07-06** (§15/§18.3 : plans 0/99/299 €, Postgres Neon UE, LLM premium
> Anthropic sous DPA) ; **bench D2 exécuté le 2026-07-07 → bge-m3 (1024d)
> conservé, colonne `vector(1024)` définitive** (§15/D2). Restent des préalables
> opérationnels (déploiement + mesures de charge cible, QA visuelle de la
> première surface UI). L'état d'avancement est tenu au §18 (journal de
> reprise) — **le lire en premier si vous reprenez le chantier**.
>
> **Révisions** : v1 (2026-06-18) socle d'architecture. **v2 (2026-06-18)** ajoute
> les **surfaces frontend & la valeur par persona** (§1.4), le **moteur
> quantitatif déterministe + le sous-système « advisors » métier** (ADR-4, §6.5,
> §6.6) et une **section sécurité durcie** (modèle de menace §4.4, contrôles
> résiduels §4.5, tests de sécurité de première classe §4.6). **v3 (2026-06-18)**
> corrige une incohérence d'endpoint (`/analytics/:report` vs `/advisors/:advisor`)
> et comble des manquements : **isolation intra-campus** (§4.1.4, pas seulement
> inter-campus), **piège de réindexation des embeddings** (§6.4), re-vérification
> d'autorisation **en lot** (§6.2), **pièges SSE** (§6.1), mécanisme concret de
> non-exposition de `/internal/ai` (§4.2). **v4 (2026-07-03)** comble les manques
> relevés en revue et acte deux directives produit du porteur : **ADR-5 —
> stratégie fournisseur « free-first, config-driven »** (démarrage sur des API
> gratuites, bascule payante par simple configuration, par campus, **sans
> modification de code** — §2, §6.4bis), **entitlement « Premium » par campus**
> (§11.3), **chiffrage capacité & coût** (§10bis), **contrat de débit
> d'ingestion** (§6.3.1), **contrats d'API figés** (Annexe B), **distribution du
> document** (§17). **v4.1 (2026-07-03)** approfondit la **plus-value attendue**
> (§1.4 : cas d'usage ancrés dans l'existant, différenciateurs produit, lien
> valeur ↔ plans de l'entitlement, métriques de validation §1.4.3). **v4.2
> (2026-07-03)** clôt le **jalon M0** : les 12 décisions ouvertes du §15 sont
> **tranchées** (D1–D12, avec justification et condition de révision), le
> **journal d'avancement §18** est créé (reprise du chantier par un tiers sans
> contexte), et `docs/architecture/` est sorti du `.gitignore` (D12, §17).
> **v4.3 (2026-07-03)** clôt le **jalon M1** : dépôt frère `ai-service/` livré
> (squelette §5.1, S2S §4.2, schéma pgvector `vector(1024)` D2, profils ADR-5,
> Docker/CI) — détail et vérifications au §18.1. **v4.4 (2026-07-03)** clôt le
> **jalon M2** : module Node `ai` livré (façade §5.2, routes `/api/ai/*` +
> `/internal/ai/*`, S2S conforme au contrat M1, inerte sans `AI_SERVICE_URL`),
> `aiEntitlement` sur `Campus` + endpoints admin audités (§11.3) — détail au §18.1.
> **v4.5 (2026-07-03)** clôt le **jalon M3** : ingestion GED + `/search` hybride
> livrés de bout en bout (Node : `/internal/ai/ingestables` + `authorize-citations`
> réels, signal d'ingestion fire-and-forget côté `document` ; service : pipeline
> §6.3 + `PgVectorStore` hybride RRF + `/ingest`, `/usage`, worker CLI), **tests
> de sécurité §4.6 verts et bloquants en CI** (suite pgvector réelle). Annexe B
> précisée (enveloppe `{ success, data }` de l'API interne, param `sourceId`).
> Détail au §18.1. **v4.6 (2026-07-04)** clôt le **jalon M4** : chat RAG SSE
> livré (service : `/chat` conforme Annexe B + `/conversations`, retrieval
> re-autorisé **avant** l'appel LLM §4.5, garde-fous injection §4.1.6, langue
> utilisateur, comptabilité tokens ; Node : claims S2S `language` +
> `monthlyTokenBudget` ajoutés au contrat §4.2, `sendPaginated` sur les
> conversations), **tests §4.6 re-autorisation chat + injection verts**, eval
> RAG de base en CI, **premier client API frontend** (`aiService.js`).
> Détail au §18.1. **v4.7 (2026-07-04)** clôt le **jalon M5** : analytics
> assisté livré (Node : agrégats déterministes `/internal/ai/aggregates/:name`
> sans PII via les façades result/student, registre partagé
> `AI_ANALYTICS_REPORTS` à 3 rapports ; service : `/analytics/:report` réel —
> **agrégat ERP re-autorisé à CHAQUE appel avant le cache**, snapshot réutilisé
> seulement à figures identiques, narration en zone non fiable, langue
> utilisateur ; frontend : `runAiAnalytics`). Deux bugs attrapés par le boot
> réel (cast ObjectId des pipelines, contournement du gate de rôle par le
> cache) — corrigés et testés. Détail au §18.1. **v4.8 (2026-07-04)** clôt le
> **jalon M5b** : moteur quantitatif déterministe + advisors livrés (Node :
> 3 agrégats advisors sans PII via les façades finance/partner —
> `finance-overdue-aging`, `finance-cashflow-monthly`, `lead-funnel` —,
> gate de rôle **par agrégat** (D9 : direction seulement), passerelle
> `/advisors/:advisor` durcie ; service : `engine/` heuristiques D8
> versionnées (`heuristics-1.0.0`), advisors finance/academic/marketing en
> **mode proposition strict** — structure, chiffres et actions décidés par
> l'engine, le LLM ne fait que la prose et retombe sur un texte déterministe
> si sa sortie JSON est invalide ; frontend : `runAiAdvisor`). Boot réel
> vérifié de bout en bout. Détail au §18.1. **v4.9 (2026-07-05)** clôt le
> **jalon M6 — durcissement échelle** : cache derrière l'abstraction `Cache`
> (Redis si `REDIS_URL`, sinon cache mémoire borné — **cost-only : jamais une
> décision d'autorisation**, seul l'embedding de requête est mis en cache) ;
> **observabilité** (`/metrics` Prometheus — latence, statut, tokens, **coût USD
> via table de prix §10bis surchargée par env**, cache, refus budget — +
> middleware ASGI de request-id propagé Node ↔ service ↔ Node) ; **budget
> consolidé** (`enforce_budget` unique pour chat/analytics/advisors, alerte WARN
> à 80 %, métrique de refus) ; **purge de rétention** D7 (tâche périodique) ;
> **eval RAG étendue** (gold set 5→7) ; **harnais de charge** livré
> (`scripts/loadtest.py`). Détail au §18.1.
> **v4.10 (2026-07-06)** — hors jalon, **décisions porteur** : D10 (prix des
> plans : free 0 € / standard 99 € / premium 299 € par campus/mois) et D4
> (hébergement prod : Postgres Neon UE, LLM premium Anthropic sous DPA, Redis
> différé) tranchées. Aucun code touché ; §15, §18.1 et §18.3 mis à jour.
> **v4.11 (2026-07-07)** — hors jalon, **bench D2 exécuté** (corpus jouet,
> sentence-transformers CPU) : bge-m3 (1024d) recall@1 1.00, e5-base (768d)
> recall@1 0.83 (recall@3 = 1.00 pour les deux). **Décision porteur : conserver
> bge-m3, colonne `vector(1024)` définitive** — aucun code touché. §15/D2 et
> §18.3 mis à jour ; ce préalable opérationnel est clos.

---

## 0. TL;DR (résumé exécutif)

- **3 fonctionnalités** : (1) **Assistant conversationnel** (chat RAG sur les
  données autorisées de l'utilisateur), (2) **Analytics & Reporting** (synthèses
  et tableaux de bord assistés par IA), (3) **Recherche interne sémantique** (RAG
  sur les documents et entités).
- **Plus-value attendue (§1.4, normatif)** : self-service multilingue
  étudiant/parent (moyenne, solde dû, examens), risque de décrochage rendu
  actionnable pour l'enseignant, analytics en langage naturel + priorisation
  des relances d'impayés pour la direction (**directement monétisable**),
  recherche par le sens sur la GED, insights proactifs via le socle de
  notifications. Mesurée par les métriques du §1.4.3 (M2/M3).
- **Architecture retenue** : un **micro-service Python/FastAPI séparé**
  (`ai-service/`, chemin frère de `backend/`), **stateless**, scalable
  horizontalement. Côté Node, un **module passerelle `ai`** mince qui respecte la
  convention façade `{ routes, service }` et **proxifie** vers le service IA.
- **Le backend Node reste l'unique passerelle d'API et le système de référence.**
  Le front ne parle **jamais** directement au service IA. Toute l'authentification,
  l'isolation campus et le rate-limiting restent dans Node.
- **Le service IA ne touche JAMAIS MongoDB.** Il lit les données de l'ERP via une
  **API interne authentifiée** exposée par Node (qui applique l'isolation campus),
  et écrit ses propres données (embeddings, conversations, snapshots) dans **sa
  propre base PostgreSQL + pgvector**.
- **PostgreSQL/pgvector dès la Phase 3** : c'est cohérent avec la migration
  Postgres déjà planifiée (voir `POSTGRES_MIGRATION_ASSESSMENT.md`). On introduit
  Postgres ici **en terrain neuf** (zéro risque de migration de données existantes),
  ce qui en fait le **pilote Postgres** du projet.
- **Fournisseur LLM par défaut : Anthropic (Claude)**, derrière une **abstraction
  fournisseur** swappable. Idem pour les embeddings.
- **Stratégie « free-first, config-driven » (ADR-5)** : la v1 est exploitable
  **sans aucune clé payante** (provider `mock` en CI, API gratuites en phase de
  test, embeddings self-hosted). La bascule vers un fournisseur payant se fait
  **par configuration, par campus, sans modifier le code** : ajouter la clé dans
  l'env + changer le profil du campus suffit.
- **Entitlement par campus (§11.3)** : l'IA est une capacité **activable par
  tenant** — plan (`free`/`standard`/`premium`), budget mensuel de tokens,
  features à la carte — appliquée côté Node et transportée dans le JWT S2S.
  C'est la brique qui rend le « Premium » du titre concret et monétisable.
- **Deux moteurs distincts dans `ai-service`** : un **moteur quantitatif
  déterministe** (ML/statistiques classiques — prévisions, scoring, anomalies) qui
  produit les chiffres, et la **couche générative (LLM)** qui **explique/recommande**
  par-dessus. **Le LLM n'invente jamais un chiffre.**
- **Sous-système « advisors » métier** (Marketing, Finance/Compta, Académique) :
  des conseillers composés sur le moteur quantitatif + le LLM, **en mode
  proposition (human-in-the-loop)** — l'IA suggère, un humain valide ; l'IA n'écrit
  jamais d'enregistrement métier.
- **Sécurité = défense en profondeur, testée en CI** : isolation campus côté Node,
  re-vérification d'autorisation au moment de la réponse, modèle de menace explicite
  (§4.4) et tests de sécurité bloquants (§4.6). « Sûr » n'est vrai qu'**implémenté
  et testé**.

---

## 1. Où la Phase 3 s'inscrit dans le projet

### 1.1 Ce qui existe déjà (et qu'il faut respecter)

Le backend (`backend/`) est un **monolithe modulaire** Node/Express/Mongoose :
**22 modules**, chacun exposant une **façade** `{ routes, service }` via son
`index.js`, avec un invariant strict :

- **Accès aux models** : seul `modules/<x>/<x>.repository.js` touche les models
  Mongoose. Controllers et services passent par le repository. (Étape 0 de la
  préparation Postgres — déjà terminée pour les 22 modules.)
- **Inter-modules** : un module n'appelle un autre **que** via sa façade service
  (`require('../<autre>').service.<fn>()`), jamais ses models. Exemples vivants :
  `notification.service.notify(...)`, `student.service.getStudentContact(...)`,
  `campus.service.getCampusNotificationContact(...)`.
- **Isolation multi-tenant** : chaque ressource porte un `schoolCampus`/`campusId`.
  Le helper `shared/utils/validation-helpers.js → buildCampusFilter(user, ...)`
  dérive le filtre campus du JWT. **Toute requête doit être scopée campus**, sauf
  rôles globaux (`ADMIN`, `DIRECTOR`).
- **Auth** : `shared/middleware/auth.js` expose `authenticate` (vérifie le JWT,
  pose `req.user = { id, role, campusId, ... }`) et `authorize(roles)`.
- **i18n** : `shared/i18n/` est la **source unique** des langues (10 langues) et
  des catalogues. `settings.service.getPreferredLanguage(userId)` /
  `getPreferredLanguages(ids)` donnent la langue préférée d'un utilisateur
  (portée par `UserPreferences`, **pas** par les models métier).
- **Config** : `shared/configs/general.config.js` centralise la config par
  section (`jwt`, `email`, `notification`, …), alimentée par `.env`.
- **Jobs** : cron déclarés dans `server.js` (ex. retry notifications toutes les
  10 min) ; workers événementiels (`modules/exam/exam-analytics.worker.js`).
- **Tests** : Jest. Tests unitaires de repository (models mockés, **sans DB**),
  tests de contrat de façade (`tests/contracts/facades.test.js`), smoke Supertest.
  0 erreur ESLint requise.

### 1.2 La trajectoire PostgreSQL (à ne pas contrarier)

Décision projet (voir `POSTGRES_MIGRATION_ASSESSMENT.md`) : la couche repository
est faite ; **la migration Postgres est différée** tant qu'aucune contrainte
réelle ne la justifie. Recommandations actées qui **s'appliquent à la Phase 3** :

- **Ids en `uuid`** (pas `bigint`, pas d'ObjectId Mongo côté Postgres) — impact
  frontend minimal, pas d'ordre implicite.
- Postgres cible probable : Neon / Supabase / RDS (hébergé, scalable).

**Conséquence pour la Phase 3** : on n'attend pas la migration. On **introduit
Postgres maintenant, isolé, pour les seules données IA** (embeddings,
conversations, snapshots analytics). C'est sans risque (données neuves) et ça
**valide la stack Postgres** (extension pgvector, hébergement, pooling) avant la
grande migration. La Phase 3 devient le **pilote Postgres** de fait.

### 1.3 Définition de la Phase 3 (course doc)

Périmètre défini dans `docs/cours/track-12-phase3-premium/README.md` :

| Feature | Description courte |
|---|---|
| **AI Chat Assistant** | Intégration LLM + prompt engineering |
| **Data Analytics & Reporting** | Pipeline analytique + dashboards |
| **Internal Search** | Recherche vectorielle + RAG |

### 1.4 Surfaces frontend & plus-value attendue par persona (enrichi v4.1)

> **Pourquoi cette section est normative** : elle est la justification produit du
> module. Tout arbitrage ultérieur (ordre de build §15, découpage des plans
> §11.3, priorisation d'un advisor §6.6) doit pouvoir se rattacher à une ligne
> de cette section. Une capacité IA qui ne sert aucun des apports listés ici
> n'entre pas dans le périmètre v1.

**Comment le front interagit (rien de nouveau pour lui)** : il appelle `/api/ai/*`
exactement comme n'importe quelle route ERP (même JWT, même session). Trois
patterns d'UI réutilisables partout :

- **Widget de chat** — réponse **streamée en SSE** (le texte s'écrit en direct,
  time-to-first-token bas).
- **Barre de recherche sémantique** — recherche par le sens, résultats avec
  **liens cliquables** vers les fiches ERP (citations vérifiées).
- **Encarts IA dans les dashboards existants** — boutons « Résumer / Expliquer »
  et **insights proactifs** poussés via le **socle de notifications** déjà en place.

Invariants UX : chaque réponse est **sourcée** (citations = ids ERP → liens),
**scopée campus**, et **dans la langue préférée** de l'utilisateur
(`settings.getPreferredLanguage`, déjà câblé). Le front n'a **jamais** de clé LLM
ni d'URL du service IA — il ne connaît que l'API Node.

#### 1.4.1 Valeur concrète, par rôle existant du projet

Chaque apport est **ancré sur une capacité déjà livrée** du backend (colonne de
droite) — l'IA ne crée pas de nouvelles données, elle rend l'existant accessible
et actionnable.

| Rôle | Apport pertinent | Ancrage dans l'existant |
|---|---|---|
| **Étudiant** | « Quelle est ma moyenne ? », « Quand est mon prochain examen ? », « Explique ma note », « **Combien dois-je encore ?** » — en libre-service, dans sa langue. Aide à la révision sur le contenu de cours. | Suivi paiement `StudentFee`/ledger (livré 2026-06), module `result`, module `exam`, i18n 10 langues + `UserPreferences.preferredLanguage`. |
| **Parent** | Synthèse de progression de l'enfant, présences, **solde de scolarité dû**, dans sa langue — sans naviguer plusieurs écrans dans une langue tierce. | Portail parent existant, ledger finance, socle i18n. |
| **Enseignant** | Synthèse de performance d'une classe au trimestre ; **repérage des élèves en difficulté** — `computeDropoutRisk` existe déjà mais reste enfoui : l'IA le rend **visible et actionnable** ; brouillons de feedback ; recherche documentaire. | `computeDropoutRisk`, module `result`, module `attendance`, GED. |
| **Campus Manager / Directeur** | **C'est là que la valeur est la plus forte** : analytics en langage naturel (tendances d'inscription, conversion des leads `partner`) ; **priorisation des relances d'impayés** — qui relancer d'abord, **directement monétisable** puisque ça accélère le cash ; **prévision de trésorerie** ; **détection d'anomalies** au-delà de l'`IP_BURST` actuel (fraude préinscription). | Modules `finance` (overdue cron), `partner` (leads/commissions), `public-portal` (anti-fraude), moteur quantitatif §6.5. |
| **Staff** | Réponses procédurales, recherche documentaire dans la GED. | Module `document` (versioning, partage, audit). |
| **Partner** | Statut de ses leads, synthèse de commissions. | Module `partner`. |

#### 1.4.2 Trois apports structurants (au-delà des personas)

1. **Le chat multilingue est un différenciateur produit réel** pour un ERP
   multi-pays : le parent lusophone ou arabophone n'a plus besoin de naviguer
   une UI dans une langue tierce — il **demande, dans sa langue**, et la réponse
   arrive dans sa langue (les 10 langues et `getPreferredLanguage` sont déjà
   câblés ; coût marginal quasi nul pour l'IA).
2. **La recherche sémantique change l'usage quotidien de la GED** : le module
   `document` a le versioning, le partage et l'audit — mais on n'y trouve que ce
   qu'on **sait** chercher. La recherche hybride par le sens (F3) rend le fonds
   documentaire réellement exploitable par le staff, sans réorganisation.
3. **Insights proactifs poussés via le socle de notifications** (déjà en place) :
   alerte décrochage, écart budgétaire, impayé qui s'aggrave — l'ERP **prévient**
   au lieu d'attendre qu'on consulte. C'est le passage d'un outil de saisie à un
   outil de pilotage.

**Cohérence valeur ↔ monétisation** : le découpage des plans de l'entitlement
(§11.3) suit exactement ce gradient de valeur — `chat` et `search` (valeur
individuelle, coût faible) dans les plans d'entrée ; `analytics` et `advisors`
(valeur direction, la plus forte et la plus monétisable) réservés aux plans
supérieurs. Si le gradient de valeur change, le découpage des plans doit être
revu — pas l'inverse.

#### 1.4.3 Comment cette plus-value sera mesurée (livrable M2/M3)

La plus-value ci-dessus est une **hypothèse produit** tant qu'elle n'est pas
mesurée. Instrumentation minimale, sans PII, agrégée par campus :

| Métrique | Signal de valeur attendu |
|---|---|
| Taux d'adoption par rôle (utilisateurs actifs IA / utilisateurs actifs) | L'usage se répète après la 1ʳᵉ semaine (pas un effet nouveauté). |
| % de réponses chat avec **citation cliquée** | Les réponses mènent à l'ERP, elles ne remplacent pas la vérification. |
| Questions self-service étudiant/parent (moyenne, solde, examen) | Baisse des sollicitations du staff pour ces demandes. |
| Délai moyen de relance d'impayé après alerte IA | Raccourcissement mesurable = valeur cash directe. |
| Recherches sémantiques avec ouverture de document | La GED est consultée là où elle ne l'était pas. |

Ces compteurs s'appuient sur la table `usage_monthly` (§11.3) et un événement
d'audit par interaction — aucun contenu de conversation n'est journalisé à cette
fin. Revue de ces métriques = critère d'entrée pour élargir le périmètre (M3+).

En une phrase : l'IA transforme un ERP **où il faut savoir où chercher** en un ERP
**à qui on demande — et qui prévient** — tout en restant un simple module derrière
l'API Node.

---

## 2. Décision d'architecture (ADR)

### ADR-1 — Micro-service Python séparé vs intégration in-process Node

**Décision : micro-service Python/FastAPI séparé.**

**Pourquoi (pour une cible « millions d'utilisateurs ») :**

1. **Écosystème** : le RAG, les embeddings, l'orchestration LLM, l'évaluation
   (eval), le chunking, les SDK (Anthropic, OpenAI, sentence-transformers,
   LangChain/LlamaIndex si besoin) sont **matures et idiomatiques en Python**.
2. **Profil d'exécution incompatible avec le monolithe** : les appels LLM sont
   **longs et I/O-bound** (streaming de plusieurs secondes), l'ingestion
   d'embeddings est **CPU/GPU-bound**. Les exécuter dans l'event-loop Node du
   monolithe **dégraderait toutes les routes ERP**. Un service séparé **scale
   indépendamment** (on ajoute des répliques IA sans toucher l'ERP).
3. **Cycle de vie & équipe** : déploiement, dépendances (CUDA, modèles), montées
   de version et incidents de l'IA sont **isolés** du cœur ERP. Un crash du
   service IA ne fait pas tomber l'ERP (et réciproquement).
4. **Sécurité & gouvernance** : surface réseau réduite (le service IA est
   **interne**, jamais exposé au public), secrets LLM cloisonnés.

**Alternatives rejetées :**
- *Tout dans Node* : bloque l'event-loop, mélange les profils de charge, pousse
  le RAG hors de son écosystème. Rejeté.
- *Service IA accédant directement à MongoDB* : viole l'isolation modulaire et
  l'isolation campus, duplique la logique d'accès, couple le service IA au schéma
  Mongo (qui va migrer vers Postgres). **Rejeté fermement.**

### ADR-2 — Le front ne parle qu'à Node ; Node proxifie vers l'IA

**Décision : un module Node `ai` (façade `{ routes, service }`) sert de
passerelle.** Le frontend appelle `/api/ai/...` comme n'importe quelle route ERP
(même JWT, même rate-limiter, même isolation campus). Le module `ai` **proxifie**
les requêtes vers `ai-service` via HTTP interne, en **streamant** les réponses
(SSE) sans bufferiser.

**Pourquoi :** une seule surface d'authentification et d'autorisation (celle qui
existe déjà), un seul point d'isolation campus, pas de CORS ni de gestion de
token LLM côté navigateur, et **respect total de la convention des 22 modules**
(le module `ai` ressemble à tous les autres). Non-breaking par construction.

### ADR-3 — Magasin vectoriel : PostgreSQL + pgvector

**Décision : PostgreSQL avec l'extension `pgvector`** comme base du service IA
(vecteurs + métadonnées + conversations + snapshots).

**Pourquoi :**
- **Aligné sur la migration Postgres** : on n'introduit pas une techno jetable
  (Pinecone/Qdrant) qu'il faudrait ré-héberger ; Postgres est **déjà la cible**.
- **Une seule base transactionnelle** pour vecteurs *et* métadonnées : pas de
  synchronisation à 2 magasins, recherche **hybride** (vecteur + `tsvector`
  plein-texte + filtres SQL) dans une seule requête.
- **Multi-tenant trivial** : colonne `campus_id` + filtre SQL (et/ou RLS Postgres)
  — l'isolation campus se prouve en SQL.
- **Suffisant à grande échelle** avec index HNSW (`pgvector >= 0.5`) ; si un jour
  le volume l'exige, l'abstraction `VectorStore` (voir §6.4) permet de basculer
  vers un moteur dédié sans réécrire la logique RAG.

**Alternative gardée en réserve :** moteur vectoriel dédié (Qdrant) **derrière la
même interface**, si les benchmarks de latence/volume le justifient plus tard.

### ADR-4 — Deux moteurs : quantitatif déterministe vs génératif (LLM)

**Décision : séparer dans `ai-service` un moteur quantitatif déterministe (ML /
statistiques) et la couche générative (LLM).** Le moteur quantitatif **produit
les chiffres** (prévisions, scores, détections d'anomalies) ; le LLM **explique,
met en forme et recommande** par-dessus. **Le LLM n'invente jamais un chiffre.**

**Pourquoi :**
- Demander à un LLM de *prédire* un cash-flow ou de *scorer* un lead est une
  erreur de conception : **coûteux, non reproductible, numériquement faux**. Les
  prévisions/scoring se font avec des modèles dédiés (séries temporelles, gradient
  boosting…), **reproductibles et testables**.
- Python est idéal pour ce moteur (`pandas`, `scikit-learn`, `statsmodels`/Prophet)
  — il vit **dans le même service**, à côté du RAG, mais en couche distincte.
- Cohérent avec l'exigence du doc Postgres (§4) : **les agrégats sont
  déterministes et testés en non-régression** ; l'IA ne fait que les narrer.

**Conséquence** : les capacités « analyse & proposition métier » (Marketing,
Finance, Compta — voir §6.6) reposent sur ce moteur, **pas** sur le LLM seul.

**Alternative rejetée** : *LLM-only analytics* (le LLM calcule à partir de données
brutes). Rejeté pour coût, non-déterminisme et risque d'erreur numérique.

### ADR-5 — Stratégie fournisseur « free-first, config-driven » (par campus)

**Décision (directive porteur, 2026-07-03) : le choix du fournisseur LLM est
résolu au moment de la requête, à partir de profils de configuration nommés —
jamais codé en dur.** Trois implémentations de `LLMProvider`, toutes présentes
dès la v1 :

| Implémentation | Rôle | Clé requise |
|---|---|---|
| `mock` | Dev/CI : réponses déterministes, zéro appel réseau. Interdit hors `ENVIRONMENT=development\|test`. | aucune |
| `openai_compatible` | **Couvre la quasi-totalité des offres gratuites** via une seule classe (`base_url` + `model` configurables) : Groq, Gemini (endpoint compat OpenAI), OpenRouter (modèles `:free`), Mistral (tier expérimental), **Ollama self-hosted** (zéro clé, zéro quota). | selon l'offre (souvent gratuite) |
| `anthropic` | Production payante : Claude via SDK officiel (tiering §10bis). | `ANTHROPIC_API_KEY` |

**Pourquoi :**
1. **Tester plusieurs semaines sans dépense** : le pipeline complet (ingestion,
   RAG, chat, analytics) se valide sur un free tier ou sur Ollama local. La
   qualité de réponse est moindre, mais l'architecture, la sécurité et les
   contrats se prouvent à coût nul.
2. **Zéro modification de code à l'activation d'une clé** : les clés sont lues
   de l'environnement **au runtime** ; ajouter `ANTHROPIC_API_KEY` + basculer le
   profil = tout fonctionne. C'est un critère d'acceptation (§16), pas un vœu.
3. **Bascule par structure cliente** : le profil LLM est porté par
   l'**entitlement du campus** (§11.3) et voyage dans le JWT S2S — un campus
   pilote reste sur le profil gratuit pendant qu'un campus payant utilise
   Claude, **dans la même instance** du service.

**Asymétrie critique — les embeddings ne suivent PAS cette logique par tenant.**
Un index vectoriel n'est interrogeable qu'avec le modèle qui l'a produit (§6.4) :
un modèle d'embeddings **par campus** fragmenterait l'index et rendrait toute
migration ingérable. Décision : **un seul modèle d'embeddings global,
self-hosted** (sentence-transformers — candidats : `BAAI/bge-m3` 1024d ou
`intfloat/multilingual-e5-base` 768d, tous deux multilingues, cohérents avec les
10 langues du projet). Gratuit, sans quota, sans clé, et les documents **ne
quittent jamais l'infrastructure** (bonus résidence/RGPD). Un upgrade
d'embeddings = réindexation complète planifiée (mécanisme §6.4), jamais un
réglage par tenant.

**Limites assumées des free tiers (à documenter auprès des campus pilotes) :**
- quotas faibles (RPM/requêtes-jour) → suffisant pour tester, pas pour la prod
  à l'échelle ; le rate-limiter Node (§6.1) doit être **plus strict** que le
  quota amont pour dégrader proprement (429 propre plutôt qu'erreur amont) ;
- **certains free tiers se réservent le droit d'exploiter les données envoyées**
  → règle absolue : **jamais de PII réelle vers un profil gratuit** — données de
  seed/démo uniquement, ou Ollama self-hosted si un pilote exige des données
  réelles ;
- latence et disponibilité non garanties → le fallback `503 AI degraded` reste
  la réponse propre.

**Alternative rejetée** : coder le fournisseur au niveau du code d'appel (un
`if provider == ...` dans `rag.py`/`chat.py`). Rejeté : c'est précisément ce que
l'abstraction §6.4 interdit ; la logique métier ne connaît que l'interface.

---

## 3. Architecture cible (vue d'ensemble)

```
                           ┌────────────────────────────────────────────┐
                           │                FRONTEND (web/mobile)          │
                           └───────────────────────┬──────────────────────┘
                                                   │  HTTPS + JWT (existant)
                                                   ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         backend/  (Node/Express — INCHANGÉ + module `ai`)        │
│                                                                                  │
│   /api/ai/*  ──►  module `ai` (façade { routes, service })                       │
│      • authenticate + authorize + rate-limiter  (réutilisés)                     │
│      • buildCampusFilter → scope campus injecté dans chaque appel                │
│      • ai.service = client HTTP vers ai-service (streaming SSE pass-through)      │
│                                                                                  │
│   /internal/ai/*  ──►  API INTERNE (lecture ERP pour le service IA)              │
│      • protégée par un JWT de service (S2S), jamais exposée publiquement         │
│      • renvoie des données DÉJÀ scopées campus (documents, résultats, etc.)      │
│      • s'appuie sur les façades service existantes (document/result/student…)    │
└───────────────┬──────────────────────────────────────────────┬─────────────────┘
                │  HTTP interne (S2S JWT)                        │  HTTP interne (S2S JWT)
                ▼                                                ▲
┌──────────────────────────────────────────────────────────────┴─────────────────┐
│                      ai-service/  (Python / FastAPI — NOUVEAU, repo frère)        │
│                                                                                  │
│   API (FastAPI)                                                                  │
│     POST /chat            (RAG + LLM, streaming SSE)                              │
│     POST /search          (recherche sémantique/hybride)                         │
│     POST /analytics/:report   (synthèses descriptives sur agrégats ERP)          │
│     POST /advisors/:advisor   (conseillers métier, engine + LLM, human-in-loop)  │
│     POST /ingest          (déclenche/forcer l'indexation)                        │
│     GET  /healthz /readyz                                                         │
│                                                                                  │
│   Couches : api → services (rag, chat, analytics) ┬─ providers (llm, embeddings) │
│             ├─ engine (forecasting/scoring/anomaly — déterministe, PAS LLM)      │
│             ├─ advisors (marketing/finance/academic — engine + LLM, proposition) │
│             └─ stores (vector_store, repo Postgres) → clients (erp_client S2S)    │
│                                                                                  │
│   Worker d'ingestion (asynchrone, file de tâches)                                │
└───────────────┬──────────────────────────────────┬──────────────────────────────┘
                │                                    │
                ▼                                    ▼
   ┌─────────────────────────┐         ┌──────────────────────────────┐
   │  PostgreSQL + pgvector   │         │  Fournisseur LLM (Anthropic)  │
   │  (base PROPRE au service)│         │  + fournisseur d'embeddings    │
   │  vecteurs, chunks,       │         │  (derrière abstraction)        │
   │  conversations, snapshots│         └──────────────────────────────┘
   └─────────────────────────┘
```

**Invariant de flux de données :** `ai-service` n'a **aucun** accès à MongoDB.
Pour toute donnée ERP, il appelle `/internal/ai/*` sur Node, qui renvoie des
données **déjà filtrées par campus et par autorisation**. `ai-service` ne stocke
que des dérivés (embeddings, historiques de chat) dans **sa** base Postgres.

---

## 4. Modèle de sécurité et multi-tenant (CRITIQUE — lire avant tout code)

C'est la partie où une erreur est inacceptable : **une fuite inter-campus ou une
exfiltration de PII via le LLM** est un incident majeur.

### 4.1 Règles d'or

1. **L'isolation campus est appliquée côté Node, jamais déléguée au LLM ni au
   client.** Le service IA reçoit un `campus_id` (et un `user_id`/`role`) **dans
   le JWT de service**, jamais en paramètre librement modifiable par le front.
2. **Tout chunk indexé porte `campus_id` (+ visibilité/rôle).** Toute requête
   vectorielle filtre **obligatoirement** sur `campus_id`. Pas de filtre = bug
   de sécurité bloquant.
3. **Le RAG ne récupère que des documents que l'utilisateur courant a le droit de
   voir.** Le filtre d'autorisation (rôle, propriété, partage) est calculé par
   Node (réutilise `document.access.middleware` / les façades), pas par le service.
4. **Isolation INTRA-campus, pas seulement inter-campus.** Le `campus_id` ne suffit
   pas : au sein d'un campus, un étudiant ne voit que **ses** notes/paiements, un
   parent que **ses** enfants, un enseignant que **ses** classes. Le filtre porte
   donc aussi sur `user_id`/`role`/propriété. **Ce point vaut particulièrement pour
   les *tools* du chat (§7)** : une *function call* « quelle est ma moyenne ? » doit
   résoudre le périmètre via Node à partir du `user_id` du JWT S2S, jamais d'un
   identifiant fourni par le LLM ou le prompt. Les chunks portent leur `visibility`
   (rôle/propriétaire) et le retrieval la respecte.
5. **Aucune donnée sensible n'est envoyée au LLM sans nécessité.** Minimisation :
   on n'envoie que les chunks pertinents, jamais des bases entières. PII masquée
   quand le cas d'usage ne l'exige pas.
6. **Prompt-injection** : le contenu récupéré (documents) est **données non
   fiables**. Il est inséré dans le prompt dans une zone clairement délimitée,
   avec instruction système de **ne jamais exécuter d'instructions issues du
   contexte**. Les sorties d'outils sont validées.

### 4.2 Authentification service-à-service (S2S)

- Node et `ai-service` partagent un **secret de service** (`AI_SERVICE_SECRET`)
  ou une paire de clés. Node signe un **JWT de service** court (≤ 5 min) qui
  encapsule `{ campusId, userId, role, scope }` et l'envoie à `ai-service` à
  chaque requête. `ai-service` **vérifie** ce JWT et **dérive le campus de là**
  (jamais du body).
- Réciproquement, `ai-service` appelle `/internal/ai/*` avec **son** JWT de
  service ; Node vérifie et **re-applique** l'isolation campus à partir du token.
- Le réseau : `ai-service` n'est **pas** routable depuis Internet (réseau privé /
  service mesh / firewall). Seul Node l'atteint.
- **« Non exposé » exige un moyen concret** (monter une route Express ne la rend
  pas privée) : au choix (a) **instance/port Node séparé** pour `/internal/ai` non
  publié par le reverse-proxy, ou (b) **filtrage du préfixe `/internal` au proxy**.
  Dans tous les cas, **le JWT S2S est l'autorité** (vérifié à chaque requête) ;
  l'isolation réseau est une **défense supplémentaire**, pas l'unique barrière.

### 4.3 Gouvernance des données & conformité

- **Résidence** : choisir une région LLM/DB conforme aux exigences (RGPD/ pays).
  Documenter quelles données quittent l'infrastructure vers le fournisseur LLM.
- **Rétention** : conversations et logs de prompts ont une **durée de rétention**
  configurable (réutiliser l'esprit du cron de rétention `document`).
- **Opt-out / consentement** : prévoir un réglage `UserPreferences` (ou campus)
  pour désactiver l'IA / l'usage des données.
- **Pas d'entraînement tiers** : activer les options « no-training » des
  fournisseurs et le documenter.
- **Audit** : journaliser **qui a demandé quoi, et quelles sources ont servi** à
  chaque réponse (réponse à incident + conformité). Logs scopés campus.
- **Données sensibles** : pour les cas les plus sensibles (finance/PII), envisager
  un **modèle self-hosted** ou un fournisseur avec garanties de résidence, plutôt
  qu'une API publique.

### 4.4 Modèle de menace (STRIDE-léger)

Lecture honnête : **l'architecture met la sécurité au bon endroit (côté serveur,
défense en profondeur), mais « sûr » n'est vrai qu'une fois implémenté ET testé.**
Menaces principales et parades :

| Menace | Vecteur | Parade (obligatoire) |
|---|---|---|
| **Fuite inter-campus** | requête vectorielle sans filtre, cache partagé, citation non re-vérifiée | filtre `campus_id` obligatoire ; clé de cache incluant `campus_id` ; re-vérif d'autorisation à la réponse (§4.5) ; **tests §4.6** |
| **Fuite intra-campus** | un user voit les données d'un autre (mêmes campus) via retrieval ou *tool* | filtre `user_id`/`role`/propriété (§4.1.4) ; tools résolus côté Node depuis le JWT ; **test §4.6** |
| **Élévation / usurpation** | front qui falsifie `campus_id`/`role` | campus dérivé du **JWT S2S signé par Node**, jamais du body |
| **Prompt-injection** | document malveillant détourne le système | contexte = données **non fiables** en zone délimitée ; outils **lecture seule** ; sortie validée ; **non éliminable → moindre privilège** |
| **Exfiltration PII** | trop de données envoyées au LLM | minimisation (chunks pertinents only), redaction, no-training, résidence |
| **Empoisonnement de l'index** | upload utilisateur indexé | valider les **sources d'ingestion** ; ne pas indexer de contenu non vérifié |
| **DoS économique** | abus d'appels coûteux | budgets + rate-limit par utilisateur/campus ; time-outs ; file bornée |
| **Fuite de secret S2S** | secret long-vécu, API interne exposée | TTL court + rotation ; `/internal/ai` **non routable** depuis Internet |
| **Repudiation** | pas de trace | audit log (§4.3) |

### 4.5 Risques résiduels & contrôles non négociables

Ces points ne sont pas « faits » par la seule architecture — ils doivent être
**implémentés explicitement** :

1. **Re-vérification d'autorisation au moment de la réponse** (pas seulement à
   l'indexation) : un chunk indexé hier mais dont l'accès est révoqué aujourd'hui
   **ne doit pas** apparaître. Node re-valide chaque citation avant rendu.
   **Obligatoire, testé.**
2. **Isolation du cache et de la mémoire** : aucune clé de cache ni mémoire de
   conversation **partagée entre utilisateurs/campus**. Clé = `campus_id:user_id:…`.
3. **Prompt-injection = risque géré, non résolu** : on réduit (séparation,
   validation de sortie, outils lecture seule v1) ; on assume le résiduel et on le
   documente.
4. **PII vers LLM tiers** : DPA signé, options no-training, région/résidence
   décidées (§15), redaction quand le cas d'usage ne requiert pas la PII.
5. **Gestion du secret S2S** : rotation planifiée, TTL ≤ 5 min, jamais en clair
   ni en logs.

### 4.6 Tests de sécurité de première classe (bloquants en CI)

La Phase 3 n'est **pas livrable** sans ces tests verts :

- **Fuite inter-campus** : un utilisateur du campus A ne reçoit **jamais** une
  donnée du campus B — testé **dans la recherche ET dans le chat** (avec données
  croisées seedées).
- **Fuite intra-campus** : dans un même campus, un étudiant ne reçoit jamais les
  données d'un autre étudiant (notes, paiements) — y compris via un *tool* du chat.
- **Falsification de scope** : une requête tentant d'imposer un `campus_id`/`user_id`
  autre que celui du JWT est ignorée/rejetée.
- **Re-autorisation à la réponse** : une source dont l'accès est révoqué après
  indexation n'apparaît plus dans les réponses.
- **Injection de prompt** : un document piégé n'altère pas le comportement système
  ni ne déclenche d'action non autorisée.
- **Inertie** : IA désactivée → `503`, aucun appel externe.

---

## 5. Disposition des dépôts / répertoires

### 5.1 Service IA (nouveau, chemin frère)

```
/home/adminsecu/Projects/university/
├── backend/                 # existant (Node) — quasi inchangé (ajout module `ai`)
└── ai-service/              # NOUVEAU — micro-service Python, déployé séparément
    ├── app/
    │   ├── main.py              # FastAPI app, montage des routers, middlewares
    │   ├── config.py            # settings (pydantic-settings) ← .env
    │   ├── deps.py              # dépendances FastAPI (auth S2S, db session)
    │   ├── api/
    │   │   ├── chat.py          # POST /chat (SSE)
    │   │   ├── search.py        # POST /search
    │   │   ├── analytics.py     # POST /analytics/:report (synthèses descriptives)
    │   │   ├── advisors.py      # POST /advisors/:advisor (conseillers métier)
    │   │   ├── ingest.py        # POST /ingest
    │   │   └── health.py        # /healthz /readyz
    │   ├── services/
    │   │   ├── rag.py           # retrieval + assemblage du contexte
    │   │   ├── chat.py          # orchestration conversation + outils
    │   │   ├── analytics.py     # synthèses assistées (narration sur sorties engine)
    │   │   └── ingest.py        # chunking + embedding + upsert
    │   ├── engine/              # MOTEUR QUANTITATIF déterministe (ML/stats, PAS LLM)
    │   │   ├── forecasting.py   # séries temporelles (trésorerie, inscriptions…)
    │   │   ├── scoring.py       # scoring de leads, risque de décrochage
    │   │   └── anomaly.py       # détection d'anomalies (fraude, écarts budget)
    │   ├── advisors/            # CONSEILLERS MÉTIER (engine + LLM, human-in-the-loop)
    │   │   ├── marketing.py     # conversion, segmentation, relances
    │   │   ├── finance.py       # trésorerie, priorisation d'impayés, anomalies
    │   │   └── academic.py      # décrochage précoce, alertes performance
    │   ├── providers/
    │   │   ├── llm.py           # interface LLMProvider + impl Anthropic
    │   │   └── embeddings.py    # interface EmbeddingsProvider + impl
    │   ├── stores/
    │   │   ├── vector_store.py  # interface VectorStore + impl pgvector
    │   │   ├── db.py            # SQLAlchemy/asyncpg, pool de connexions
    │   │   └── models.py        # tables (chunks, conversations, messages, snapshots)
    │   ├── clients/
    │   │   └── erp_client.py    # client HTTP vers /internal/ai/* (S2S JWT)
    │   ├── prompts/             # templates de prompts (versionnés, par langue)
    │   └── core/
    │       ├── security.py      # vérif JWT S2S, garde campus
    │       ├── guardrails.py    # anti prompt-injection, validation sorties
    │       └── observability.py # tracing, métriques tokens/coût
    ├── workers/
    │   └── ingest_worker.py     # consommateur de la file d'ingestion
    ├── migrations/              # Alembic (schéma Postgres + extension pgvector)
    ├── tests/                   # pytest (unit + intégration + eval RAG)
    ├── pyproject.toml           # deps (fastapi, uvicorn, asyncpg/sqlalchemy, anthropic, pgvector…)
    ├── Dockerfile
    ├── .env.example
    └── README.md
```

### 5.2 Passerelle côté Node (dans `backend/`, convention des modules)

```
backend/modules/ai/
├── index.js                 # façade { routes, service }
├── ai.routes.js             # /api/ai/* (authenticate + authorize + rate-limiter)
├── ai.controller.js         # HTTP : valide, scope campus, délègue au service
├── ai.service.js            # client HTTP vers ai-service (S2S JWT + streaming)
├── ai.internal.routes.js    # /internal/ai/* (API de lecture ERP pour ai-service)
├── ai.internal.controller.js
└── ai.s2s.js                # émission/vérification du JWT de service
```

> Le module `ai` **n'a pas de model Mongoose** (comme `academic-print`,
> `finance` avant la Phase 2). Sa « persistance » est dans `ai-service`. Il
> respecte la façade `{ routes, service }` et s'ajoute à `tests/contracts/facades.test.js`.
> `ai.internal.controller` ne lit l'ERP **que** via les façades service
> existantes (`document.service`, `result.service`, `student.service`, …) — il ne
> touche **aucun** model directement.

---

## 6. Composants détaillés

### 6.1 Module Node `ai` (passerelle)

- **Routes publiques** (`/api/ai`, JWT utilisateur) :
  - `POST /api/ai/chat` — message + `conversationId?`, réponse **SSE** streamée.
  - `POST /api/ai/search` — requête de recherche sémantique, renvoie résultats
    + citations (ids ERP), scopés campus.
  - `GET  /api/ai/conversations` / `GET /api/ai/conversations/:id` — historique
    (stocké dans `ai-service`, proxifié).
  - `POST /api/ai/analytics/:report` — synthèse descriptive sur agrégats ERP (Feature 2).
  - `POST /api/ai/advisors/:advisor` — conseiller métier (§6.6) ; **réservé aux
    rôles habilités** (`authorize`), distinct des synthèses descriptives.
- **Garde campus** : le controller construit le scope via `buildCampusFilter` et
  l'injecte dans le **JWT de service** (le front ne peut pas le falsifier).
- **Rate-limiting** : appliquer `apiLimiter` **+ un limiteur IA dédié** (coût) —
  `createCustomLimiter(window, max)` existe déjà. Budget par utilisateur/campus.
- **Streaming** : passer le flux SSE d'`ai-service` au client sans bufferiser
  (Node fait du pipe). Gérer l'annulation (client qui ferme → abort upstream).
  **Pièges SSE à éviter (sinon le stream se fige)** : exclure la route du
  middleware de **compression** (gzip bufferise) ; en-têtes `Content-Type:
  text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`,
  `X-Accel-Buffering: no` (désactive le buffering nginx) ; **désactiver le timeout
  de réponse** pour cette route ; flush régulier (commentaire `:keep-alive`) pour
  ne pas être coupé par les proxys.
- **Dégradation** : si `ai-service` est indisponible, renvoyer `503` propre
  (jamais d'erreur 500 opaque) — l'ERP reste fonctionnel.

### 6.2 API interne `/internal/ai/*` (lecture ERP)

Exposée par Node, consommée **uniquement** par `ai-service` (JWT S2S). Elle sert :
- au **worker d'ingestion** : lister/lire les documents indexables d'un campus
  (via `document.service`), les résultats publiés, etc. ;
- au **RAG en ligne** : résoudre des citations en libellés/URLs, vérifier qu'un
  utilisateur a toujours le droit de voir une source au moment de la réponse.

Chaque endpoint **re-applique l'isolation campus ET intra-campus** (§4.1.4) à
partir du token S2S. Il ne renvoie que des données autorisées. Pas de nouvelle
requête Mongo « maison » : réutiliser/étendre les façades service (ajouter au
besoin des getters comme on l'a fait pour `getStudentContact`).

> **Re-vérification d'autorisation en lot** : une réponse cite souvent *k* sources.
> Ne pas faire *k* appels — exposer un endpoint **batch**
> (`POST /internal/ai/authorize-citations` → renvoie le sous-ensemble autorisé pour
> `{ userId, role, campusId }`), sur le modèle de `getStudentContacts(ids)`. Sinon
> la latence et la charge explosent à l'échelle « millions ».

### 6.3 Pipeline d'ingestion (RAG)

```
source ERP (documents, résultats, FAQ, cours…) 
   → /internal/ai/ingestables (Node, scopé campus)
   → normalisation (texte propre, métadonnées : campus_id, type, ids, visibilité)
   → chunking (taille/overlap configurables, conscient de la structure)
   → embeddings (batch, via EmbeddingsProvider)
   → upsert pgvector (vecteur + texte + métadonnées + tsvector plein-texte)
```

- **Asynchrone** : déclenché par événement (document publié) **ou** par cron
  (réindexation incrémentale). Côté Node, émettre un signal d'ingestion en
  **fire-and-forget** (même esprit que les émetteurs de notification) lors de la
  publication d'un document ; côté `ai-service`, un **worker** consomme une file.
- **Idempotence** : clé stable par source (`source_type:source_id:version`) →
  upsert, pas de doublons. Suppression/expiration ERP → suppression des chunks.
- **Incrémental** : ne réindexer que ce qui a changé (hash du contenu).

#### 6.3.1 Contrat de débit d'ingestion — protéger l'ERP (nouveau, v4)

L'ingestion lit l'ERP **à travers** Node (`/internal/ai/ingestables`) : à
l'échelle, une réindexation massive mal bornée peut dégrader l'ERP lui-même.
Contrat obligatoire, des deux côtés :

- **Pagination par curseur** : `GET /internal/ai/ingestables?type&updatedAfter&
  cursor&limit` avec `limit ≤ 200` **imposé côté Node** (clamp, pas confiance au
  client), tri stable sur `updatedAt,_id`, curseur opaque. Jamais de « tout le
  campus en une requête ».
- **Throttle côté worker** : `INGEST_MAX_RPS` (défaut **2 req/s**) et
  `INGEST_MAX_CONCURRENCY` (défaut **1** par campus). L'ingestion est du travail
  de fond : lente et invisible vaut mieux que rapide et douloureuse.
- **Backpressure côté Node** : `/internal/ai/*` peut répondre `429 +
  Retry-After` (limiteur dédié S2S) ; le worker applique un backoff exponentiel
  et reprend au curseur — le pipeline étant idempotent (§6.3), un arrêt/reprise
  est toujours sûr.
- **Fenêtre creuse** : les réindexations complètes (changement de modèle
  d'embeddings, backfill initial d'un campus) sont planifiées en heures creuses
  (cron), jamais déclenchées en journée par défaut.
- **Budget d'ingestion par campus** : plafond de documents/jour par campus
  (config), pour qu'un tenant volumineux ne monopolise pas la file des autres.

### 6.4 Abstractions (swappabilité)

Trois interfaces, une implémentation par défaut chacune :
- `LLMProvider` (`chat`, `stream`) → **Anthropic** par défaut.
- `EmbeddingsProvider` (`embed(texts) -> vectors`) → à choisir (§15).
- `VectorStore` (`upsert`, `query(vector, filters, k)`, `delete`) → **pgvector**.

Aucune logique métier RAG ne dépend d'un fournisseur concret : on peut changer de
modèle/embeddings/moteur vectoriel sans réécrire `rag.py`/`chat.py`.

> **⚠️ Piège embeddings (à connaître absolument)** : changer de **modèle
> d'embeddings** n'est PAS transparent. La colonne `vector(N)` de pgvector a une
> **dimension figée** et les espaces vectoriels de deux modèles ne sont pas
> comparables → tout changement impose une **réindexation complète** (et souvent
> une migration de schéma si `N` change). Mitigations obligatoires : (a) stocker
> `embedding_model` + `embedding_version` **sur chaque chunk** ; (b) refuser à la
> requête un mélange de modèles (filtrer sur la version courante) ; (c) prévoir
> une réindexation par lots (le pipeline §6.3 est idempotent, donc rejouable).
> **Ne jamais comparer des vecteurs produits par deux modèles différents.**

### 6.4bis Profils de fournisseurs — mécanique de la bascule free → paid (ADR-5)

Le service IA charge à son démarrage une table de **profils nommés** (via
`config.py` / pydantic-settings, alimentée par l'env — voir §11.2). Exemple :

```
# ai-service/.env — deux profils déclarés, AUCUN code ne les connaît par nom
LLM_PROFILES=free,premium

LLM_PROFILE_FREE_PROVIDER=openai_compatible
LLM_PROFILE_FREE_BASE_URL=https://api.groq.com/openai/v1
LLM_PROFILE_FREE_MODEL=llama-3.3-70b-versatile
LLM_PROFILE_FREE_API_KEY=            # renseignée plus tard, lue au runtime

LLM_PROFILE_PREMIUM_PROVIDER=anthropic
LLM_PROFILE_PREMIUM_MODEL=claude-sonnet-5
LLM_PROFILE_PREMIUM_ROUTING_MODEL=claude-haiku-4-5   # tiering §10bis
LLM_PROFILE_PREMIUM_API_KEY=         # ANTHROPIC — renseignée plus tard
```

**Résolution à la requête** : le JWT S2S porte `llmProfile` (dérivé de
l'entitlement campus, §11.3) → `providers/llm.py` renvoie l'instance du profil.
Règles :

1. **Profil demandé sans clé configurée** → repli sur le profil `free` avec un
   log `WARN` explicite (jamais de crash) ; si `free` lui-même n'est pas
   opérationnel → `503 AI degraded` propre remonté par Node. En
   `development|test`, le repli final est `mock`.
2. **Health probe au boot, non bloquant** : `/readyz` expose l'état de chaque
   profil (`{"profiles": {"free": "ok", "premium": "no_key"}}`). On voit d'un
   coup d'œil ce qui manque, sans lire les logs.
3. **Ajouter une clé plus tard = renseigner l'env + redémarrer le service.**
   Aucun fichier de code modifié, aucun changement côté Node ni frontend —
   c'est le contrat « brique fonctionnelle » demandé par le porteur, et il est
   **testé** (un test d'intégration démarre le service avec puis sans clé et
   vérifie les deux comportements).
4. **Embeddings hors profils** : `EMBEDDINGS_PROVIDER=local` (self-hosted,
   ADR-5) est **global**, jamais résolu par tenant.

Le frontend n'a jamais connaissance du profil au-delà d'un champ informatif
(`profile` dans l'événement SSE `done`, Annexe B) permettant, si on le veut, un
badge « réponse générée en mode découverte » sur les campus gratuits.

### 6.5 Moteur quantitatif déterministe (`engine/`)

Couche **sans LLM** qui produit des **chiffres reproductibles et testables** à
partir des agrégats ERP (fournis via `/internal/ai`, scopés campus) :

- **`forecasting`** — prévisions par séries temporelles (trésorerie attendue,
  inscriptions, charge enseignant). Modèles : statsmodels/Prophet.
- **`scoring`** — probabilités/scores : conversion d'un lead, **risque de
  décrochage** (l'ERP a déjà `computeDropoutRisk` ; l'engine peut l'enrichir d'un
  modèle appris), priorité de relance d'impayé.
- **`anomaly`** — détection d'écarts : fraude au-delà de l'`IP_BURST` existant,
  écart au budget, paiement atypique.

Règles : **entrées = agrégats ERP** (jamais d'accès Mongo) ; **sorties
versionnées et testées** (un score doit être reproductible) ; modèles entraînés
hors ligne, chargés par le service. Ces sorties alimentent les advisors (§6.6) et
l'analytics (§8) — **le LLM les explique, ne les calcule pas**.

### 6.6 Sous-système « advisors » métier (`advisors/`)

Conseillers qui **composent** le moteur quantitatif (§6.5) + le LLM pour produire
des **propositions actionnables**, exposés via `POST /api/ai/advisors/:advisor`
(route distincte des synthèses descriptives `/analytics/:report`) :

- **`marketing`** — sur `partner`/`public-portal` (leads, UTM, pré-inscriptions,
  anti-fraude) : scoring de leads, analyse d'entonnoir de conversion, segmentation,
  suggestion de campagnes et de moments de relance.
- **`finance`** — sur le **suivi paiement** + income/expense : prévision de
  trésorerie, **priorisation des relances d'impayés** (qui relancer d'abord),
  analyse de revenus, détection d'anomalies, écart au budget.
- **`academic`** — décrochage précoce, prédiction de performance, alertes
  proactives (poussées via le socle de notifications).

**Garde-fous non négociables** (mode proposition, *human-in-the-loop*) :
- l'IA **propose**, un humain **valide** ; **l'IA n'écrit jamais** d'enregistrement
  métier (paiement, lead, note). En v1, aucune action d'écriture déclenchée par le
  LLM.
- chaque proposition **cite ses données sources** (auditable, §4.3).
- les chiffres viennent de l'engine (§6.5), **testés en non-régression**.
- accès aux advisors **réservé aux rôles habilités** (`authorize` : direction /
  campus manager / staff selon le domaine), scopé campus.

---

## 7. Feature 1 — Assistant conversationnel (Chat RAG)

**But** : répondre aux questions d'un utilisateur (étudiant, enseignant, staff,
direction) sur **ses** données autorisées, avec citations, en streaming, dans
**sa langue préférée**.

**Flux** :
1. Node `/api/ai/chat` : auth + scope campus + langue (`settings.getPreferredLanguage`)
   → JWT S2S → `ai-service /chat`.
2. `ai-service` : récupère l'historique (sa base), reformule la requête,
   **retrieval** pgvector (filtré `campus_id` + autorisations), assemble un
   contexte borné (budget de tokens), appelle le **LLM en streaming**.
3. Réponse streamée au front via Node, avec **citations** (ids ERP → liens
   cliquables résolus via `/internal/ai`).
4. Persistance conversation/messages (+ coût/tokens) dans la base du service.

**Points de soin** :
- **Langue** : prompt système + réponse dans la locale utilisateur (réutiliser la
  liste des 10 langues de `shared/i18n`). Les libellés d'UI éventuels passent par
  le catalogue i18n existant.
- **Garde-fous** : anti prompt-injection (§4.1), refus hors-périmètre, pas
  d'hallucination de données ERP non sourcées (« je n'ai pas trouvé » plutôt
  qu'inventer).
- **Outils (option avancée)** : exposer des *function calls* en lecture seule
  (ex. « quelle est ma moyenne ? ») qui appellent `/internal/ai` — jamais
  d'écriture ERP depuis le LLM en v1. **Périmètre résolu côté Node depuis le
  `user_id` du JWT S2S** (§4.1.4), jamais depuis un identifiant fourni par le LLM
  ou le prompt (sinon un utilisateur pourrait demander les données d'un autre).

---

## 8. Feature 2 — Analytics & Reporting (assisté IA)

**But** : synthèses lisibles et tableaux de bord (ex. « résumé de la performance
de la classe X ce trimestre », tendances de présence, risque de décrochage).

**Principe d'architecture** : **les chiffres restent calculés par l'ERP**
(les agrégats existent déjà : présence, moyennes, dropout-risk — voir `result`,
`teacher`, `student`). L'IA **n'invente pas de chiffres** : elle **résume,
explique et met en forme** des agrégats fournis par Node.

**Flux** :
1. Node calcule/fournit l'agrégat (façades existantes, scopé campus) via
   `/internal/ai`.
2. `ai-service` génère un **résumé en langage naturel** + recommandations,
   éventuellement met en cache un **snapshot** (Postgres) daté.
3. Restitution dashboard (le front affiche chiffres ERP + narration IA).

**À éviter** : laisser le LLM calculer des statistiques à partir de données
brutes massives (coût, erreurs numériques). Les agrégats sont déterministes,
côté ERP, **avec tests de non-régression** (cf. exigence du doc Postgres §4).

**Analytique avancée (prévision/scoring) = moteur quantitatif (§6.5), pas LLM.**
Au-delà des synthèses descriptives, les prévisions (trésorerie, inscriptions) et
les scores (conversion, décrochage) sont produits par `engine/` puis **narrés**
par le LLM. Les **advisors métier (§6.6)** — Marketing, Finance/Compta,
Académique — en sont les consommateurs, **en mode proposition (human-in-the-loop)**.

---

## 9. Feature 3 — Recherche interne sémantique

**But** : « trouver » à travers documents, FAQ, aperçus de cours, etc. par le sens,
pas seulement par mot-clé.

**Approche : recherche hybride** (pgvector) :
- **vectorielle** (similarité d'embeddings) + **plein-texte** (`tsvector`
  Postgres) + **filtres SQL** (campus, type, dates) dans une requête,
- fusion des scores (ex. Reciprocal Rank Fusion),
- résultats renvoyés avec **citations vérifiées** (Node re-vérifie l'autorisation
  au moment du rendu).

Réutilise le **même index** que le RAG (un seul pipeline d'ingestion §6.3).

---

## 10. Scaler pour des millions d'utilisateurs

- **`ai-service` stateless** → réplication horizontale derrière un load-balancer ;
  l'état (conversations, vecteurs) est dans Postgres, pas en mémoire.
- **Ingestion découplée** : file de tâches + workers dédiés ; jamais d'embedding
  synchrone dans le chemin d'une requête utilisateur.
- **Streaming** de bout en bout (SSE) : time-to-first-token bas, connexions
  longues gérées hors du monolithe.
- **Cache** : (a) cache de réponses/embeddings pour requêtes fréquentes,
  (b) cache de retrieval. Redis recommandé (sert aussi de broker de file).
- **Postgres** : pool de connexions (pgbouncer), index **HNSW** pgvector, read
  replicas pour la recherche, partitionnement par `campus_id` si nécessaire.
- **Contrôle de coût LLM** : budgets par utilisateur/campus (rate-limiter dédié),
  *model tiering* (petit modèle pour reformulation/routing, grand pour la réponse),
  troncature de contexte, comptabilité tokens persistée.
- **Backpressure & time-outs** : tout appel LLM a un time-out ; file bornée ;
  dégradation propre (503) plutôt qu'effondrement.
- **Observabilité** : tracing distribué (Node ↔ ai-service), métriques
  latence/tokens/coût/taux d'erreur, **eval** régulier de la qualité RAG.

---

## 10bis. Chiffrage capacité & coût (nouveau, v4)

> Ordres de grandeur pour **décider** (plans, budgets, hébergement). À
> **recalibrer en M1** sur mesures réelles (`count_tokens` + 50 requêtes
> représentatives) — c'est un livrable du jalon, pas une option.

### SLO cibles (v1)

| Métrique | Cible |
|---|---|
| Chat — premier token (TTFT), p95 | ≤ 2 s |
| Chat — réponse complète, p95 | ≤ 15 s |
| Recherche sémantique, p95 | ≤ 500 ms |
| Disponibilité `ai-service` | 99,5 % (l'ERP n'en dépend jamais — 503 propre) |
| Taux d'erreur 5xx | < 0,5 % |

### Profil d'une requête chat type (hypothèse de départ)

≈ **3 500 tokens d'entrée** (prompt système + historique borné + 4-6 chunks
RAG) / ≈ **450 tokens de sortie**.

### Coût par requête — tarifs API Anthropic constatés au 2026-07

| Modèle (ID) | Entrée $/Mtok | Sortie $/Mtok | Coût / requête type |
|---|---|---|---|
| `claude-haiku-4-5` | 1 | 5 | ≈ **$0,006** |
| `claude-sonnet-5` | 3 (intro 2 jusqu'au 2026-08-31) | 15 (intro 10) | ≈ **$0,017** |
| `claude-opus-4-8` | 5 | 25 | ≈ **$0,029** |

**Politique de tiering retenue (à confirmer en M0)** : `claude-haiku-4-5` pour
la reformulation de requête et le routing ; `claude-sonnet-5` pour les réponses
chat/analytics ; `claude-opus-4-8` réservé aux **advisors** (faible volume,
forte valeur). Le **prompt caching** Anthropic (préfixe système + historique
stable, lecture ≈ 0,1× le prix d'entrée) réduit le coût d'entrée effectif de
40-60 % sur les conversations suivies — la construction du prompt doit garder
le préfixe stable (système figé, contenu volatil en fin de prompt).

### Projection mensuelle (hypothèse : 25 requêtes IA / utilisateur actif / mois, Sonnet dominant)

| Utilisateurs actifs/mois | Coût LLM brut | Avec cache + tiering (≈ ×0,6) |
|---|---|---|
| 1 000 (pilote) | ≈ $425 | ≈ $250 |
| 10 000 | ≈ $4 250 | ≈ $2 500 |
| 100 000 | ≈ $42 500 | ≈ $25 000 |

**Conséquences directes** : (a) le coût LLM est linéaire au volume → les
**budgets par campus** (§11.3) ne sont pas un luxe, ce sont le mécanisme de
survie économique ; (b) le plan **Premium doit être refacturé** au campus — le
chiffrage ci-dessus donne le plancher de tarification ; (c) la phase gratuite
(ADR-5) coûte **$0 en LLM** et ne diffère aucun de ces apprentissages.

### Embeddings & stockage vectoriel

- Embeddings **self-hosted** (ADR-5) : coût fixe machine (CPU suffit pour le
  pilote ; l'ingestion est asynchrone donc la latence d'embedding n'affecte pas
  l'utilisateur), **zéro coût par token**.
- Dimensionnement pgvector : chunk ≈ 1 Ko de texte + vecteur 1024×float32
  (4 Ko) + métadonnées ≈ **6 Ko/chunk**. Campus type (10 000 documents × 15
  chunks) ≈ 150 000 chunks ≈ **0,9 Go**. 1 M de chunks ≈ 6 Go + index HNSW
  (compter ~1,5× la taille des vecteurs en RAM). Un Postgres hébergé d'entrée
  de gamme porte largement le pilote ; les read replicas (§10) ne deviennent
  pertinents qu'au-delà de quelques millions de chunks.

### Livrables associés

- **M0** : tableau coût/plan validé par le porteur (plancher de prix Premium).
- **M1** : recalibrage sur mesures réelles ; budgets par plan figés dans la
  config d'entitlement (§11.3).

---

## 11. Configuration & environnement

### 11.1 Côté Node (`backend/.env` + `shared/configs/general.config.js`)

Ajouter une **section `ai`** dans `general.config.js` (sur le modèle de
`notification`), inerte si non configurée (zéro appel externe en dev/CI) :

```
AI_SERVICE_URL=            # URL interne du micro-service (vide → IA désactivée)
AI_SERVICE_SECRET=         # secret S2S (signe le JWT de service)
AI_REQUEST_TIMEOUT_MS=30000
AI_RATE_LIMIT_PER_MIN=20   # garde-fou coût par utilisateur
```

> **Important** : comme pour le canal email/whatsapp, **si `AI_SERVICE_URL` est
> vide, le module `ai` est inerte** : `/api/ai/*` répond `503 AI disabled`,
> aucun test ni CI ne dépend d'un service externe. C'est la convention du projet.

### 11.2 Côté service IA (`ai-service/.env`)

```
DATABASE_URL=postgresql+asyncpg://...      # base PROPRE au service
AI_SERVICE_SECRET=                         # même secret S2S que Node
ERP_INTERNAL_URL=                          # URL de /internal/ai sur Node
LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=
LLM_MODEL=claude-...                        # modèle par défaut (cf. §15)
EMBEDDINGS_PROVIDER=
EMBEDDINGS_MODEL=
REDIS_URL=                                  # cache + broker de file
ENVIRONMENT=development|staging|production
```

### 11.3 Entitlement « Premium » par campus (nouveau, v4)

Le titre du doc dit « Premium » ; ce paragraphe le rend concret. **L'IA est une
capacité activable par tenant**, pas un réglage global.

**Modèle de données** — config embarquée sur `Campus` (même pattern que la
config de commission `partner`, gérée via `campus.repository`) :

```js
aiEntitlement: {
  enabled:            { type: Boolean, default: false },
  plan:               { type: String, enum: AI_PLANS, default: 'free' },
                      // AI_PLANS = Object.freeze({ FREE:'free', STANDARD:'standard', PREMIUM:'premium' })
  llmProfile:         { type: String, default: 'free' },   // → profil §6.4bis
  monthlyTokenBudget: { type: Number, default: 200000 },   // 0 = illimité (ADMIN only)
  features: {
    chat:     { type: Boolean, default: true },
    search:   { type: Boolean, default: true },
    analytics:{ type: Boolean, default: false },
    advisors: { type: Boolean, default: false },
  },
  activatedAt: Date,
}
```

**Enforcement — défense en profondeur, aux deux étages :**

1. **Node (module `ai`, middleware après `authenticate`)** : IA globalement
   éteinte (`AI_SERVICE_URL` vide) → `503 AI disabled` ; campus non souscrit →
   `403 AI_NOT_ENABLED` (403 ≠ 503 : « pas souscrit » n'est pas « en panne ») ;
   feature hors plan → `403 AI_FEATURE_NOT_IN_PLAN` ; budget mensuel épuisé →
   `429 AI_BUDGET_EXCEEDED`. Le claim `{ plan, llmProfile }` part dans le **JWT
   S2S** — jamais du body, donc infalsifiable par le front.
2. **`ai-service`** : tient le **compteur de tokens par `campus_id` et par
   mois** dans sa base Postgres (table `usage_monthly`), incrémenté à chaque
   réponse LLM ; re-vérifie le budget à partir du JWT S2S et refuse au-delà
   (`429`) même si Node avait laissé passer (fenêtre de course assumée : le
   compteur est vérifié *avant* l'appel LLM, incrémenté *après*).

**Surfaces :**
- `GET /api/ai/usage` (CAMPUS_MANAGER+) → consommation du mois, budget,
  restant, plan (contrat en Annexe B) — de quoi afficher une jauge dans l'UI.
- `PUT /api/admin/campuses/:id/ai-entitlement` (ADMIN/DIRECTOR uniquement) →
  activation, changement de plan/budget. **Entrée d'audit log** à chaque
  mutation (§8 du CLAUDE.md).
- La **facturation** est hors périmètre v1, mais le `plan` est la donnée pivot
  qu'un module de billing futur consommera — ne pas inventer une seconde
  source de vérité le moment venu.

**Lien avec ADR-5** : `plan` décide *si* et *combien* ; `llmProfile` décide
*avec quel fournisseur*. Les deux sont découplés à dessein — on peut faire
tourner un campus `premium` sur le profil gratuit pendant une phase de test, et
inversement offrir un essai Claude à un campus `free` sans toucher au code.

---

## 12. Conventions du projet à respecter (checklist anti-cassure)

Le développeur IA **doit** cocher tout ceci :

**Côté Node (module `ai`)**
- [ ] Façade `index.js` exporte exactement `{ routes, service }`.
- [ ] Aucun accès direct à un model ; lecture ERP via les **façades service**.
- [ ] `authenticate` + `authorize` + rate-limiter sur **toutes** les routes `/api/ai`.
- [ ] `buildCampusFilter` appliqué ; le campus part dans le **JWT S2S**, pas le body.
- [ ] Module inerte si `AI_SERVICE_URL` vide (503 propre).
- [ ] Ajouté à `tests/contracts/facades.test.js` (+ contrat des fonctions service).
- [ ] `npm run lint` = 0 erreur ; `npm test` au vert.
- [ ] Routes montées dans `app.js` (`app.use('/api/ai', ...)`) ; `/internal/ai`
      monté **sans** exposition publique (réseau privé + JWT S2S).
- [ ] Aucun secret en dur ; tout via `general.config.js` ← `.env`.
- [ ] **Entitlement §11.3 appliqué** : 403/429 propres, claim dans le JWT S2S,
      audit log sur mutation, `GET /api/ai/usage` opérationnel.
- [ ] **Contrats d'API conformes à l'Annexe B** (payloads + événements SSE) et
      synchronisés avec le client API frontend dans la même tâche.

**Côté `ai-service`**
- [ ] **Jamais** d'accès à MongoDB ni à la base ERP. Données ERP via `/internal/ai`.
- [ ] Tout chunk porte `campus_id` ; toute requête vectorielle filtre `campus_id`.
- [ ] Migrations Alembic versionnées ; **ids `uuid`** (cohérent trajectoire Postgres).
- [ ] Abstractions `LLMProvider`/`EmbeddingsProvider`/`VectorStore` respectées.
- [ ] `pytest` (unit + intégration) + **harnais d'eval RAG** ; lint (ruff) + types (mypy).
- [ ] Healthchecks `/healthz` `/readyz` ; Dockerfile ; `.env.example` à jour.
- [ ] Garde-fous prompt-injection + minimisation PII en place.
- [ ] **Tests de sécurité §4.6 verts** (fuite inter-campus, falsification de scope,
      re-autorisation à la réponse, injection) — **bloquants**.
- [ ] **Moteur quantitatif** : sorties **reproductibles et testées** (un score
      identique pour les mêmes entrées) ; entrées = agrégats ERP, jamais Mongo.
- [ ] **Advisors** : **mode proposition strict** — aucune écriture ERP par l'IA ;
      chaque proposition cite ses sources ; accès scopé rôle + campus.
- [ ] **Profils fournisseurs §6.4bis** : `mock` interdit hors dev/test ; repli
      free → 503 propre testé ; **test d'intégration « ajout de clé sans
      changement de code »** (démarrage avec/sans clé, deux comportements
      vérifiés) ; `/readyz` expose l'état des profils.
- [ ] **Ingestion §6.3.1** : pagination clampée côté Node, throttle worker,
      backoff sur 429, réindexation complète en fenêtre creuse uniquement.
- [ ] **Aucune PII réelle vers un profil gratuit** (ADR-5) — vérifié par revue
      de la config des campus pilotes.

---

## 13. Feuille de route incrémentale (jalons)

Chaque jalon est **livrable, testé, et ne casse rien**. « Continue » = jalon suivant.

| Jalon | Contenu | Critère d'acceptation |
|---|---|---|
| **M0 — Cadrage & décisions** | Trancher le §15 (provider, embeddings, hébergement, build order). | Décisions écrites dans ce doc. |
| **M1 — Squelette service + DB** | `ai-service` FastAPI minimal, Postgres+pgvector, migrations, healthchecks, S2S auth, Dockerfile. | `/healthz` OK ; JWT S2S vérifié ; CI verte. |
| **M2 — Module Node `ai` (inerte)** | Façade + routes `/api/ai` + `/internal/ai` + S2S, **inerte sans `AI_SERVICE_URL`**. | Contrats façade verts ; 503 propre si désactivé ; lint 0 erreur. |
| **M3 — Ingestion + recherche (Feature 3)** | Pipeline ingestion (documents d'abord), pgvector, `/search` hybride, isolation campus prouvée. | Recherche scopée campus ; **tests de sécurité §4.6 (fuite inter-campus + falsification de scope) verts**. |
| **M4 — Chat RAG (Feature 1)** | `/chat` streaming, retrieval+citations, langue utilisateur, garde-fous. | Réponses sourcées, streamées, multilingues ; eval RAG de base ; **tests re-autorisation + injection de prompt (§4.6) verts**. |
| **M5 — Analytics assisté (Feature 2)** | Synthèses descriptives sur agrégats ERP (chiffres ERP, narration IA), snapshots. | Aucun chiffre inventé ; agrégats = sortie ERP testée. |
| **M5b — Moteur quantitatif + advisors** | `engine/` (forecasting/scoring/anomaly) + advisors Marketing/Finance/Académique, **human-in-the-loop**. | Sorties engine reproductibles & testées ; advisors **proposent** (zéro écriture ERP) ; accès scopé rôle+campus. |
| **M6 — Durcissement échelle** | Cache/Redis, rate-limit coût, observabilité, eval continue, charge. | Budgets respectés ; métriques tokens/coût ; tests de charge. |

> **État** : **M0 ✅, M1 ✅, M2 ✅, M3 ✅ (2026-07-03), M4 ✅, M5 ✅, M5b ✅
> (2026-07-04) et M6 ✅ (2026-07-05)** — décisions au §15, squelette
> `ai-service/` livré, module Node `ai` + entitlement Campus livrés, ingestion +
> recherche hybride livrées, **chat RAG SSE + conversations + client API frontend
> livrés**, **analytics assisté livré** (agrégats ERP narrés, snapshots
> re-autorisés), **moteur quantitatif + advisors livrés** (heuristiques D8
> versionnées, mode proposition strict, human-in-the-loop), **durcissement
> échelle livré** (cache Redis-optionnel cost-only, observabilité Prometheus +
> request-id, budget consolidé + alerting, purge de rétention, eval RAG étendue,
> harnais de charge), tests de sécurité §4.6 verts (recherche, chat, analytics
> ET advisors, journal §18.1). **Tous les jalons sont réalisés.** Le suivi
> détaillé (qui a fait quoi, comment reprendre) est au **§18**.

---

## 14. Stratégie de test & qualité

- **Node** : tests de contrat de façade (module `ai`), tests du proxy (service IA
  **mocké** — comme `notification` mocke les canaux), test d'**inertie** (désactivé
  → 503), test d'isolation campus (le scope vient bien du JWT, pas du body).
- **Python** : `pytest` unitaires (chunking, fusion de scores, prompts), tests
  d'intégration (pgvector réel via conteneur jetable), **harnais d'eval RAG**
  (jeu de Q/R de référence, mesure de fidélité/citations) exécuté en CI.
- **Sécurité (de première classe, bloquants — voir §4.6)** : fuite inter-campus
  (recherche **et** chat), falsification de scope, re-autorisation à la réponse,
  injection de prompt, isolation des clés de cache. **Ces tests gardent la Phase 3.**
- **Régression analytics & engine** : figer les agrégats ERP (cf. exigence
  Postgres §4) **et** les sorties du moteur quantitatif (un score reproductible).

---

## 15. Décisions — tranchées en M0 (2026-07-03)

> **Directives porteur actées le 2026-07-03** : (a) **stratégie free-first,
> config-driven** — v1 exploitable sans clé payante, bascule payante par
> configuration, par campus, sans modification de code (ADR-5, §6.4bis) ;
> (b) **entitlement par campus** comme mécanisme Premium (§11.3) ;
> (c) **embeddings self-hosted globaux** (ADR-5).

Chaque décision ci-dessous note **ce qui est acté**, **pourquoi**, et **à
quelle condition elle est révisable**. Aucune n'est gravée dans le code : elles
vivent toutes derrière une abstraction (§6.4) ou une variable d'environnement
(§11). En cas d'écart constaté pendant l'implémentation, consigner l'écart au
§18 avec sa justification — ne pas dévier silencieusement.

**D1 — Ordre de construction : Feature 3 (recherche) → 1 (chat) → 2
(analytics) → moteur quantitatif + advisors (M5b).** La recherche pose
l'ingestion et l'index vectoriel dont le chat dépend ; les analytics
s'appuient sur une API interne déjà éprouvée par les deux premières features.
*Révision* : aucune raison prévisible.

**D2 — Embeddings : `BAAI/bge-m3` (1024 dimensions), self-hosted, global.**
La colonne vectorielle est donc `vector(1024)`. **Bench exécuté le 2026-07-07**
(`scripts/bench_embeddings.py`, corpus jouet FR/EN/AR, sentence-transformers CPU) :

| modèle | dim | recall@1 | recall@3 | ms/req |
|---|---|---|---|---|
| `BAAI/bge-m3` | 1024 | **1.00** | 1.00 | 129 |
| `intfloat/multilingual-e5-base` | 768 | 0.83 | 1.00 | 66 |

La règle mécanique (recall@3 ≥ 95 %) désignait e5-base, mais sur ce corpus de 6
docs les deux saturent recall@3 = 1.00 ; le seul signal discriminant, **recall@1,
favorise bge-m3 (1.00 vs 0.83)**, et adopter e5-base imposerait le plumbing des
préfixes `query:`/`passage:` (scission `embed_query`/`embed_documents` + tests).
**Décision porteur 2026-07-07 : conserver `bge-m3` (1024d)** — top-1 préservé,
aucun code à changer, coût RAM/stockage assumé (l'hôte D4 est déjà dimensionné
~2 Go). La colonne reste `vector(1024)`, désormais **définitive**. *Révision* :
un basculement futur (768d ou autre) = réindexation complète planifiée (§6.4).

**D3 — Profil payant : `claude-sonnet-5` (réponses) + `claude-haiku-4-5`
(routing/reformulation) + `claude-opus-4-8` (advisors).** Confirme la
proposition chiffrée du §10bis. *Révision* : à coût nul, par env (§6.4bis) —
recalibrage prévu en M1 sur mesures réelles.

**D4 — Hébergement.** Développement et test (M1→M5) : **docker-compose local**
(`postgres:16` + pgvector, `ai-service`, Ollama optionnel) — zéro dépense,
conforme à la directive porteur. **Production confirmée par le porteur le
2026-07-06** : Postgres+pgvector managé **Neon, région UE (Francfort,
`eu-central-1`)** — c'est le magasin des conversations (PII, rétention D7 12
mois), d'où l'exigence de résidence UE ; service IA en **conteneur Docker**
(host à finaliser au déploiement — Scaleway Paris ou VPS Docker ≥ 4 Go RAM pour
loger le modèle d'embeddings bge-m3 ~2 Go) ; **Redis non requis en pilote**
(mono-réplica → cache in-process M6), ajouté managé UE au passage multi-réplicas.
**LLM du tier premium : `anthropic` sous DPA** (Claude, tiering §10bis/D3) — le
DPA couvre l'engagement no-training / rétention zéro ; le traitement peut rester
hors UE, arbitrage assumé par le porteur (bascule vers un LLM hébergé UE type
Mistral possible plus tard **sans modif de code**, profil `openai_compatible`
§6.4bis). Règle inchangée : **PII réelle jamais vers un free tier** (Groq =
corpus public/mock uniquement). *Révision* : sans impact code — architecture
12-factor, tout passe par l'env.

**D5 — Magasin vectoriel : pgvector seul en v1**, derrière l'interface
`VectorStore` (§6.4). Pas de moteur dédié (Qdrant/Weaviate) avant d'avoir des
mesures de charge réelles (M6). *Révision* : nouvelle implémentation de
`VectorStore`, sans toucher les appelants.

**D6 — Sources indexées : documents GED + corpus public du portail.**
1ᵉʳ incrément (M3) : documents GED (métadonnées + contenu textuel extrait).
**2ᵉ incrément — ✅ FAIT (2026-07-06)** : programmes (`CoursePreview`) et FAQ
(`FaqEntry`) **publiés** du `public-portal` — corpus **public, risque nul**,
indexés en deux `sourceType` distincts (`portal-program`, `portal-faq`) pour un
pruning et une re-autorisation propres. Contrat d'ingestion identique à
`document.listAiIngestables` (façade `publicPortal.listAiIngestables` : filtre
`isPublished:true` obligatoire — un brouillon ne fuit jamais —, tri stable
`(updatedAt,_id)`, curseur opaque, `sourceId` pour l'événementiel ; texte
bilingue {fr,en} concaténé pour le rappel, `visibility.roles = []` = visible à
tous les rôles du campus). Signal `ai.service.signalIngest` **fire-and-forget**
émis sur create/update/publish/unpublish/delete des programmes et FAQ.
Re-autorisation à la réponse **triviale** (`publicPortal.authorizeAiCitations` :
encore publié + campus cohérent, **aucun gating par utilisateur** — le contenu
ne porte aucune donnée personnelle). Côté `ai-service` : `sourceType` élargi
dans `/ingest` et `/search` (rejette tout type inconnu), backfill campus qui
**itère sur chaque corpus indexable** (`INDEXABLE_SOURCE_TYPES`), retrieval chat
+ `/search` couvrant tout le corpus par défaut (`SEARCHABLE_SOURCE_TYPES`).
Source unique de vérité : `shared/constants/ai.constants.js`, miroir verbatim
`ai-service/app/core/constants.py`. **Jamais indexés en vecteur** : résultats,
finance, données personnelles — ces données sont servies **à la demande** par
l'API interne (§6.2), qui applique l'autorisation au moment de la requête.

**D7 — Conformité & données sensibles.** (a) **Aucune PII réelle vers un
profil gratuit** (règle ADR-5) : free tiers = données de seed/démo uniquement ;
dès que des données réelles sont en jeu → profil `mock`, Ollama self-hosted,
ou profil payant avec engagement no-training (Anthropic). (b) **Rétention des
conversations : 12 mois** puis purge (cron côté `ai-service`, durée par env).
(c) **Opt-out par campus** = `aiEntitlement.enabled = false` (§11.3).
(d) Audit log append-only sur toute interaction (déjà exigé §4). (e) Résidence
UE par défaut (D4). *Révision* : durée de rétention et résidence = env/config ;
la règle (a) n'est **pas** révisable.

**D8 — Moteur quantitatif v1 : heuristiques déterministes, pas de ML
entraîné.** Trois calculs : **risque de décrochage** (port du
`computeDropoutRisk` existant côté Node), **priorisation des relances
d'impayés** (montant × ancienneté × historique payeur), **détection
d'anomalies** par règles + z-score (au-delà de l'`IP_BURST` actuel du
public-portal). Réentraînement : sans objet en v1. *Révision* : modèles
appris = phase ultérieure, une fois les heuristiques mesurées (§1.4.3).

**D9 — Advisors : Finance d'abord** (valeur la plus directement monétisable,
§1.4.1), puis Académique, puis Marketing. Accès : `CAMPUS_MANAGER` (son
campus), `DIRECTOR`/`ADMIN` (tous campus). **Mode proposition strict
confirmé** : aucune écriture ERP par l'IA en v1.

**D10 — Plans & budgets de tokens.** `free` = 200 000 tokens/mois (défaut
§11.3), features `{chat, search}` ; `standard` = 1 000 000 tokens/mois,
+ `analytics` ; `premium` = 5 000 000 tokens/mois, + `advisors`. Le découpage
suit le gradient de valeur (§1.4.2). **Prix de vente tranché par le porteur le
2026-07-06** (COGS négligeable au plafond — §10bis : ~0,5 $/campus free,
~3 $ standard, ~15-25 $ premium ; prix fixé à la valeur, pas au coût) :
`free` = **0 €** (essai / onboarding), `standard` = **99 €/campus/mois**,
`premium` = **299 €/campus/mois**. Facturation v1 = **add-on forfaitaire par
campus** (option A). Les gros campus qui saturent leur budget relèvent
`monthlyTokenBudget` par surcharge d'entitlement (panneau admin) — politique de
top-up payant à préciser si le besoin se confirme. *Révision* : sans impact
code (les budgets sont des données d'entitlement §11.3, le prix est hors code).

**D11 — Profil `free` : Groq, modèle `llama-3.3-70b-versatile`** (état vérifié
au 2026-07 : 30 req/min, 1 000 req/jour, 100 000 tokens/jour ≈ 25 requêtes
chat type §10bis par jour — suffisant pour le développement ; itérations
légères possibles sur `llama-3.1-8b-instant`, 500 000 tokens/jour).
Alternative documentée : Gemini 3 Flash (1 500 req/jour ; **attention** :
activer la facturation sur le projet Google supprime définitivement son free
tier). En CI : provider `mock` exclusivement — aucun appel réseau. *Révision* :
par env, coût nul (§6.4bis) ; re-vérifier quotas/CGU au moment de M4 (chat).

**D12 — Distribution du document : acté et appliqué le 2026-07-03.**
`docs/architecture/` est sorti du `.gitignore` (ligne `docs` remplacée par
`docs/*` + `!docs/architecture/`) ; le reste de `docs/` — dont `docs/cours/` —
reste ignoré. Ce fichier et `POSTGRES_MIGRATION_ASSESSMENT.md` sont désormais
versionnables ; ils ne contiennent aucun secret (§17).

---

## 16. Definition of Done (Phase 3)

- Les 3 features livrées, derrière `/api/ai/*`, **scopées campus** et **multilingues**.
- `ai-service` déployé séparément, **stateless**, scalable, observé, sous budget coût.
- **Zéro régression** sur l'ERP : tous les tests Node au vert, lint 0 erreur,
  module `ai` inerte sans config (dev/CI sans appel externe).
- **Isolation campus prouvée par des tests** (recherche + chat), + tests de
  sécurité §4.6 verts (re-autorisation, falsification de scope, injection).
- **Moteur quantitatif + advisors** livrés en **mode proposition (human-in-the-loop)**,
  sorties reproductibles et testées, **aucune écriture ERP par l'IA**.
- pgvector en place = **pilote Postgres** documenté, prêt à informer la migration.
- **Modèle de menace (§4.4) tenu** : audit log, minimisation PII, no-training,
  résidence décidée.
- **Entitlement par campus opérationnel** (§11.3) : plans, budgets, 403/429
  propres, compteur de tokens par campus, jauge d'usage exposée.
- **La v1 fonctionne de bout en bout sans clé payante** (profil `free`/`mock`),
  et la **bascule payante est démontrée par configuration seule** — test
  d'intégration « ajout de clé sans changement de code » vert (§6.4bis).
- **Chiffrage §10bis recalibré** sur mesures réelles (M1) ; budgets par plan
  figés en conséquence.
- **Contrats d'API conformes à l'Annexe B**, client frontend synchronisé.
- Documentation à jour (ce fichier + README de `ai-service`).

---

## 17. Distribution de ce document (v4 ; **réglé en M0**)

Le public visé de ce fichier est un **développeur externe qui clone le
dépôt**. Jusqu'au 2026-07-03 il était gitignoré (ligne `docs` du `.gitignore`
racine) et ne pouvait donc jamais lui parvenir. **Réglé par la décision D12
(§15)** : le `.gitignore` ignore désormais `docs/*` **sauf**
`docs/architecture/` — ce fichier et `POSTGRES_MIGRATION_ASSESSMENT.md` sont
versionnés et suivent les révisions naturellement. Ils ne contiennent **aucun
secret** (les clés vivent dans `.env`, toujours ignoré). Le reste de `docs/`
(p. ex. `docs/cours/`) reste ignoré.

Deux précautions subsistent :

- **Avant tout onboarding externe**, exécuter la migration d'activation des
  comptes en production : `ACCOUNT_ACTIVATION_CHANTIER.md` (même dossier) cite
  les **anciens** mots de passe par défaut qu'elle remplace — sans la
  migration, ces valeurs restent actives sur les comptes existants.
- Si une copie doit circuler **hors dépôt**, la dater et rappeler que la
  source de vérité est le fichier versionné — une copie obsolète est pire
  qu'aucune copie.

---

## 18. Journal d'avancement & reprise (handoff)

> **But** : toute personne — y compris quelqu'un qui n'a participé à aucune
> session précédente — doit pouvoir reprendre le chantier en lisant cette
> section, sans rien casser. **Règle de tenue** : à la fin de chaque jalon (ou
> de toute session de travail significative), ajouter une ligne au journal
> §18.1, mettre à jour la note de révision d'en-tête, consigner tout écart aux
> décisions D1–D12 — et **ne jamais réécrire les entrées passées**
> (append-only, comme l'audit log de l'ERP).

### 18.1 Journal (append-only)

| Date | Jalon (§13) | État | Trace |
|---|---|---|---|
| 2026-06-18 → 2026-07-03 | Conception (v1 → v4.2) | ✅ | Ce document ; historique des révisions en tête. |
| 2026-07-03 | **M0 — Cadrage & décisions** | ✅ | §15 : décisions **D1–D12** tranchées ; `.gitignore` ajusté (D12) ; free tiers Groq/Gemini vérifiés à date (D11). |
| 2026-07-03 | **M1 — Squelette service + DB** | ✅ | Dépôt frère **`ai-service/`** créé (git init, **non commité**) : FastAPI (arborescence §5.1), auth S2S HS256 vérifiée (§4.2, TTL ≤ 300 s, iss/aud dans les deux sens, campusId exigé pour les rôles scopés), schéma Postgres+pgvector via Alembic (`vector(1024)` D2, tables chunks/conversations/messages/analytics_snapshots/usage_monthly, index HNSW+GIN), profils LLM ADR-5 (`mock`/`openai_compatible`/`anthropic`, repli §6.4bis), `/healthz` + `/readyz` (état par profil), endpoints métier montés en 501 avec jalon cible, Dockerfile + docker-compose (D4), CI GitHub Actions (ruff+mypy+pytest 3.10/3.12 + cycle upgrade/downgrade Alembic sur pgvector). **Vérifié en réel** : migration appliquée sur `pgvector/pgvector:pg16`, service booté, 401/501 S2S corrects, et **bascule free→paid démontrée par config seule** (readyz `premium: no_key → ok` en ajoutant la clé d'env, zéro changement de code). 28 tests verts, ruff/mypy 0 erreur. Écart mineur : port hôte compose **5434** (5433 occupé par un Postgres local existant). |
| 2026-07-03 | **M2 — Module Node `ai` (inerte)** | ✅ | Backend Node : module **`modules/ai/`** livré (24ᵉ module, arborescence §5.2 + `ai.entitlement.middleware.js`) : façade `{ routes, service, internalRoutes }`, routes `/api/ai/*` (chat SSE pass-through, search, conversations, analytics/:report, advisors/:advisor, usage) montées dans `app.js`, **`/internal/ai/*` monté hors `/api`** (ingestables / authorize-citations / aggregates en **501 avec jalon cible**, miroir des stubs M1 côté service) ; S2S conforme au contrat M1 (`ai.s2s.js` : HS256, iss/aud dans les deux sens, TTL ≤ 300 s, claims sub/campusId/role/scope/plan/llmProfile, campusId exigé pour les rôles scopés) ; **inerte sans `AI_SERVICE_URL`** (503 `AI_DISABLED`, zéro appel externe — section `ai` de `general.config.js`) ; **entitlement §11.3** : `Campus.aiEntitlement` + `aiEntitlementAudit` (append-only), constantes `shared/constants/ai.constants.js` (AI_PLANS + presets D10), gate 503/403/403/429 (budget vérifié via ai-service, fail-open documenté, étage 2 = service), `GET /api/ai/usage`, `GET/PUT /api/admin/campuses/:id/ai-entitlement` (ADMIN/DIRECTOR, entrée d'audit à chaque mutation) ; limiteur IA dédié par utilisateur (`AI_RATE_LIMIT_PER_MIN`) + limiteur S2S (backpressure §6.3.1). **Tests** : façade ajoutée aux contrats (`facades.test.js`), unit S2S (8) + entitlement (10), smoke 401/503 inertie — verts ; lint 0 erreur. Écarts : aucun. Notes : (a) client API **frontend non créé** — aucune UI ne consomme `/api/ai` encore ; à synchroniser avec la première surface UI (M3/M4, règle Annexe B) ; (b) usage tokens indisponible avant l'endpoint `usage_monthly` du service (M3) → `GET /api/ai/usage` répond 503 en attendant plutôt que d'inventer des compteurs. |
| 2026-07-03 | **M3 — Ingestion + recherche (Feature 3)** | ✅ | **Node** : stubs 501 remplacés — `GET /internal/ai/ingestables` réel (façade `document.listAiIngestables` : types D6 non personnels `COURSE_MATERIAL/ADMINISTRATIVE/REPORT/CUSTOM/IMPORTED`, statuts `PUBLISHED/LOCKED`, extraction texte des blocs, tri stable `(updatedAt,_id)`, curseur opaque base64url, limit clampée ≤ 200, param `sourceId` pour l'événementiel) ; `POST /internal/ai/authorize-citations` réel (façade `document.authorizeAiCitations` : miroir exact des règles d'accès — cross-check campus, `accessRoles`, TEACHER=COURSE_MATERIAL de ses cours, STUDENT/PARENT=liaison `linkedEntities`, enfants via nouvelle façade `parent.getChildrenIds`) ; **signal d'ingestion fire-and-forget** (`ai.service.signalDocumentIngest`, skip si campus non souscrit — opt-out D7) émis sur publish/archive/restore/update/soft+hard delete ; `GET /api/ai/usage` désormais opérationnel (compteurs servis par le service). **ai-service** : `ERPClient` httpx réel (S2S, enveloppe `{success,data}`, 429→`ERPRateLimitedError`), `LocalEmbeddingsProvider` (sentence-transformers en extra `[embeddings]`, chargement lazy hors event-loop, garde dimension §6.4), pipeline §6.3 (`services/ingest.py` : chunking déterministe 1200/150, hash, upsert idempotent + prune des versions périmées, `ingest_source` événementiel — source disparue = purge — et `ingest_campus` backfill avec throttle `INGEST_MAX_RPS` + backoff 429 §6.3.1), `PgVectorStore` complet (upsert ON CONFLICT, requête vectorielle, **hybride vecteur+tsvector fusion RRF en un aller SQL**, filtres campus/espace d'embedding/`visibility.roles` obligatoires dans les DEUX branches), routes réelles `/search` (re-autorisation batch à la réponse, **fail-closed** si ERP injoignable, dédup par source, compteur `usage_monthly`), `/ingest` (202, file bornée + consommateur séquentiel dans le lifespan), `/usage` ; worker CLI `python -m workers.ingest_worker --campus …` (backfill heures creuses). **Tests** : Node 607 verts (dont `ai.internal.test.js` : clamp, curseur, falsification de scope, citations) ; service 56 verts dont **suite intégration §4.6 sur pgvector réel (7 tests : fuite inter-campus, falsification de scope, visibilité intra-campus, épinglage du modèle d'embeddings, idempotence/prune, révocation, compteurs)** — **job CI dédié bloquant** ; ruff+mypy 0 erreur ; boot réel vérifié (readyz ready, usage/ingest/search corrects, consommateur survivant à une panne ERP). Écarts : (a) bench D2 = script `scripts/bench_embeddings.py` livré mais **non exécuté** (≈ 2 Go de modèles à télécharger) — à lancer AVANT tout index de production, la colonne reste `vector(1024)` ; (b) client API frontend toujours différé à la première surface UI (M4, note M2) ; (c) programmes/FAQ public-portal (2ᵉ incrément D6) non faits — reportés M4+. |
| 2026-07-04 | **M4 — Chat RAG (Feature 1)** | ✅ | **ai-service** : `POST /chat` SSE réel conforme Annexe B (`message_start/delta/citations/done/error`, commentaire `:keep-alive` 15 s §6.1) — orchestration en deux phases (`services/chat.py` : `prepare_turn` = tout ce qui peut échouer AVANT le premier octet → erreurs HTTP propres 404/429/503 ; `stream_turn` = séquence SSE, échec amont → événement `error` localisé 10 langues) ; **retrieval re-autorisé AVANT l'appel LLM** (`services/rag.py` : hybride M3 → `authorize-citations` batch → seules les sources autorisées entrent dans le prompt ET les citations — plus fort que filtrer après ; ERP injoignable = **fail-closed** 503) ; garde-fous §4.1.6 (`prompts/chat.py` : préfixe système STABLE cache-friendly §10bis, contexte non fiable délimité en fin de prompt, délimiteurs embarqués strippés, `sanitize_output` sur la réponse persistée) ; langue de réponse via claim S2S `language` ; **re-check budget étage 2** via claim `monthlyTokenBudget` (429 avant l'appel LLM, 0 = illimité) ; historique borné (`CHAT_HISTORY_MAX_MESSAGES=10`) ; persistance `conversations`/`messages` derrière l'abstraction `ConversationStore` (scoping (campus,user) par signature, autre user → 404 sans oracle d'existence) ; `GET /conversations` + `/conversations/:id` réels ; comptabilité tokens dans `usage_monthly` (exacte si l'amont la fournit — Anthropic/OpenAI-compatible —, estimée ~4 chars/token sinon ; providers request-scoped). **Node** : claims S2S `language` (via `settings.getPreferredLanguage`, fallback 'en') + `monthlyTokenBudget` ajoutés au contrat §4.2 **des deux côtés** ; `listConversations` re-enveloppé `sendPaginated` (conformité Annexe B). **Frontend** : premier client API `src/services/aiService.js` (règle Annexe B) — axios pour search/conversations/usage, `streamAiChat` en fetch+ReadableStream (parseur SSE, handlers par événement, `abort()`). **Tests** : service 68 unit verts (dont 22 chat/conversations : séquence SSE, persistance+usage, budget, ownership, **§4.6 re-autorisation chat** — source refusée absente du prompt ET des citations, fail-closed ERP down, falsification de scope body — et **§4.6 injection** — zone unique, délimiteurs strippés, système immuable, sortie assainie) + intégration pgvector 9 verts dont **eval RAG de base** (`tests/integration/test_rag_eval.py` : jeu doré 5 Q→source, plancher recall@3 ≥ 0,8, scoping campus du harnais) ; ruff+mypy 0 erreur ; **boot réel vérifié** (readyz, 2 tours SSE complets avec historique, compteurs 242/8 tokens, déconnexion client = tour non persisté) ; Node 608 verts, lint 0 erreur. Écarts : (a) contrat S2S étendu de 2 claims (`language`, `monthlyTokenBudget`) — précision nécessaire au §11.3 étage 2 et à la langue §7, consignée dans les deux `security` ; (b) réponse partielle non persistée sur déconnexion client (v1 documenté) ; (c) tools/function-calls du chat (§7 « option avancée ») non faits — optionnels, reportés ; (d) programmes/FAQ public-portal (2ᵉ incrément D6) toujours reportés M5+. |
| 2026-07-04 | **M5 — Analytics assisté (Feature 2)** | ✅ | **Node** : stub 501 `GET /internal/ai/aggregates/:name` remplacé — registre `modules/ai/ai.aggregates.js` (3 agrégats = 3 rapports Annexe B, noms partagés `shared/constants/ai.constants.js` `AI_ANALYTICS_REPORTS` : `class-performance`, `attendance-summary`, `dropout-risk`) ; figures via les **façades service existantes uniquement** (result : `getCampusOverviewAggregates` — même pipeline que l'overview campus, une seule source de chiffres — et `getDropoutRiskDistribution` — nouvelle agrégation pire-score-par-étudiant-distinct, buckets <30/30-59/≥60 alignés sur le seuil `atRisk` ; student : `summarizeAttendanceTotals` + `getAvgAbsenceRateForCampus`) ; **SANS PII par construction** (compteurs/taux/distributions, jamais un nom ni un id étudiant — D7/§4.3) ; gate de rôle miroir de la route publique (`ANALYTICS_ROLES`, défense en profondeur — le sujet S2S est l'utilisateur final) ; **params validés DEUX fois avec une seule implémentation** (`validateAggregateParams` : passerelle sur le body, API interne sur la query ; clés inconnues rejetées — un scope glissé en param → 400, jamais ignoré) ; enums/formats dans le module propriétaire (`result.isValidSemester`/`isValidAcademicYear`) ; passerelle `POST /api/ai/analytics/:report` : 404 rapport inconnu, claim `language` (locale préférée, comme le chat). **ai-service** : `ERPClient.get_aggregate` réel ; `services/analytics.py` — **agrégat ERP récupéré À CHAQUE appel AVANT le cache** (même discipline que les citations chat §4.5 : Node re-applique rôle+campus à chaque requête, un snapshot ne répond jamais à une requête que Node refuserait ; ERP injoignable = **fail-closed 503**) ; snapshot (`analytics_snapshots`, `SqlSnapshotStore`, clé campus+report+params JSONB+langue, TTL `ANALYTICS_SNAPSHOT_TTL_SECONDS` défaut 3600 s) réutilisé **seulement si les figures fraîches sont identiques** — le cache n'économise QUE l'appel LLM, jamais l'autorisation ni la fraîcheur des chiffres ; re-check budget étage 2 (429) ; narration `provider.chat` bornée (`ANALYTICS_MAX_OUTPUT_TOKENS` 512), préfixe système stable par langue §10bis (`prompts/analytics.py` : « chaque nombre vient verbatim des figures » — ADR-4), figures en **zone non fiable** + `sanitize_output` ; comptabilité `usage_monthly` ; route réelle `/analytics/:report` (404/422/429/503), stub retiré. **Frontend** : `runAiAnalytics(report, params)` ajouté à `aiService.js` (règle Annexe B — aucune UI ne le consomme encore). **Tests** : Node **631 verts** (+23 : `result.service.test.js` — filtres castés, mise en forme plate, zéros explicites, figures verbatim ; pipeline dropout en non-régression ; `ai.internal.test.js` aggregates — 404, 403 rôle, falsification de scope query, validation params, figures dérivées présence), lint 0 erreur ; service **79 unit verts** (+15 analytics : figures ERP **verbatim**, falsification scope via params, fail-closed, budget, cache LLM-only + **invalidation quand les figures bougent**, clé de cache params+langue, zone non fiable + sortie assainie) + **intégration pgvector 13 verts** (+4 `SqlSnapshotStore` : égalité JSONB indépendante de l'ordre des clés, jamais servi à un autre campus/langue, fenêtre TTL + TTL 0, dernier snapshot) ; ruff+mypy 0 erreur. **Boot réel vérifié** (Node+Atlas+service+Postgres, profil mock) — il a attrapé **2 bugs invisibles aux mocks**, corrigés puis re-testés : (1) **cast ObjectId manquant** dans les façades result (les pipelines d'agrégation ne castent pas → figures vides sur un campus AVEC données) ; (2) **le cache snapshot servait un rôle refusé par Node** (STUDENT servi par le snapshot d'un CAMPUS_MANAGER) → réordonnancement ERP-avant-cache ci-dessus. Rejeu final : figures réelles (4 publiés, moyenne 10,81, passingRate 50 ; présence 31 sessions/80,6 %), STUDENT → 503, rejeu = même `snapshotId` et `requestCount` inchangé. Écarts : (a) frontière M5/M5b respectée — rapports v1 = 3 synthèses descriptives, prévision/scoring = engine M5b ; (b) bench D2 toujours **non exécuté** (avant tout index de prod) ; (c) programmes/FAQ public-portal (2ᵉ incrément D6) toujours reportés. |
| 2026-07-04 | **M5b — Moteur quantitatif + advisors** | ✅ | **Node** : registre `ai.aggregates.js` étendu de 3 agrégats advisors **sans PII par construction** (constantes partagées `AI_ADVISOR_AGGREGATES` + `AI_ADVISORS` dans `shared/constants/ai.constants.js`) via les **façades des modules propriétaires uniquement** : finance — `getOverdueAgingAggregates` (nouveau pipeline `$bucket` sur jours de retard : bandes 1-30/31-60/61-90/90+ zéro-remplies, count/outstanding/avgReminderCount — jamais un id étudiant) et `getMonthlyCashflowSeries` (séries mensuelles income/expense/net **continues et zéro-remplies** sur le couple dénormalisé (year, month), months borné [3,24]) ; partner — `getLeadFunnelAggregates` (réutilise les stats leads existantes + 2 nouveaux pipelines fraude/`$isoWeek`, série hebdo 8 semaines zéro-remplie, honeypot exclu partout). **Gate de rôle PAR agrégat** (`aggregateRoles(name)` : analytics = staffing, advisors = `ADVISOR_ROLES` D9 — un TEACHER lit `attendance-summary` mais jamais `finance-overdue-aging`) ; passerelle `/api/ai/advisors/:advisor` durcie : 404 advisor inconnu, **whitelist de params par advisor** (même implémentation `validateParams` que les agrégats — finance:{months}, academic:{academicYear,semester}, marketing:{}), claim `language`, route `authorize` sur `ADVISOR_ROLES`. **ai-service** : `engine/` D8 (**`ENGINE_VERSION heuristics-1.0.0`**, pur, sans I/O ni LLM) — `overdue_priority` (part du montant × poids d'ancienneté × historique payeur saturé à 5 rappels, rang déterministe), `dropout_risk_summary` (parts/riskIndex/alertLevel sur la distribution ERP), `zscore_latest` (baseline = série sauf dernier point, règle stdev 0, seuil |z|≥2) ; `advisors/` finance→academic→marketing (ordre D9) composant agrégats **re-lus à CHAQUE appel via Node** (fail-closed 503, même discipline §4.5) + engine + LLM ; **le LLM ne décide RIEN de structurel** : nombre/ordre des propositions, evidence, `suggestedAction` et chiffres viennent de l'engine ; il localise titres et rédige les rationales via une sortie **JSON strict validée** (`_parse_narration` : cardinalité exacte, chaînes non vides, sanitize) et **toute déviation retombe sur la prose déterministe** (figures verbatim — le profil mock exerce ce chemin en CI) ; 0 proposition ⇒ réponse sans appel LLM (0 token) ; miroir de rôle D9 côté service (403) ; re-check budget étage 2 (429) ; comptabilité `usage_monthly` ; route réelle `POST /advisors/:advisor` (404/403/422/429/503), **dernier stub 501 supprimé** (`api/stubs.py` retiré). **Frontend** : `runAiAdvisor(advisor, params)` dans `aiService.js` (règle Annexe B — aucune UI ne le consomme encore). **Tests** : Node **646 verts** (+15 : `finance.service.test.js` — cast ObjectId, bandes zéro-remplies, série continue traversant le passage d'année, bornage months ; `partner.service.test.js` nouveau — scope campus+honeypot sur chaque pipeline, série ISO-8601 continue, zéros explicites ; `ai.internal.test.js` — gate par agrégat TEACHER 200/403, whitelist months, scope en query → 400), lint 0 erreur ; service **102 unit verts** (+23 : `test_engine.py` — **scores épinglés bit à bit**, tout changement d'heuristique force un bump de version ; `test_advisors_api.py` — 401/422/404/403 miroir, fallback déterministe, le LLM ne peut pas changer la cardinalité, falsification de scope via params, fail-closed ERP, budget 429, 0-signal sans LLM, sanitize des délimiteurs, passthrough des filtres academic vers l'écran ERP, marketing backlog/fraude/anomalie) ; ruff+mypy 0 erreur. **Vérifié en réel** : pipelines `$bucket`/`$isoWeek` exécutés sur Atlas (funnel = 1 lead réel matché — preuve du cast ObjectId ; aging sur 2 dettes temporaires marquées puis supprimées, bandes 1-30/90+ correctes) ; boot complet service+Node : `/advisors/finance` → `proposals: []` légitime (campus sans impayés, 0 appel LLM), `/advisors/marketing` → proposition réelle sur le lead réel (fallback mock), STUDENT → 403, advisor inconnu → 404, TEACHER sur agrégat advisor via `/internal/ai` → 403, `usage_monthly` incrémenté. Écarts : (a) §6.5 mentionnait statsmodels/Prophet — v1 = heuristiques déterministes pures **conformément à D8** (pas de dépendance ML ajoutée ; modèles appris = phase ultérieure) ; (b) pas de forecasting dédié en v1 (D8 liste 3 calculs — la « prévision de trésorerie » §6.6 est servie par la série cashflow + anomalie ; réévaluer en M6+) ; (c) bench D2 toujours **non exécuté** (avant tout index de prod) ; (d) programmes/FAQ public-portal (D6, 2ᵉ incrément) toujours reportés. |
| 2026-07-05 | **M6 — Durcissement échelle** | ✅ | **ai-service** : (1) **Cache** derrière l'abstraction `core/cache.py` (`Cache` → `RedisCache` si `REDIS_URL` + extra `[redis]`, sinon `InMemoryTTLCache` borné FIFO, `NullCache` pour TTL 0) — **cost-only par construction** : seul l'embedding de la requête est mis en cache (`embed_query_cached`, clé `emb:sha256(model‖texte)` — model-scopé §6.4), **jamais** une décision d'autorisation ; l'ingestion ne passe pas par le cache (chunks uniques) ; câblé dans `/search` et le retrieval chat (`services/rag.py`) — la re-autorisation §4.5 reste exécutée à chaque appel ; toute panne Redis dégrade en *miss* (jamais en erreur). (2) **Observabilité** (`core/observability.py`) : `/metrics` Prometheus (`ai_requests_total`, `ai_request_duration_seconds`, `ai_llm_tokens_total`, **`ai_llm_cost_usd_total`** via table de prix §10bis surchargeable par `LLM_PRICES_JSON` sans release, `ai_cache_events_total`, `ai_budget_denials_total`) ; **middleware ASGI pur** (streams SSE intacts) qui chronomètre chaque requête, compte les statuts et **propage le request-id** (`X-Request-Id` entrant honoré/minté, re-émis en réponse ET reporté sur les appels `/internal/ai` sortants → corrélation Node ↔ service ↔ Node) ; les providers LLM alimentent tokens+coût+latence via `_record_usage`. (3) **Budget consolidé** : `enforce_budget` unique (`services/usage.py`) remplace les 3 gardes dupliquées de chat/analytics/advisors — refus 429 + `ai_budget_denials_total`, **alerte WARN à 80 %** (`BUDGET_ALERT_RATIO`) comme signal d'alerting log-based ; `BudgetExceededError` déplacée dans `usage.py` (ré-exportée). (4) **Purge de rétention** D7 (`services/retention.py` + tâche périodique dans le lifespan, `RETENTION_SWEEP_INTERVAL_SECONDS`) — supprime les conversations dont la dernière activité dépasse `CONVERSATION_RETENTION_DAYS` (messages en `ON DELETE CASCADE`) ; jamais fatale (une passe qui échoue est loggée). (5) **Eval RAG étendue** (gold set 5→7). (6) **Harnais de charge** `scripts/loadtest.py` (SLO §10bis, sortie non-zéro sur breach). **Node** : `ai.service.js` génère/propague `X-Request-Id` (`crypto.randomUUID` par défaut) sur chaque appel au service. **Compose/env/deps** : service Redis opt-in (`--profile cache`) ; `.env.example` + `docker-compose.yml` documentent cache/budget/observabilité ; `prometheus-client` en base, `redis` en extra. **Tests** : service **137 verts** (+35 : `test_cache.py` — TTL/éviction/NullCache, hit/miss, bypass TTL 0, clé model-scopée ; `test_observability.py` — coût connu/inconnu, override env, fallback JSON invalide, request-id minté/honoré, `/metrics` servi, en-tête écho ; `test_budget.py` — unlimited, sous-seuil, alerte 80 %, refus + métrique ; intégration `test_retention.py` — cascade réelle + cutoff + no-op TTL 0), ruff+mypy 0 erreur ; **Node 538 verts** (module ai) + lint 0 erreur. **Vérifié en réel** : boot service (readyz `ready`, database `ok`, migrations Alembic appliquées sur le Postgres compose) ; **charge `/search` mesurée** (in-process ASGI, chemin réel embed(mock)→pgvector→upsert usage, Postgres compose) — **c=1 p95=89 ms, c=5 p95=418 ms (sous le SLO 500 ms)** ; **à c=20 sur un même campus p95≈2,3 s** → dégradation identifiée : l'UPSERT `usage_monthly` réécrit **une seule ligne (campus, période)** à chaque requête ⇒ **contention de verrou** amplifiée par la charge mono-campus + boucle d'événements unique du harnais (le trafic multi-campus réel dilue ; à confirmer sur cible déployée). Écarts : (a) **bench D2 toujours non exécuté** — l'installation de `sentence-transformers`/torch (~2 Go) échoue faute de réseau dans le bac à sable ; reste un livrable à lancer **hors-ligne avant tout index de prod** (§18.2) ; (b) **SLO chat (TTFT/réponse complète) non mesurés** — exigent un profil LLM réel (clé) + ERP complet, hors de portée du bac à sable ; à exécuter sur la cible après décision D4 ; (c) **contention `usage_monthly` sur campus chaud** à revoir en M6+ (compteur d'adoption déféré/shardé pour `/search`) ; (d) reports historiques inchangés : 2ᵉ incrément D6 (programmes/FAQ), tools/function-calls chat (§7), première surface UI consommant `aiService.js`. |

| 2026-07-06 | **Incrément produit — Tools/function-calls du chat (§7, option avancée)** | ✅ | Livre l'option §7 « exposer des *function calls* en lecture seule (ex. "quelle est ma moyenne ?") ». **Opt-in** (`CHAT_TOOLS_ENABLED`, défaut `false` → comportement M4 inchangé : vrai streaming token, aucun aller-retour tool). **ai-service** : (1) registre `app/tools/registry.py` — 1 tool v1 `get_my_grades` (rôle `STUDENT`), schéma JSON provider-agnostique, filtres non-identité whitelistés (`academicYear`/`semester`) ; `execute_tool` **ne passe jamais d'id** (le périmètre est le sujet S2S), ignore tout argument d'identité produit par le LLM, et **ne lève jamais** dans le stream (tool inconnu/hors-allowed/mauvais rôle/ERP down → résultat textuel bénin, jamais un chiffre inventé). (2) Boucle agentique bornée `LLMProvider.run_tools` (`max_iterations`, réponse finale forcée sans tools au plafond) + `_complete_with_tools` pour les 3 providers (mock déterministe déclenché par mots-clés ; `openai_compatible` param `tools`/`tool_calls` ; `anthropic` blocs `tool_use`/`tool_result`) ; usage **cumulé** sur toute la boucle (comptabilité §11.3 exacte). (3) `services/chat.py` : décision des tools dans `prepare_turn` (executor lié à l'identité S2S + ERP, jamais exposé au provider), exécution dans `stream_turn` — la boucle est non-streamée, la réponse finale est **chunkée en `delta`** (contrat Annexe B inchangé : `message_start → delta* → citations → done`). (4) `prompts/chat.py` : clause tools **stable** ajoutée seulement si tools actifs (préfixe cache-friendly §10bis préservé). (5) `ERPClient.get_self` → `GET /internal/ai/me/:resource`. **Node** : registre auto-scopé `modules/ai/ai.self.js` (mêmes validateurs que les agrégats, `validateParams` exporté depuis `ai.aggregates.js`) ; endpoint interne `GET /internal/ai/me/:resource` (`getSelfResource`) — **sujet = identité S2S exclusivement** (`req.s2s.userId`/`campusId`), gate de rôle par ressource, toute clé de scope en query rejetée (§4.6) ; façade **ERP-calculée** (ADR-4) `result.service.getStudentGradesSummary` + agrégation `aggregateStudentGradesSummary` (moyenne/passing/best/worst, PII-free, scopée 1 étudiant). **Tests** : service **133 verts** (unit, hors intégration ; +11 : `test_tools.py` 7 — gate rôle, scope sur le token en ignorant l'identité injectée, filtres whitelistés, résultats bénins unknown/hors-allowed/mauvais rôle/ERP down ; `test_chat_tools.py` 4 — tour tool scopé token bout-en-bout + chiffres ERP dans la réponse streamée, non-grade = 0 tool, opt-in off = 0 tool, rôle non-STUDENT = 0 tool), ruff+mypy 0 erreur ; **Node** : `ai.internal.test.js` 29 verts (+5 self-resource : unknown 404, rôle non-propriétaire 403, falsification userId/campusId query 400, filtres validés forwardés avec user+campus du token, format invalide 400) ; suites `ai.*` 49 verts + `result.*` 44 verts, eslint 0 erreur. `.env.example` documente les 2 réglages. Écarts : (a) v1 = **1 seul tool** (`get_my_grades`) ; `get_my_attendance` reporté (le static `getStudentStats` exige année+semestre → fragile sans résolution "période courante" côté ERP) ; (b) tours tool = **streaming chunké** (pas token-vrai) — la boucle agentique est non-streamée (compromis v1 documenté) ; (c) providers payants (`openai_compatible`/`anthropic`) corrects par construction mais **non exercés en bac à sable** (pas de clé/réseau) — validés par mypy + à vérifier sur cible. |

| 2026-07-06 | **Incrément produit — 2ᵉ incrément D6 : corpus public du portail (programmes + FAQ)** | ✅ | Indexe le corpus **public** du `public-portal` (D6, 2ᵉ incrément) — **risque nul, aucune PII**. **Node** : (1) source unique de vérité `shared/constants/ai.constants.js` (`AI_SOURCE_TYPES` = `document`/`portal-program`/`portal-faq`, `AI_PORTAL_SOURCE_TYPES`, `AI_INGESTABLE_SOURCE_TYPES`, `AI_SEARCHABLE_SOURCE_TYPES`), miroir verbatim `ai-service/app/core/constants.py`. (2) Façade `publicPortal.listAiIngestables` — **même contrat** que `document.listAiIngestables` (`isPublished:true` obligatoire → un brouillon ne fuit jamais ; tri stable `(updatedAt,_id)` ; curseur keyset décodé par l'appelant ; `sourceId` pour l'événementiel ; texte bilingue {fr,en} concaténé pour le rappel, titre en langue primaire = label de citation ; `version` = epoch `updatedAt` → prune déterministe ; `visibility.roles=[]` = tous les rôles du campus) sur `CoursePreview` (`portal-program`) et `FaqEntry` (`portal-faq`), via `public-portal.repository` (`findIngestablePortalSources`/`findPortalCitationDocs`, champ campus `schoolCampus`). (3) Passerelle interne dé-gate le param `type` (`AI_INGESTABLE_SOURCE_TYPES`, sinon 422) et **route** vers la bonne façade (document vs portail), curseur opaque à espace distinct par type ; `authorize-citations` groupe par `sourceType` et fusionne les deux sous-ensembles autorisés. (4) Re-autorisation portail **triviale** (`publicPortal.authorizeAiCitations` : encore publié + campus cohérent, **aucun gating par utilisateur** — corpus public) ; global roles ADMIN/DIRECTOR = tout campus. (5) Signal `ai.service.signalIngest` (généralisé depuis `signalDocumentIngest`, alias conservé) **fire-and-forget** émis sur create/update/publish/unpublish/delete des programmes et FAQ (`portal-admin.factory` option `ingestSourceType`). (6) Passerelle `/search` élargit `types` à `AI_SEARCHABLE_SOURCE_TYPES` par défaut et rejette tout type inconnu. **ai-service** : `app/core/constants.py` créé ; `IngestRequest.source_type` / `SearchRequest.types` élargis aux types portail + `field_validator` rejetant l'inconnu ; `rag.retrieve_context` récupère sur **tout** le corpus (`SEARCHABLE_SOURCE_TYPES`) ; backfill campus (`run_queue_consumer`, `source_id=None`) **itère sur `INDEXABLE_SOURCE_TYPES`** (espace de curseur propre par type) ; `PgVectorStore` inchangé (`visibility.roles=[]` déjà = visible à tous — vérifié). **Tests** : Node **663 verts** (nouveau `public-portal.ai.test.js` — contrat ingestable programme/FAQ, `isPublished`+campus, sentinelle limit+1/curseur, type non supporté, autorisation triviale scopée/ADMIN/ids vides ; `ai.internal.test.js` — type inconnu rejeté sans appel façade, routage type portail, round-trip curseur, citations groupées par type fusionnées), eslint 0 erreur ; service **141 unit verts** (`test_search_api.py` — acceptation portail, défaut = corpus complet forwardé au store, scope narrow ; `test_ingest.py` — 2 types portail acceptés/503 vs inconnu 422, `run_queue_consumer` itère chaque corpus indexable ; `test_chat_api.py` — retrieval chat couvre tout le corpus), ruff 0 erreur. **Non commité** (QA porteur). Écarts : aucun — le pipeline ai-service était déjà générique sur `source_type` (seuls 2 gates Pydantic élargis + boucle backfill + `types` du retrieval). |
| 2026-07-06 | **Décisions porteur — D10 (prix) & D4 (hébergement)** | ✅ | Aucun code. **D10** tranché : `free` **0 €** / `standard` **99 €** / `premium` **299 €** par campus/mois (add-on forfaitaire, option A) — COGS négligeable au plafond (§10bis), prix à la valeur ; top-up de budget pour gros campus laissé en option. **D4** confirmé : Postgres+pgvector **Neon UE (Francfort)** (magasin des conversations = PII, résidence UE), LLM premium **Anthropic sous DPA** (bascule Mistral UE possible sans code plus tard), **Redis différé** (mono-réplica pilote → cache in-process M6) ; host du conteneur (Scaleway Paris ou VPS ≥ 4 Go) à finaliser au déploiement. §15 (D4/D10) et §18.3 mis à jour. **Ne débloque aucun jalon** (tous réalisés) ; débloque les mesures de charge cible §18.2 une fois déployé. |
| 2026-07-07 | **Préalable opérationnel — bench D2 exécuté** | ✅ | Aucun code. Réseau désormais ouvert → `scripts/bench_embeddings.py` lancé hors-ligne (venv jetable, torch CPU + sentence-transformers, modèles chargés depuis cache local ; `HF_HUB_OFFLINE=1` pour contourner le rate-limit HF qui bloquait le client). Résultat sur corpus jouet FR/EN/AR (6 docs/12 requêtes) : **bge-m3 (1024d)** recall@1 **1.00** / recall@3 1.00 / 129 ms·req ; **e5-base (768d)** recall@1 **0.83** / recall@3 1.00 / 66 ms·req. La règle recall@3 ≥ 95 % désignait e5-base, mais recall@3 sature à 1.00 pour les deux → seul discriminant recall@1, favorable à bge-m3, et e5-base exigerait le plumbing des préfixes `query:`/`passage:`. **Décision porteur : conserver `bge-m3` (1024d), colonne `vector(1024)` définitive** — aucun code touché. **Préalable §18.2(1) clos** : le premier index de prod peut être construit sans changement de dimension. §15/D2, en-tête (v4.11) et §18.2 mis à jour. |

**État des artefacts au 2026-07-05 (fin M6 — tous jalons réalisés)** : dépôt
frère `ai-service/` complet (non commité, plus aucun stub 501) — M6 ajoute
`core/cache.py`, `services/retention.py`, `scripts/loadtest.py`, réécrit
`core/observability.py` (métriques + request-id) et consolide le budget dans
`services/usage.py` ; backend Node : module `modules/ai/` complet + façades
agrégats advisors dans finance/partner (non commité) — M6 ajoute la propagation
`X-Request-Id` dans `ai.service.js` ; frontend : client API `aiService.js`
complet (`runAiAdvisor` inclus), **aucune UI ne le consomme encore**. Si vous
trouvez du code Phase 3 non mentionné ici, le journal n'a pas été tenu :
reconstituez l'état réel et mettez-le à jour **avant** de continuer.

### 18.2 Pour reprendre (tous les jalons M0→M6 sont réalisés)

Il ne reste **aucun jalon** ouvert. Les travaux restants sont des **décisions
porteur** et des **préalables opérationnels** (§18.3), plus des reports connus
à planifier quand le produit les demandera :

1. ~~**Préalable bloquant avant le premier index de production** : exécuter le
   bench D2~~ — **FAIT le 2026-07-07** (`ai-service/scripts/bench_embeddings.py`,
   sentence-transformers CPU sur corpus jouet FR/EN/AR). Résultat : `bge-m3`
   (1024d) recall@1 **1.00** vs `e5-base` (768d) **0.83** (recall@3 = 1.00 pour
   les deux). **Décision porteur : conserver `bge-m3`, colonne `vector(1024)`
   définitive** (détail §15/D2). Ce préalable est **clos** ; le premier index de
   prod peut être construit sans changement de dimension.
2. **Vérifications de charge à refaire sur cible déployée** (après D4) : les SLO
   §10bis **chat** (TTFT, réponse complète) exigent un profil LLM réel + ERP
   complet — non mesurables en bac à sable. Le harnais `scripts/loadtest.py` est
   prêt (`--scenario chat`). Rejouer aussi `/search` sous uvicorn multi-workers
   (embeddings réels en threadpool) pour lever l'artefact de contention
   `usage_monthly` observé en mono-campus/in-process (cf. §18.1 M6).
3. **Optimisation identifiée en M6** : l'UPSERT du compteur d'adoption
   `usage_monthly` sur `/search` réécrit une seule ligne par (campus, période)
   → contention sur campus chaud. À déférer/sharder si les mesures cible le
   confirment.
4. **Reports produit** : **première surface UI** consommant `aiService.js` (règle
   Annexe B — à synchroniser avec le premier écran qui affiche
   chat/analytics/advisors). *(2ᵉ incrément d'ingestion D6 — programmes/FAQ
   public-portal : **FAIT** le 2026-07-06, corpus public indexé en `portal-program`/
   `portal-faq`, risque nul ; extension naturelle : ré-indexer d'autres contenus
   publics du portail — témoignages, actualités — sur le même patron de façade.)*
   *(Tools/function-calls du chat §7 : **FAIT** le
   2026-07-06 — opt-in `CHAT_TOOLS_ENABLED`, tool v1 `get_my_grades` ; extension
   naturelle : `get_my_attendance` une fois la "période courante" résolue
   côté ERP, et exposition des tools au front quand une UI chat existera.)*

### 18.3 En attente du porteur (ne bloque aucun jalon — tous réalisés)

- ~~**Prix de vente des plans** (D10)~~ — **TRANCHÉ le 2026-07-06** : free 0 € /
  standard 99 € / premium 299 € par campus/mois (add-on forfaitaire). Détail §15
  (D10). Reste facultatif : politique de top-up de budget pour les gros campus.
- ~~**Confirmation hébergement de production + résidence UE** (D4)~~ —
  **CONFIRMÉ le 2026-07-06** : Postgres+pgvector **Neon UE (Francfort)**, LLM
  premium **Anthropic sous DPA**, Redis différé (mono-réplica). Détail §15 (D4).
  Sous-décision restante non bloquante : host du conteneur (Scaleway Paris ou VPS
  ≥ 4 Go) à finaliser au déploiement. Débloque les mesures de charge cible §18.2.
- **Actions prod héritées d'autres chantiers** (rappel, hors Phase 3) :
  migration d'activation des comptes (cf. §17).

---

### Annexe A — Pourquoi ce découpage ne casse rien

- Le front ne change pas de point d'entrée (toujours l'API Node, même auth).
- Le module `ai` est **un module de plus** qui respecte la façade — l'invariant
  des 22 modules tient (devient 23).
- L'ERP n'a **aucune** dépendance dure au service IA : si l'IA est éteinte,
  `/api/ai` répond 503 et **tout le reste fonctionne**.
- Aucune table Mongo n'est touchée ; Postgres est introduit **à côté**, sur des
  données neuves → risque de migration nul, et bénéfice (pilote Postgres) réel.

---

### Annexe B — Contrats d'API figés (v1, nouveau v4)

Les routes publiques suivent la forme du projet `{ success, message, data,
meta }` (response-helpers, CLAUDE.md §4). Le **streaming SSE est la seule
exception** (flux d'événements bruts). Toute évolution d'un contrat = révision
de cette annexe **et** synchro du client API frontend dans la même tâche.
Ids ERP = ObjectId (string 24 hex) ; ids côté service IA = `uuid`.

#### `POST /api/ai/chat` — SSE

Requête :
```json
{ "message": "string, 1..4000", "conversationId": "uuid | null" }
```
Flux (`Content-Type: text/event-stream` ; `event: <type>` / `data: <json>`) :
```
message_start   { "conversationId": "uuid" }
delta           { "text": "..." }                      // répété
citations       { "items": [ { "sourceType": "document|result|course|faq",
                               "sourceId": "<id ERP>", "label": "...",
                               "url": "/chemin/erp" } ] }   // déjà re-autorisées (§4.5)
done            { "usage": { "inputTokens": n, "outputTokens": n },
                  "profile": "free|premium" }
error           { "code": "AI_DISABLED|AI_NOT_ENABLED|AI_FEATURE_NOT_IN_PLAN|
                           AI_BUDGET_EXCEEDED|UPSTREAM_TIMEOUT|INTERNAL",
                  "message": "localisé" }
```
Commentaire `:keep-alive` toutes les 15 s (pièges SSE, §6.1). L'annulation
client (fermeture de connexion) aborte l'appel amont.

#### `POST /api/ai/search`

```json
// Requête
{ "query": "string, 1..500", "types": ["document"], "limit": 10 }
// data (limit clampé à 50)
{ "results": [ { "sourceType": "...", "sourceId": "...", "title": "...",
                 "snippet": "...", "score": 0.87, "url": "/..." } ] }
```

#### Conversations

- `GET /api/ai/conversations?page&limit` → `sendPaginated`,
  `data = [ { "id", "title", "updatedAt", "messageCount" } ]`
- `GET /api/ai/conversations/:id` →
  `data = { "id", "messages": [ { "role": "user|assistant", "content",
  "citations": [...], "createdAt" } ] }`

#### `POST /api/ai/analytics/:report`

```json
// Requête
{ "params": { } }                       // schéma par report, validé côté Node
// data
{ "figures": { },                       // chiffres ERP/engine — JAMAIS générés par le LLM
  "narrative": "string",                // langue préférée de l'utilisateur
  "snapshotId": "uuid", "generatedAt": "iso" }
```

#### `POST /api/ai/advisors/:advisor` — rôles habilités uniquement

```json
// data
{ "proposals": [ { "title": "...", "rationale": "...",
                   "evidence": [ /* citations, mêmes champs que chat */ ],
                   "suggestedAction": { "type": "...", "payload": { } } } ],
  "engine": { "modelVersion": "...", "outputs": { } } }
```
> `suggestedAction` est une **proposition affichée à un humain** — jamais
> exécutée par l'IA (garde-fous §6.6). Le frontend la rend comme un bouton
> d'action ERP classique, soumis aux permissions habituelles de l'utilisateur.

#### `GET /api/ai/usage` — CAMPUS_MANAGER+

```json
{ "period": "2026-07", "plan": "premium", "tokensIn": 1200000,
  "tokensOut": 180000, "budget": 2000000, "remaining": 620000 }
```

#### API interne S2S (`/internal/ai/*`)

> **Précision v4.5 (implémentée en M3)** : comme toutes les routes Node, les
> réponses de l'API interne sont enveloppées `{ success, message, data }`
> (response-helpers) — les corps ci-dessous sont le contenu de `data`.
> Le scope campus/user vient exclusivement du JWT S2S (jamais de la query).

```
GET  /internal/ai/ingestables?type&updatedAfter&cursor&limit&sourceId
  (limit clampé ≤ 200 §6.3.1 ; sourceId = lecture d'UNE source pour
   l'ingestion événementielle — absente/dé-publiée → items vide, le service
   purge ses chunks)
  → { "items": [ { "sourceType", "sourceId", "version", "campusId",
        "visibility": { "roles": ["STUDENT"], "ownerId": null },
        "title", "text", "metadata": { } } ],
      "nextCursor": "opaque | null" }

POST /internal/ai/authorize-citations          (batch ≤ 100, §6.2 — user dérivé du JWT S2S)
  { "citations": [ { "sourceType", "sourceId" } ] }
  → { "allowed": [ { "sourceType", "sourceId", "label", "url" } ] }   // sous-ensemble autorisé

GET  /internal/ai/aggregates/:name?params      (M5 — agrégats ERP déterministes, SANS PII :
  compteurs/taux/distributions uniquement. name ∈ AI_ANALYTICS_REPORTS
  (class-performance | attendance-summary | dropout-risk) ; campus + identité
  utilisateur depuis le JWT S2S exclusivement, rôle limité aux rôles staffing
  (miroir de la route publique) ; params en query, whitelist par rapport —
  toute clé inconnue (y compris un scope) → 400)
  → { "name", "params", "figures": { }, "computedAt": "iso" }
```

#### API du service IA consommée par Node (S2S, hors reverse-proxy)

```
POST /ingest   { "sourceType": "document", "sourceId": "<ObjectId> | null" }
  → 202 { "queued": true }   (null = backfill campus ; campus dérivé du JWT S2S ;
                              file bornée → 429 ; DB/ERP non configurés → 503)
GET  /usage    → { "period": "YYYY-MM", "tokensIn", "tokensOut", "requestCount" }
  (campus du JWT S2S — alimente la jauge GET /api/ai/usage et la garde budget §11.3)
```
