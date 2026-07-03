# Évaluation de faisabilité — Migration Mongoose → PostgreSQL

> Rédigé le 2026-06-13, après la fin du chantier monolithe modulaire.
> Document de préparation (point 3 de la feuille de route post-migration).
> **Gitignoré** comme le Journal de migration — source de vérité sur disque.
> Ce document ne MIGRE rien : il établit la faisabilité, le blocage principal,
> la stratégie recommandée et les décisions qui restent à l'utilisateur.

---

## 1. Verdict

**Faisable, mais c'est un chantier majeur** — significativement plus gros que le
passage au monolithe modulaire. Le découpage modulaire a rendu la migration
**possible module par module** (chaque module possède ses données, aucun autre
module ne touche sa base), mais il n'a **pas** créé de couche d'abstraction de
persistance. Conséquence : aujourd'hui on ne peut PAS « remplacer Mongoose par
Postgres derrière les services » — la persistance est étalée dans toute la couche
HTTP.

**Recommandation de séquencement : NE PAS attaquer Postgres directement.**
Faire d'abord un chantier intermédiaire — une **couche repository par module** —
qui a de la valeur en soi (testabilité, point de changement unique) et qui est le
prérequis d'une migration Postgres maîtrisée.

---

## 2. Inventaire du couplage Mongoose (mesuré le 2026-06-13)

| Surface | Volume | Impact migration |
|---|---|---|
| Schémas Mongoose | 54 | → 54 tables + types (ou JSONB) |
| **Appels Mongoose directs dans `controllers/`** | **527** | **le vrai coût** — voir §3 |
| Appels Mongoose dans `*.service.js` | 153 | à déplacer/réécrire |
| `.populate(` (jointures applicatives) | 227 | → JOIN SQL |
| `.aggregate(` (pipelines) | 39 | → GROUP BY / window functions / CTE |
| Sessions / transactions (`.session(`) | 40 | Postgres : transactions natives (plus simple) |
| `virtual()` | 32 | → champs calculés / vues / code applicatif |
| Hooks `pre/post` | 138 | logique métier dans la couche modèle → à réimplémenter |
| `ref:` (clés étrangères) | 188 | → FK relationnelles |
| Sous-docs / arrays embarqués | 59 | → JSONB **ou** tables enfants (décision §5) |
| Index `text` (full-text) | 1 | → `tsvector` Postgres |

---

## 3. Le blocage principal : la persistance n'est pas encapsulée

**527 requêtes Mongoose dans les controllers contre 153 dans les services.**
La façade `{ routes, service }` n'abstrait que l'accès *inter-modules* (résorbé
pendant le chantier 20b). À l'*intérieur* d'un module, les controllers tapent les
modèles Mongoose en direct, avec la syntaxe Mongo partout (`$in`, `$gte`, `.lean()`,
`.populate()`, pipelines d'agrégation inline).

Donc migrer un module vers Postgres = réécrire les ~527 sites d'appel répartis sur
**64 controllers**, pas brancher un adaptateur derrière une interface propre.

**Implication** : introduire une **couche repository par module** AVANT (ou comme
première étape de) la migration. Chaque module expose un `*.repository.js` ;
controllers et services n'appellent plus que le repository (jamais Mongoose
directement). On migre ensuite l'intérieur du repository vers Postgres sans
toucher controllers ni services — exactement la promesse que la façade a tenue
au niveau inter-modules, appliquée cette fois au niveau intra-module.

Ce chantier « repository » est **rentable même si Postgres ne se fait jamais** :
testabilité (mock du repository), un seul endroit où changer une requête, fin de
la logique métier noyée dans des pipelines inline de controller.

---

## 4. Surface difficile à traduire (points chauds réels)

- **Agrégations** (39) concentrées sur `teacher` (5), `student` (4), `result` (4) :
  stats de présence, moyennes, dashboards. → SQL `GROUP BY` + fonctions fenêtre.
  Réécriture cas par cas, à fort risque de divergence numérique → **tests de
  non-régression obligatoires** sur ces sorties avant/après.
- **Dénormalisation embarquée** (`course` 7, `student.attend` 5, `document` 5,
  `exam.session` 4) et surtout les **emplois du temps** (StudentSchedule /
  TeacherSchedule embarquent `subject{}`, `teacher{}`, `classes[]`). Décision de
  modélisation : JSONB (mapping 1:1 rapide, requêtes plus faibles) vs tables
  normalisées (propre, mais réécrit la logique de résolution). Voir §5.
- **Hooks** (138) : génération de référence, normalisation, cascades de suppression
  (ex. hook post-delete student → parent). À réimplémenter explicitement (triggers
  Postgres ou code repository) — c'est de la logique métier cachée.
- **`populate`** (227) → JOIN ; attention aux populate imbriqués et conditionnels.
- **ObjectId** → choix `uuid` (proche, pas d'ordre) ou `bigint` identity. 188 FK à
  reporter ; impacte le frontend si les ids changent de format (préférer `uuid`).

---

## 5. Stratégie recommandée

**Étape 0 — Couche repository par module** (prérequis, valeur autonome).COnin
Déplacer les 527 appels Mongoose des controllers vers `modules/<x>/<x>.repository.js`.
Procéder module par module, dans l'ordre du couplage le plus faible (comme le
chantier 20b), avec le filet de tests déjà en place (étendre les contrats aux
repositories). Aucun changement de base à ce stade.

**Étape 1 — Choix de la stack Postgres** (décision utilisateur, §6).
ORM/query-builder : `Prisma` (DX, migrations, typage — mais couche d'abstraction
lourde), `Knex`/`Kysely` (query-builder léger, contrôle fin), ou `pg` brut.
Recommandation par défaut : **Prisma** pour les migrations + le typage, sauf si
les agrégations complexes (§4) penchent pour un query-builder.

**Étape 2 — Pilote sur un module feuille.**
Choisir un module à faible couplage, sans agrégat lourd ni embarqué complexe —
ex. `level`, `announcement`, ou `finance`. Migrer son repository vers Postgres,
valider en double-lecture, mesurer l'effort réel pour calibrer le reste.

**Étape 3 — Strangler module par module.**
Migrer un module à la fois, du plus simple au plus couplé. Le cœur académique
(`student`/`teacher`/`class`/`campus`/`result`/`exam`) en dernier (agrégats +
embarqués + transactions). Pendant la transition, certains modules sont sur
Postgres, d'autres sur Mongo — acceptable car les modules ne partagent pas de
jointures DB (uniquement des appels de façade). Les `populate` inter-collections
qui subsistent à l'intérieur d'un module migrent avec lui.

**Mapping embarqué (décision §6)** : par défaut **JSONB** pour les structures
dénormalisées en lecture seule (snapshots d'emploi du temps), tables normalisées
pour les entités à requêter/filtrer.

---

## 6. Décisions requises de l'utilisateur (avant d'écrire la moindre ligne)

1. **Fait-on l'étape 0 (repository layer) comme chantier à part entière d'abord ?**
   (Recommandé. Rentable seul. Sans ça, Postgres est ingérable.)
2. **ORM/query-builder** : Prisma vs Knex/Kysely vs pg brut ?
3. **Hébergement Postgres** cible (Render/Neon/Supabase/RDS…) et stratégie de
   bascule (double-run vs cutover par module) ?
4. **Format des ids** : `uuid` (recommandé, impact frontend minimal) vs `bigint` ?
5. **Embarqué** : JSONB vs normalisation, au cas par cas selon §5 ?
6. **Calendrier / appétit** : migration réelle maintenant, ou on s'arrête à l'étape 0
   (couche repository) et on garde Mongo tant que l'échelle ne l'exige pas ?

> Mon avis : faire l'étape 0 (repository layer) maintenant — gros effet de levier,
> testable, réversible — et **différer Postgres** tant qu'il n'y a pas de
> contrainte réelle (échelle, coût, besoin transactionnel/relationnel) qui le
> justifie. Migrer une base qui marche est un risque qu'on ne prend que pour une
> raison concrète.

---

## 7. Chantier « couche repository » — programme & journal

Décision utilisateur (2026-06-13) : faire l'étape 0 (repository layer) ; Postgres différé.

**Pattern (figé par le pilote `level`)** :
- `modules/<x>/<x>.repository.js` = SEUL fichier autorisé à toucher le(s) model(s)
  du module. Controllers + service appellent le repository.
- Lectures → objets simples (`.lean()`) ; écritures → load→mutate→save (préserve
  hooks/setters/validations) ou opérateurs atomiques selon le cas.
- Test unitaire par repository (mock du model, aucune DB) qui verrouille les
  formes de requête. Façade `{ routes, service }` inchangée.
- Validation serveur (boot + smoke) + commit isolé par module, comme le 20b.

**Ordre (couplage croissant — le cœur académique en dernier)** :
| Vague | Modules | Note |
|---|---|---|
| Pilote ✅ | level | 10 appels, 0 populate/aggregate — commit (voir git) |
| R1 (feuilles) ✅ | level (pilote), finance, announcement, settings, department, course, subject | TERMINÉE |
| R2 (intermédiaires) ✅ | **admin ✅ 31f7a7a**, **academic-print ✅ (0 modèle, déjà conforme)**, **gaet ✅**, **mentor ✅**, **staff ✅**, **parent ✅**, **class ✅**, **campus ✅**, **partner ✅** (4 models — Partner/Lead/Commission/Application ; 4 controllers + service ; ~60 méthodes repo, agrégats conversion/commission, moteur de commission, anti-fraude IP_BURST ; config de commission embarquée dans Campus → routée via campus.service.getCampusCommissionConfigWithName/setCampusCommissionConfig, ajoutées à campus.repository) | **TERMINÉE** |
| R3 (cœur, lourd) ✅ TERMINÉE | **student ✅ 243ba20** (3 models Student/StudentSchedule/StudentAttendance ; 5 controllers + service + config ; agrégats présence/occupation salles dans le repo ; bulkWrite d'init d'appel encapsulé ; suppression via findByIdAndDelete pour préserver la cascade post-findOneAndDelete ; reach-ins Class→class.service.classExistsInCampus et Campus→campus.service.getCampusNumber, ajoutée à campus.repository ; 24 tests de non-régression agrégats), **teacher ✅ 7031e47** (3 models Teacher/TeacherSchedule/TeacherAttendance ; 4 controllers + service + config ; 53 méthodes repo ; agrégats workload enseignant/workload global/paie encapsulés, $match casté en ObjectId fourni par l'appelant ; touchLastLogin atomique via updateOne ; upsert miroir TeacherSchedule sur studentScheduleRef avec reference en $setOnInsert ; statiques model (detectTeacherConflicts/getTeacherCalendar/getWorkloadSummary/lockDailyAttendance/getTeacherStats) déléguées depuis le repo ; 22 tests de non-régression), **result ✅ 02db0d5** (3 models Result/FinalTranscript/GradingScale ; 3 controllers crud/workflow/analytics + helper + service ; 36 méthodes repo ; agrégats relevé-à-la-volée/overview-campus-facetté/distinct-étudiants-clôture portés par le repo, $match casté en ObjectId fourni par l'appelant ; statiques model computeDropoutRisk/getClassDistribution/generateForStudent déléguées ; session de transaction RETAKE routée via startSession/saveResultDoc({session})/findResultById({session}) ; insertMany ordered:false encapsulé ; RESULT_POPULATE déplacé du helper vers le repo, import mort retiré du workflow ; 35 tests de non-régression), **exam ✅ 7e3e189** (7 models ExamSession/ExamEnrollment/ExamSubmission/ExamGrading/ExamAppeal/QuestionBank/ExamAnalyticsSnapshot ; 9 controllers + service + worker d'analytics + cron anti-triche + helper de synchro d'emploi du temps ; ~95 méthodes repo ; agrégats overview-campus/early-warning-décrochage/stats-par-session portés par le repo, $match casté en ObjectId fourni par l'appelant ; écritures à hook via saveXxxDoc + consumeHallTicket préservé ; atomiques $push flag anti-triche/$inc usageCount/upsert snapshot/publication updateMany ; countPendingGrading caste l'ObjectId dans le repo ; formes de populate carte d'examen/certificat/file de correction déplacées ; 46 tests de non-régression), **document ✅ 6ba9ac4** (5 models Document/DocumentVersion/DocumentAudit/DocumentTemplate/DocumentShare ; 6 controllers + service interne + service façade + cron de rétention + service PDF + 2 middlewares campus/access ; ~40 méthodes repo ; transactions CRUD/workflow/restauration routées via startSession + docs session-aware findXxxForWrite/saveDocumentDoc ; écritures à hook rétention/slug/ref via load→mutate→save ; atomiques nommées $inc downloadCount/usageCount, $push accessedIps, snapshot counters, pdfSnapshot ; agrégat de quota stockage $match casté fourni par le middleware + $group porté par le repo ; garde de débounce des snapshots chaîne lean→session encapsulée ; formes de populate template/partage public et selects déplacés ; enums DOCUMENT_STATUS/TYPE/AUDIT_ACTION restent importés par les consommateurs ; imports morts Document/mongoose retirés des controllers template/export ; 41 tests de non-régression), **public-portal ✅ 351eb79** (7 models CompetitionPrize/ContactMessage/CoursePreview/FaqEntry/QuizQuestion/QuizSession/Testimonial ; controllers publics + back-office portal-admin + cron de clôture mensuelle + service de notification ; factory de contenu générique alimentée par une content-repo liée via repo.contentRepo(name) — les routes admin n'importent plus aucun model ; CompetitionPrize CRUD + clôture cron load→mutate→save + vue publique winners anonymisés + notifyWinners route son save ; QuizSession top-sessions/classement public selects sans donnée perso/anti-double-soumission par token ; QuizQuestion pipeline $sample+$project liste blanche — correctIndex jamais exposé — et +correctIndex forcé pour le scoring ERP ; cast/validation ObjectId restent dans le quiz controller, imports morts mongoose retirés de leaderboard ; 28 tests de non-régression) — **R3 TERMINÉE** : tous les agrégats/embarqués/transactions du cœur académique encapsulés ; tests de non-régression d'agrégats en place |

À chaque « Continue » : traiter le module suivant dans l'ordre (repository + bascule controllers/service + test + validation + commit).
