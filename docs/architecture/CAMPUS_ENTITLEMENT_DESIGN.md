# Entitlement par campus — activation/désactivation des modules

> Rédigé le 2026-08-13. Document de **conception et de cadrage** : il décrit
> *quoi* construire, *comment*, *dans quel ordre*, et **sous quelle condition
> business**, pour doter la plateforme d'un contrôle par campus de ce que chaque
> tenant a le droit d'utiliser — sans casser l'existant et dans la trajectoire du
> projet (monolithe modulaire → PostgreSQL, multi-tenant campus, i18n).
>
> **Public visé** : un développeur qui connaît ce backend (ou qui a lu
> `CLAUDE.md`) et reprend le chantier sans contexte de la discussion d'origine.
> Ce document est sa source de vérité.
>
> **Statut** : **conception approuvée — version complète retenue.** La décision
> bloquante D-A est tranchée (2026-08-13) : une **tarification par palier** est
> à l'horizon, le chantier se justifie et la variante courte du §16.2 est
> écartée. Décisions D-C, D-D, D-E, D-F tranchées le même jour (§14). Reste
> **D-B élargie** : validation du noyau `core` (§5.1) *et* de la catégorie
> `minState` (§4.1.1) avant d'ouvrir la phase 1.
> **Aucune ligne de code écrite à ce jour.**
>
> **Révisions** : v1 (2026-08-13) — conception initiale, issue de l'analyse
> comparative de quatre alternatives (§2.3). **v1.1 (2026-08-13)** — décisions
> D-A / D-C / D-D / D-E / D-F tranchées ; graphe de dépendances réel dérivé du
> code et intégré (§6.3) ; liste `core` proposée sur base quantitative (§5.1).
> **v1.2 (2026-08-13)** — revue « ERP international » : `teacher` et `admin`
> ajoutés au noyau, **catégorie `minState: 'read_only'` créée** (§4.1.1,
> fondée sur le registre de suppression définitive), **§9.1 corrigé** (émission
> vs hygiène — la rétention documentaire ne doit jamais s'arrêter), garanties
> intangibles face à `hidden` posées (§4.1.2). **v1.3 (2026-08-13)** —
> articulation avec la migration PostgreSQL instruite (§15bis) : pas de
> prérequis bloquant, 3 garde-fous de conception.

---

## 0. TL;DR (résumé exécutif)

**Le système demandé existe déjà dans le code, une fois, pour un seul domaine.**
Le module `ai` implémente exactement un entitlement par campus : stockage
(`Campus.aiEntitlement`), audit append-only, gate serveur (`requireAiFeature`),
registre de constantes gelées, endpoint admin de pilotage, dialogue frontend.

Ce chantier ne consiste donc pas à inventer un mécanisme, mais à **généraliser
celui-là aux 24 modules** — et, au passage, à **unifier trois objets de
configuration qui parlent déjà de la même chose** sur le modèle `Campus` :

| Objet existant | Ce qu'il porte | Emplacement |
|---|---|---|
| `features` | quotas (maxStudents, maxTeachers, storage) | `campus.model.js:266-288` |
| `aiEntitlement` | plan IA + features IA + budget tokens | `campus.model.js:212-245` |
| *(à créer)* flags modules | ce que ce campus peut utiliser | — |

Trois vocabulaires, trois UI, trois audits pour un seul concept métier : **ce à
quoi ce campus a droit**. La cible est un objet `entitlement` unique.

Points structurants, détaillés plus bas :

- **Trois états**, pas un booléen : `enabled` / `read_only` / `hidden` (§4.1).
- **Deux couches de contrôle** : l'ADMIN définit l'*offre*, le CAMPUS_MANAGER
  décide de l'*usage* à l'intérieur de cette offre (§5).
- **Fail-open**, contrairement à `buildCampusFilter()` / `notDeletedFilter()` —
  ce n'est pas une frontière de sécurité, c'est du packaging (§4.3).
- **Les bords sont le chantier** : crons, portail public, quotas. C'est la partie
  qu'on est tenté de reporter et qui produit les incidents visibles (§9).

Charge estimée : **~9,5 jours** répartis en 6 phases, dont 5 livrables seules.

---

## 1. Contexte — ce qui existe déjà

### 1.1 Le précédent IA (le patron à généraliser)

| Brique | Fichier | Rôle |
|---|---|---|
| Stockage per-campus | `modules/campus/campus.model.js:212-245` | `aiEntitlement { enabled, plan, features{}, monthlyTokenBudget, llmProfile }` |
| Audit append-only | `modules/campus/campus.model.js:249-263` | `aiEntitlementAudit[]`, `select: false` |
| Gate serveur | `modules/ai/ai.entitlement.middleware.js` | `requireAiFeature(f)` → 503 / 403 / 429 **distincts** |
| Registre gelé | `shared/constants/ai.constants.js` | `AI_PLANS`, `AI_FEATURES`, `AI_PLAN_PRESETS` |
| Pilotage ADMIN | `modules/admin/controllers/admin.ai-entitlement.controller.js` | PATCH + entrée d'audit |
| Accès données | `modules/campus/campus.repository.js:134-149` | `getCampusAiEntitlement` / `...WithAudit` / `set...` |
| UI de gestion | `frontend/src/admin/components/campuses/AiEntitlementDialog.jsx` | plan + features par campus |

La distinction de statuts du gate IA (503 « non déployé » ≠ 403 « non souscrit »
≠ 429 « budget épuisé ») est un acquis de conception : elle est reprise telle
quelle et étendue (§7.1).

### 1.2 Trois contraintes relevées à l'audit du code

1. **Aucun cache.** `getCampusAiEntitlement()` fait un aller-retour Mongo à
   chaque requête IA. Généraliser à 24 modules sans cache ajouterait une requête
   DB sur **chaque** appel API de la plateforme. → §7.2.
2. **9 contrôleurs de login** distincts (admin, campus, student, teacher, parent,
   mentor, staff, partner, + S2S). Injecter les flags dans la réponse de login
   imposerait de modifier 9 fichiers et 9 contrats. → endpoint dédié, §8.1.
3. **7 crons** (`server.js:135-141`) sans argument, balayant tous les campus. Ils
   ignorent par construction tout flag. → §9.1.

### 1.3 Surface frontend concernée

- **8 fichiers portail** déclarant la navigation (`Campus.jsx` 24 entrées,
  `Staff.jsx` 12, `Admin.jsx` 11, `Student.jsx` 9, `Teacher.jsx` 8, `Mentor.jsx`
  7, `Parent.jsx` 6, `Director.jsx` 3) — **~80 entrées `link:`** au total,
  consommées par `components/AppShell.jsx`.
- `routes/ProtectedRoute.jsx` (garde par rôle) — à composer avec une garde
  par feature, pas à remplacer.
- 12 fichiers `routes/*Routes.jsx` (accès direct par URL).

---

## 2. Décision d'architecture (ADR)

### 2.1 Problème

Un campus ne doit pas subir la surface fonctionnelle complète de la plateforme :
- soit parce qu'il **n'en a pas l'usage** (surcharge cognitive à l'onboarding) ;
- soit parce qu'il **n'y a pas droit** (palier commercial) ;
- soit parce que **l'usage doit être encadré** temporairement.

### 2.2 Décision retenue

> **Un objet `entitlement` unique par campus, source de vérité de tout ce à quoi
> ce campus a droit : plan, modules, quotas, spécificités IA.** Un registre gelé
> décrit les modules ; un middleware générique applique ; le frontend consomme
> sans dupliquer la moindre règle d'accès.

Le désencombrement de l'UI en est une **conséquence**, pas l'objectif.

### 2.3 Alternatives écartées

| Alternative | Verdict | Motif |
|---|---|---|
| **RBAC fin par rôle** | Écartée | Répond à « qui a le droit », pas à « ce campus a-t-il souscrit ». Complémentaire, non substituable, et bien plus coûteuse |
| **Flags par variables d'environnement** | Écartée | Non per-tenant, non pilotable par un manager. Contredit l'exigence d'indépendance entre campus |
| **Unleash / Flagsmith self-hosted** | Écartée pour v1 | Dépendance infra supplémentaire ; le pilotage doit vivre *dans* l'app pour le CAMPUS_MANAGER. À reconsidérer uniquement si rollout en % ou A/B devient un besoin |
| **Un 3ᵉ objet de config à côté de `features` et `aiEntitlement`** | Écartée | Coût d'unification faible aujourd'hui (l'IA est le seul consommateur, code connu) ; prohibitif dans 6 mois avec 3 systèmes en production |

### 2.4 Ce que la demande initiale sous-estimait

La formulation d'origine était un **outil de modération d'usage** (masquer des
boutons en cas d'usage inapproprié). Prise telle quelle elle est faible :

- masquer un bouton n'empêche pas l'appel API — sans gate serveur, c'est du
  théâtre de sécurité ;
- « usage inapproprié » se traite mieux par **quota / rate-limit** que par
  disparition (le mécanisme `monthlyTokenBudget` de l'IA en est le patron) ;
- une désactivation qui fait disparaître les données existantes génère **plus**
  de tickets qu'elle n'en évite → d'où l'état `read_only` (§4.1).

---

## 3. Modèle de données cible

```js
// Campus.entitlement — remplace `features` (quotas) ET `aiEntitlement`
entitlement: {
  plan: 'free' | 'standard' | 'premium' | 'custom',

  // Overrides campus. Le preset du plan fournit la base ; ce tableau ne
  // contient QUE les écarts au preset.
  modules: [
    {
      key:    'finance',                              // clé du registre (§6)
      state:  'enabled' | 'read_only' | 'hidden',
      until:  Date | null,     // fin d'effet ; null = permanent
      reason: String,          // affiché au manager, tracé à l'audit
      setBy:  'admin' | 'campus',   // quelle couche a posé l'override (§5)
      setAt:  Date,
      setById: ObjectId
    }
  ],

  quotas: {
    maxStudents, maxTeachers, maxClasses,
    maxDocumentStorageMB,          // repris de `features` à l'identique
    aiMonthlyTokens                // repris de aiEntitlement.monthlyTokenBudget
  },

  ai: { llmProfile: String }       // seul reliquat réellement spécifique à l'IA
}

// Renommage de aiEntitlementAudit — même forme, périmètre élargi.
entitlementAudit: [ { at, actorId, actorRole, changes } ]   // select: false
```

### 3.1 Pourquoi un tableau et non un `Map` Mongoose

Les clés de `Map` Mongoose **interdisent le point**. Or la nomenclature des
features est `domaine.action` (§6.2) pour permettre une granularité progressive
(`finance` en v1, `finance.expenses` plus tard) **sans migration de données**.
Un `Map` fermerait cette porte dès le premier jour.

Le coût du tableau est nul en pratique : ~30 entrées maximum, résolues **une
seule fois par requête** en objet plat par le resolver (§4.2), lui-même mis en
cache (§7.2).

### 3.2 Rétrocompatibilité

`features` et `aiEntitlement` sont **conservés dans le schéma** jusqu'à
validation en production de la migration (§10, phases 1.2 et 2). Le retrait est
une opération distincte, postérieure, et réversible jusque-là.

---

## 4. Sémantique

### 4.1 Les trois états

| État | Lecture | Écriture | Menu / boutons | Cas d'usage |
|---|---|---|---|---|
| `enabled` | ✅ | ✅ | visible | normal |
| `read_only` | ✅ | ❌ (403) | visible, actions masquées | **encadrer un usage**, geler un module sans amputer l'historique |
| `hidden` | ❌ (403) | ❌ (403) | invisible partout | module non souscrit / pas encore utile |

### 4.1.1 Le plancher `minState` — troisième catégorie (v1.2)

Le binaire core / librement-désactivable est insuffisant. Certains modules
portent des **archives institutionnelles** : ils ne sont pas indispensables au
fonctionnement (un campus peut légitimement n'en avoir aucun usage), mais dès
qu'ils contiennent des enregistrements, ces enregistrements ne peuvent plus
disparaître de l'interface.

> **Règle : `hidden` est permis tant que le module est vide ; dès qu'il porte des
> enregistrements, le plancher devient `read_only`.**

C'est la transposition exacte de la règle **« archive first »** du système de
suppression définitive (`CLAUDE.md` §5.2) : on n'empêche pas d'arrêter, on
empêche de faire disparaître.

**Autorité de référence — le registre de suppression définitive.**
`shared/lib/hard-delete/hard-delete.registry.js` déclare en `RELATION_MODE.BLOCK`
les collections qui interdisent une suppression permanente. Le raisonnement se
déduit : *un enregistrement qu'on ne peut pas supprimer est un enregistrement
qu'on ne peut pas non plus faire disparaître de l'interface* — sinon le masquage
obtient ce que la suppression refuse, et sans trace d'audit.

| Collection `BLOCK` | Module porteur | Conséquence |
|---|---|---|
| `Result`, `FinalTranscript` | `result` | `minState: 'read_only'` |
| `ExamGrading`, `ExamSession`, `QuestionBank` | `examination` | `minState: 'read_only'` |
| `FeePayment`, `Income` | `finance` | `minState: 'read_only'` |
| `Document` (live) | `document` | `minState: 'read_only'` |
| `StudentAttendance`, `TeacherAttendance` | `student` / `teacher` | déjà `core` |

Implémentation : le contrôle est un test d'existence (`countDocuments` borné à 1)
sur la collection pivot du module, exécuté **au moment du toggle uniquement** —
jamais dans le chemin de requête. Refus en `409` avec le décompte, comme pour les
dépendances (§6.3).

### 4.1.2 Ce que `hidden` ne casse jamais

Trois garanties survivent à toute désactivation, quelle que soit la catégorie du
module. Un flag est une décision de **packaging commercial** ; il n'a aucune
autorité sur une obligation légale.

1. **La piste d'audit** — masquer un module ne suspend jamais son journal
   append-only (`CLAUDE.md` §8). Sans cette garantie, la désactivation devient un
   moyen d'effacer une trace.
2. **L'export ADMIN** — RGPD art. 20 (portabilité) et réversibilité de contrat :
   les données d'un module masqué restent exportables par le rôle ADMIN.
3. **Les droits des personnes concernées** — une demande d'accès, de
   rectification ou d'effacement ne peut jamais être bloquée par un flag.

`read_only` est l'état **le plus utile des trois** et le grand absent de la
demande initiale : « ce campus n'utilise plus Finance » ne doit jamais signifier
« ce campus a perdu son historique financier ». Un `hidden` appliqué à un module
déjà utilisé est un incident client, pas une mesure de gestion.

**Critère de qualité côté utilisateur final** : un module `hidden` doit être
**indiscernable d'un module inexistant**. Pas de menu grisé, pas d'onglet vide,
pas de bouton mort, pas de 404.

### 4.2 Résolution — ordre de préséance

`resolveEntitlement(campus)` produit un objet plat en appliquant, dans l'ordre :

1. le **preset du plan** (base) ;
2. les **overrides `setBy: 'admin'`** (couche offre) ;
3. les **overrides `setBy: 'campus'`** (couche usage) — **ne peuvent que
   restreindre**, jamais élargir (§5) ;
4. **expiration de `until`** : si `until` est dépassée, l'override est ignoré et
   l'état retombe à la valeur de la couche inférieure ;
5. **forçage `core`** : un module marqué `core` dans le registre est ramené à
   `enabled` quoi qu'il arrive.

L'expiration est évaluée **à la lecture**. Pas de cron, pas de scheduler, pas
d'état à réconcilier : `until` est une donnée, jamais un job.

### 4.3 Fail-open — inversion assumée de la convention maison

`buildCampusFilter()` et `notDeletedFilter()` échouent **fermé** : ce sont des
frontières de sécurité, et un filtre vide y signifie une fuite de données.

**L'entitlement fait l'inverse : une clé inconnue ou absente signifie `enabled`.**
Motif : sans cela, le premier déploiement couperait tous les modules chez tous
les campus existants, et tout module ajouté au code avant son enregistrement au
registre serait invisible en production.

Cette inversion doit être **écrite noir sur blanc dans le code**, à l'endroit où
elle est appliquée, avec renvoi à ce paragraphe — sinon un relecteur la lira
comme un bug par analogie avec les deux helpers ci-dessus.

> ⚠️ Corollaire : l'entitlement **n'est pas** un contrôle de sécurité. Il ne
> remplace ni l'authentification, ni le contrôle de rôle, ni l'isolation campus.
> Un module `hidden` protège du bruit, pas d'un attaquant.

---

## 5. Modèle de contrôle — deux couches

| Couche | Acteur | Décide | Stockage |
|---|---|---|---|
| **Offre** | ADMIN | ce que le campus a le *droit* d'utiliser | `plan` + overrides `setBy: 'admin'` |
| **Usage** | CAMPUS_MANAGER | ce qu'il *active* dans son offre | overrides `setBy: 'campus'` |

Un manager ne peut jamais élargir son offre, uniquement restreindre à
l'intérieur. Une seule couche obligerait à choisir entre deux mauvaises options :
« le manager peut s'auto-attribuer des modules payants » ou « le manager ne peut
rien piloter ».

**Réactivation (D-E, tranchée)** : à l'intérieur de son offre, le
CAMPUS_MANAGER éteint **et rallume** librement, sans intervention de l'ADMIN.
C'est sa couche de décision, et il ne peut de toute façon jamais dépasser ce que
son plan autorise — un circuit de validation n'ajouterait aucune garantie et
ferait de l'ADMIN un goulot d'étranglement sur une opération sans enjeu.

### 5.1 Le noyau `core` — anti auto-verrouillage

Les modules marqués `core: true` au registre sont **non désactivables par
quiconque**. Liste proposée sur base quantitative — nombre de modules qui en
dépendent réellement, mesuré sur le code (§6.3) :

| Module | Motif |
|---|---|
| `account` | authentification et activation de compte |
| `settings` | contient l'écran de pilotage lui-même |
| `campus` | racine du multi-tenant |
| `admin` | administration de la plateforme — le pilotage de l'entitlement lui-même |
| `notification` | socle d'envoi de tous les autres modules |
| `student` | **7 modules en dépendent** (teacher, result, document, gaet, mentor, staff, parent) |
| `teacher` | **6 modules en dépendent** (student, class, document, gaet, staff, department) |
| `class` | **5 modules en dépendent** (student, subject, result, document, gaet) |

`student`, `teacher` et `class` ne sont pas « core » par principe mais par
constat : les couper reviendrait à casser la moitié de la plateforme, et un ERP
académique sans étudiants, enseignants ni classes n'a pas de sens commercial.
Les déclarer `core` évite de gérer une cascade de refus 409 pour un cas qui
n'arrivera jamais légitimement.

**Écartés du noyau, malgré une candidature défendable :**

| Module | Motif du maintien hors noyau |
|---|---|
| `level` | Référencé par `Class` (`class.model.js:21`) et bloquant à la suppression, mais c'est un module de **configuration** : une fois les niveaux créés, masquer l'écran ne casse rien. Ranger la config après paramétrage est un cas d'usage légitime |
| `staff` | Le plus intriqué en dépendances **sortantes** (8), mais **aucun module ne dépend de lui** — consommateur terminal. Un petit campus sans gestion de personnel est un cas réel |
| `result` | Tentant (un ERP académique sans notes n'en est pas un), mais un campus en pré-ouverture n'a légitimement aucune note. Couvert par le plancher `read_only` (§4.1.1) sans interdire ce cas |

> **D-B — seule décision encore ouverte.** Liste `core` initiale validée le
> 2026-08-13 ; l'ajout de `teacher` et `admin` ainsi que la catégorie
> `minState` (§4.1.1) restent à valider avant l'ouverture de la phase 1.

Sans ce garde-fou, un CAMPUS_MANAGER peut se couper l'accès à ses propres
réglages — c'est-à-dire au seul écran qui contient le bouton pour rallumer. Le
rattrapage est alors une intervention manuelle en base, à chaque occurrence.

**La liste `core` se gèle en phase 0 et ne se discute plus ensuite.**

### 5.2 Rôles globaux (ADMIN / DIRECTOR)

Ils ne sont bornés par aucun entitlement. En navigation dans un contexte campus
(`?campusId=`), les modules non actifs pour ce campus s'affichent avec un badge
explicite « désactivé pour ce campus » plutôt que de disparaître : c'est le
comportement déjà retenu pour `AiWorkspace` avec son sélecteur de campus.

---

## 6. Le registre de features

### 6.1 Emplacement et forme

`shared/constants/features.constants.js` — même statut que
`shared/constants/ai.constants.js` : `Object.freeze({})`, source de vérité
unique, miroir côté frontend (jamais de littéral dupliqué).

```js
FEATURE_REGISTRY = Object.freeze({
  finance: {
    label:      'Finance',
    core:       false,
    dependsOn:  ['student'],
    requiredBy: [],
    routers:    ['/api/finance'],
    minPlan:    'standard',
    crons:      ['finance-overdue'],
  },
  subject: {
    label:      'Subjects',
    core:       false,
    dependsOn:  [],
    requiredBy: ['result', 'examination', 'gaet', 'course'],
    routers:    ['/api/subject'],
    minPlan:    'free',
    crons:      [],
  },
  settings: { label: 'Settings', core: true },   // jamais désactivable
  // …
});
```

### 6.2 Nomenclature

`domaine` en v1, `domaine.action` réservé pour la granularité fine ultérieure
(`finance.expenses`). **Ne pas tenter de flagger chaque bouton en v1** : les
boutons sont dispersés dans des centaines de composants, alors que la navigation
tient en ~80 déclarations. La granularité « module = page » couvre le besoin
réel ; le namespace pointé garantit qu'on pourra descendre plus bas sans
retoucher les données.

### 6.3 Graphe de dépendances — le vrai piège

Désactiver `subject` casse `result`, `gaet` et `course`. L'utilisateur ne verra
pas « subject est désactivé » : il verra des 403 incompréhensibles dans Résultats.

**Un toggle qui casserait un consommateur actif doit être refusé (409) avec le
détail des modules bloquants**, pas accepté silencieusement. C'est la seule
manière de garder le système diagnostiquable.

### 6.3.1 Deux natures d'arête — correction de la phase 0

La première version de ce document dérivait le graphe des `require()`
inter-modules. **La validation du registre en phase 0 a montré que c'était
faux** : ce graphe mélange deux relations de nature différente, ce qui produisait
4 cycles et 8 incohérences de palier (un module `free` « dépendant » d'un module
`standard`).

| Nature | Définition | Effet sur un toggle |
|---|---|---|
| **HARD** (`dependsOn`) | le module référence l'entité de l'autre par une **clé étrangère `required`** — ses propres lignes ne peuvent pas exister sans | candidat au **409** |
| **SOFT** (`usesWhenAvailable`) | appel de façade qui enrichit un tableau de bord ou un panneau latéral, et se dégrade proprement | **jamais** de refus ; alimente l'aperçu d'impact |

Exemples tranchés à l'inspection du code :
`campus → finance` est un agrégat de tableau de bord (SOFT) ·
`student → exam` sert le dashboard étudiant (SOFT) ·
`document → ai` appelle `signalDocumentIngest`, et le module `ai` est inerte
sans `AI_SERVICE_URL` — donc SOFT par construction ·
`result → student` est une clé étrangère `required` (HARD).

Cette séparation **supprime les 4 cycles** (`document ↔ academic-print`,
`document ↔ ai`, `subject ↔ course`, `public-portal ↔ ai`) et rend le graphe
HARD acyclique. Elle supprime aussi les 8 incohérences de palier : toutes
portaient sur des arêtes SOFT.

### 6.3.2 Graphe HARD — dérivé des modèles le 2026-08-13

Obtenu en extrayant les `ref` portant `required: true` de l'ensemble des
`*.model.js`. C'est ce graphe qui est gelé au registre.

| Module | Dépend de (HARD) |
|---|---|
| `result` · `exam` | campus · class · student · subject · teacher |
| `gaet` | campus · class · subject · teacher |
| `student` | campus · class · subject · teacher |
| `teacher` | campus · class · department · subject |
| `class` | campus · level |
| `course` | level · teacher |
| `finance` | campus · student |
| `subject` · `department` · `parent` · `document` · `announcement` · `academic-print` · `mentor` · `staff` · `public-portal` · `partner` | campus |
| `level` · `ai` · `account` · `settings` · `campus` · `admin` · `notification` · `danger-zone` | *(aucune)* |

Modules non-core les plus référencés : **`subject` (5 dépendants HARD, dont 2
core)** puis `teacher` (5). Ce sont eux qui déclencheront le plus de refus.

### 6.3.3 Le refus est piloté par la donnée, pas par la déclaration

Une arête HARD ne refuse pas un toggle à elle seule. Le refus reprend le
mécanisme exact du registre de suppression définitive : on **compte les lignes**
qui référencent réellement l'entité, et on ne refuse que s'il y en a.

Concrètement : masquer `subject` est **légal** sur un campus sans emploi du temps
ni résultat, et **refusé** sur un campus qui en a. Sans cette règle, `subject`,
`level` et `department` deviendraient indésactivables par simple fermeture
transitive du noyau — un bouton qui ne peut jamais être actionné.

Les filtres par arête sont écrits en phase 1, à côté du resolver, sur le modèle
de `block(model, label, filter)` du registre de suppression.

---

## 7. Gate serveur

### 7.1 Middleware

`shared/middleware/entitlement.js` :

```js
requireFeature('finance')   // posé sur le routeur, app.js:220-243
```

| Situation | Réponse |
|---|---|
| `enabled` | passe |
| `read_only` **et** méthode ≠ GET | `403 { code: 'FEATURE_READ_ONLY' }` |
| `read_only` **et** GET | passe |
| `hidden` | `403 { code: 'FEATURE_DISABLED' }` |
| clé inconnue / absente | passe (fail-open, §4.3) |

Codes d'erreur dédiés obligatoires : un `403` générique est indistinguable d'un
refus de rôle côté frontend, ce qui rend impossible le traitement propre de
l'écriture en vol (§8.3).

Montage : **une ligne par routeur** dans `app.js:220-243`. Aucun contrôleur ne
connaît le système.

### 7.2 Cache — non optionnel

Sans cache, chaque requête API de la plateforme gagne un aller-retour Mongo
(§1.2). Conception retenue :

- `Map<campusId, { resolved, expiresAt }>` in-process, **TTL 60 s** ;
- purge explicite de l'entrée sur PATCH (`bumpEntitlement(campusId)`) ;
- **limite assumée** : en multi-process, la purge est locale au process qui a
  traité le PATCH. La fenêtre d'incohérence est donc bornée par le TTL (≤ 60 s).
  À documenter dans le code, pas à masquer. Un invalidateur distribué (Redis
  pub/sub) est disponible si besoin ultérieur, mais hors périmètre v1.

---

## 8. Surface frontend

### 8.1 Hydratation

Un endpoint dédié, `GET /api/settings/entitlement`, renvoyant les flags
**effectifs** de l'utilisateur courant (rôle global → `?campusId=`), appelé une
fois après login par un `EntitlementProvider`.

Motif : modifier la réponse des **9 contrôleurs de login** (§1.2) multiplierait
par 9 la surface de changement et les contrats à maintenir, pour un gain nul.

### 8.2 Consommation

| Livrable | Rôle |
|---|---|
| `services/entitlementService.js` | appel API — **aucune règle d'accès dupliquée** |
| `EntitlementProvider` + `useFeature(key)` | contexte React, refetch sur `FEATURE_DISABLED` |
| `<FeatureGate feature="finance">` | masque section/bouton ; `mode="write"` pour le cas `read_only` |
| Filtrage nav | les 8 fichiers portail, ~80 entrées `link:` |
| `FeatureGuard` | **composé** avec `ProtectedRoute` (pas substitué) : accès direct par URL → écran « module non activé », jamais un 404 |

### 8.3 L'écriture en vol

Un utilisateur a la page Finance ouverte au moment du toggle : son POST part et
prend un 403. Sans traitement, cela ressemble à un bug.

Intercepteur axios global : sur `FEATURE_DISABLED` / `FEATURE_READ_ONLY` →
message explicite + re-hydratation des flags + rafraîchissement de la navigation.

---

## 9. Les bords — partie non négociable

C'est la portion qu'on est tenté de reporter, et c'est celle qui produit les
incidents **visibles par le client final**.

### 9.1 Les 7 crons

**Point d'ancrage (corrigé le 2026-08-14)** : les enregistrements ne sont plus
dans `server.js` mais dans `shared/lib/register-jobs.js`, via `projectJobs()`.
C'est favorable à ce chantier — les 7 jobs sont déclarés au même endroit avec un
**nom canonique**, ce qui donne un point d'accroche unique pour le filtre
d'entitlement au lieu de sept sites d'appel.

Chacun balaye tous les campus sans aucun filtre. Concrètement : désactiver
Finance pour un campus **n'empêche pas** le job de 06:00 de lui envoyer des
relances d'impayés — c'est-à-dire des **emails sortants au nom d'un module
officiellement coupé**.

**Mais la règle « module coupé → cron coupé » est fausse, et dangereusement pour
deux d'entre eux.** La bonne formulation :

> **On coupe l'émission, jamais l'hygiène.**

- **Émission** — le job produit quelque chose vers l'extérieur (email, notification,
  document, changement d'état visible). Un module coupé ne doit rien émettre.
- **Hygiène** — le job purge, expire, draine ou clôture. Il doit tourner **quoi
  qu'il arrive** : ces jobs répondent à des obligations légales ou empêchent des
  états bloqués, et rien de ce qu'ils font n'est visible d'un utilisateur.

Noms canoniques repris verbatim de `projectJobs()` :

| Job | Module | Nature | Comportement si module non actif |
|---|---|---|---|
| `document-retention` (dim 02:00) | `document` | **Hygiène** | ⚠️ **CONTINUE.** Arrêter la purge = conserver des données au-delà de la durée légale → violation RGPD silencieuse |
| `print-queue-sweep` (/2 min) | `academic-print` | **Hygiène** | ⚠️ **CONTINUE** jusqu'à drainage des jobs en cours, sinon ils restent bloqués indéfiniment |
| `announcement-expiry` (01:00) | `announcement` | Hygiène | CONTINUE (une annonce non expirée reste « live » à jamais) |
| `competition-closing` (1ᵉʳ du mois 00:05) | `public-portal` | Hygiène + émission | Clôture l'état, **n'émet plus** |
| `exam-anticheat` (03:00) | `exam` | Émission | S'ARRÊTE |
| `finance-overdue` (06:00) | `finance` | Émission | **S'ARRÊTE** — c'est le cas d'école : des emails de relance au nom d'un module officiellement coupé |
| `notification-retry` (/10 min) | `notification` | Socle | Ne s'arrête jamais (**core**) |

Chaque entrée de registre déclare donc `crons: [{ name, nature }]`, et non une
simple liste de noms. `tests/unit/feature-registry.test.js` compare cette
déclaration à `projectJobs()` **par nom, pas par comptage** : un job ajouté ou
renommé sans mise à jour du registre fait échouer la suite.

### 9.2 Portail public

`/api` (public-portal) n'est pas authentifié : pas de `campusId` dans un JWT. Le
campus se résout depuis le slug ou le paramètre de route, jamais depuis
`req.user`.

### 9.3 Quotas

`maxStudents` / `maxTeachers` / `maxClasses` / `maxDocumentStorageMB` lus depuis
`entitlement.quotas`. Ancien `features` retiré après validation.

### 9.4 Notifications

Aucune émission (in-app ou email) pour un module non actif sur le campus
destinataire.

---

## 10. Plan de travail

### Phase 0 — Cadrage & gel du registre · 0,5 j

**Livrable** : `shared/constants/features.constants.js` complet.

**Point de décision bloquant, à valider par le porteur avant toute ligne de
code** : la liste `core` (§5.1) et le graphe `dependsOn` / `requiredBy` (§6.3).
Une heure de validation qui évite de refaire la phase 1.

---

### Phase 1 — Socle backend · 2,5 j

| # | Livrable |
|---|---|
| 1.1 | Schéma `entitlement` + `entitlementAudit` — **ajout** à côté de l'existant, sans suppression |
| 1.2 | `scripts/migrate-entitlement.js` — replie `features` + `aiEntitlement`, **tous modules à `enabled`**. Idempotent, `--dry-run` |
| 1.3 | `shared/utils/entitlement.js` — `resolveEntitlement(campus)` (§4.2), `isFeatureActive(resolved, key, { write })` |
| 1.4 | Cache in-process + invalidation (§7.2) |
| 1.5 | `shared/middleware/entitlement.js` — `requireFeature(key)` (§7.1) |
| 1.6 | Montage : une ligne par routeur, `app.js:220-243` |
| 1.7 | `GET /api/settings/entitlement` (§8.1) |
| 1.8 | `PATCH /api/admin/campuses/:id/entitlement` — généralisation de `admin.ai-entitlement.controller.js`, + audit, + **refus 409** sur dépendance cassée |
| 1.9 | `PATCH /api/campus/:id/entitlement` — couche usage, bornée par l'offre (§5) |

**Tests livrés dans la phase, pas après** (§11).

---

### Phase 2 — Absorption de l'IA · 1 j

L'IA devient un module comme les autres **pour l'activation**, et garde sa
logique propre là où elle est réellement différente : comptage de tokens, profil
LLM, JWT S2S.

- `ai.entitlement.middleware.js` lit `entitlement` unifié ;
  `requireAiFeature('chat')` = composition de `requireFeature('ai.chat')` + le
  contrôle de budget existant.
- `AI_PLANS` / `AI_FEATURES` conservés comme **alias** vers le registre : zéro
  rupture du contrat frontend IA.
- `aiEntitlement` retiré **après** validation de la migration en production.

**Critère d'acceptation : la suite de tests IA existante passe sans
modification.** Si un test casse, c'est la généralisation qui a changé un
contrat — on corrige le code, on ne retouche pas le test.

---

### Phase 3 — Front, consommation · 2 j

Livrables du §8.2 et §8.3.

---

### Phase 4 — Pilotage (UI) · 2 j

- **Admin** : `AiEntitlementDialog.jsx` → `EntitlementDialog.jsx`. Plan + matrice
  des modules, badge « inclus au plan / override », historique d'audit (déjà
  affiché aujourd'hui pour l'IA).
- **Campus manager** : nouvel onglet dans `CampusSettings` — modules de son
  offre, 3 états, sélecteur de date `until`, **motif obligatoire** sur toute
  désactivation.
- **Vue parc (admin)** : matrice campus × modules.
- i18n des libellés du registre (10 locales).

---

### Phase 5 — Les bords · 1,5 j · **non négociable**

Livrables du §9 : 7 crons, portail public, quotas, notifications.

---

### Récapitulatif

| Phase | Charge | Livrable seule ? |
|---|---|---|
| 0 — Registre | 0,5 j | — |
| 1 — Socle backend | 2,5 j | ✅ API protégée, pilotage par API |
| 2 — Absorption IA | 1 j | ✅ |
| 3 — Front | 2 j | ✅ UI cohérente |
| 4 — Pilotage UI | 2 j | ✅ autonomie du manager |
| 5 — Bords | 1,5 j | ❌ **doit sortir avec 1-4** |
| **Total** | **~9,5 j** | |

> **Règle ferme : ne jamais livrer les phases 1-3 sans la phase 5.** Un système
> de flags que les crons ignorent envoie des emails au nom d'un module coupé —
> le pire des deux mondes.

---

## 11. Stratégie de test

| Test | Ce qu'il épingle |
|---|---|
| `tests/unit/feature-registry.test.js` | **Compare les routeurs montés dans `app.js` au registre ; échoue si un module n'est pas déclaré.** Garde-fou anti-dérive — même rôle que `tests/unit/soft-delete.test.js` vis-à-vis des conventions de suppression |
| `tests/unit/entitlement-resolve.test.js` | préséance des couches, expiration `until`, forçage `core`, fail-open sur clé inconnue |
| `tests/unit/entitlement-deps.test.js` | couper `subject` alors que `result` est actif → 409 |
| `tests/integration/entitlement.test.js` | `hidden` → 403 sur GET ; `read_only` → 200 GET / 403 POST ; couche campus ne peut pas élargir l'offre |
| Suite IA existante | inchangée — critère d'acceptation de la phase 2 |

---

## 12. Risques & mitigations

| Risque | Gravité | Mitigation |
|---|---|---|
| **Implémentation à moitié** (front seul) | 🔴 Élevée | Phase 1 **avant** phase 3. Un flag front-only est *pire* que rien : faux sentiment de contrôle |
| **Bords oubliés** → emails fantômes | 🟠 Moyenne | Phase 5 dans la même livraison, jamais reportée |
| **Support « le bouton a disparu »** | 🟠 Moyenne | Motif obligatoire + audit + écran admin « pourquoi ce module est-il masqué ? » |
| **Taxe de maintenance permanente** | 🟡 Faible | Test registre-vs-`app.js` : un module non déclaré fait échouer la CI |
| **État invisible au debug** | 🟡 Faible | Entitlement effectif exposé dans `/api/health` en environnement de dev |
| **Incohérence de cache multi-process** | 🟡 Faible | Bornée à 60 s par le TTL, documentée (§7.2) |

---

## 13. Usage final attendu

### 13.1 Ce que chaque rôle voit

| Rôle | Expérience |
|---|---|
| **ADMIN** | Matrice de tout le parc. Vend un plan, ouvre/ferme un module par campus, voit qui a quoi et depuis quand |
| **CAMPUS_MANAGER** | Onglet « Modules » dans ses réglages : son offre, et ce qu'il choisit d'allumer dedans |
| **Utilisateur final** (prof, étudiant, parent, staff) | **Ne voit rien du système.** Il voit une plateforme plus simple |

### 13.2 Parcours de référence — campus de Douala

**Acte 1 — La vente (ADMIN, J0).** Le campus ouvre. L'admin le crée, choisit le
plan **Standard** : 18 modules ouverts, GAET / IA / Partenaires réservés au
Premium. Motif consigné : « ouverture Douala — upsell GAET à revoir en janvier ».

**Acte 2 — L'onboarding (CAMPUS_MANAGER, J1).** Réglages → Modules : 18 cartes,
3 états chacune. 60 étudiants, pas de comptabilité formalisée. Il masque
Finance, Examens, Impression, Documents, Mentors, Annonces, Partenaires.
**Son menu passe de 24 entrées à 11.** C'est là que se gagne ou se perd
l'adoption.

**Acte 3 — Le quotidien (un enseignant, J2).** 5 entrées de menu. Il ne saura
jamais que le module Examens existe. Aucun bouton mort, aucun onglet vide,
aucune erreur. La plateforme *paraît* faite pour son campus.

**Acte 4 — Le pilote encadré (CAMPUS_MANAGER, M+3).** Il veut tester Finance un
trimestre sans engagement. Il active Finance, « jusqu'au 31/03/2027 », motif
« pilote scolarités T2 ». Le 1ᵉʳ avril, `until` est dépassée : le module retombe
à son état de base. Sans cron, sans intervention (§4.2).

**Acte 5 — Le gel, pas la coupure (CAMPUS_MANAGER, M+5).** Le secrétariat crée
des annonces en boucle et sature les parents. Il passe **Annonces en
`read_only` pour 30 jours**, motif « usage à cadrer avec le secrétariat ».
Résultat : les annonces existantes restent consultables, l'historique est intact,
le bouton « Nouvelle annonce » a disparu, l'API refuse tout POST, et le cron
d'expiration continue de tourner. Retour automatique au bout de 30 jours.

> C'est le scénario « usage inapproprié » de la demande d'origine. Un `hidden`
> aurait ici fait disparaître l'historique aux yeux des parents.

**Acte 6 — L'upsell (ADMIN, M+6).** Douala atteint 400 étudiants et demande la
génération d'emploi du temps. L'admin bascule le campus en **Premium** : GAET, IA
et Partenaires entrent dans l'offre. Le manager active GAET immédiatement, l'IA
plus tard.

> **Cet acte 6 est le retour sur investissement du chantier.** Sans ce système,
> l'upsell n'est pas techniquement représentable : tous les campus ont tout, il
> n'y a rien à vendre.

---

## 14. Décisions ouvertes

| # | Décision | Statut |
|---|---|---|
| **D-A** | Une tarification par palier est-elle à l'horizon ? | ✅ **OUI** (2026-08-13) — version complète retenue, variante courte §16.2 écartée |
| **D-B** | Liste définitive des modules `core` et plancher `minState` | ✅ **CLOSE** (2026-08-14) — noyau à 8 modules validé + `danger-zone` comme 9ᵉ entrée de gouvernance ; plancher `read_only` retenu sur `result` · `finance` · `exam` · `document` |
| **D-C** | Graphe `dependsOn` / `requiredBy` | ✅ **Dérivé du code** (2026-08-13) — tableau au §6.3, à re-vérifier au gel du registre |
| **D-D** | Composition des presets `free` / `standard` / `premium` | ✅ **Alignée sur la grille IA** (0 / 99 / 299 €, `PHASE3_AI_DESIGN.md` §15/D10) — une seule grille commerciale, un seul discours de vente |
| **D-E** | Le CAMPUS_MANAGER peut-il rallumer seul un module qu'il a masqué ? | ✅ **OUI, sans l'ADMIN** — §5 |
| **D-F** | Durée maximale de `until` | ✅ **12 mois** — au-delà, l'opérateur doit choisir « permanent » explicitement (§4.1) |

### 14.1 Conséquences de D-D sur les presets

La grille modules épouse la grille IA déjà en production. Répartition de départ
(modifiable en base sans redéploiement) :

Répartition arrêtée le 2026-08-14, gelée au registre (`minPlan` par entrée) :

| Palier | Modules ajoutés | Total |
|---|---|---|
| `free` (0 €) | noyau `core` (9) + level · subject · course · department · parent · result | **15** |
| `standard` (99 €) | + finance · exam · document · announcement · academic-print · mentor · staff | **22** |
| `premium` (299 €) | + public-portal · gaet · partner · ai | **26** |

`gaet` et `ai` en premium sont cohérents avec l'acte 6 du parcours de référence
(§13.2) : les deux leviers d'upsell identifiés. **`public-portal` les rejoint**
(décision du 2026-08-14) — le portail public est un outil d'acquisition,
fonctionnellement lié à `partner` (liens de parrainage, tunnel de prospects),
donc vendu avec lui plutôt qu'en équipement de base.

Le registre vérifie qu'aucun module ne dépend structurellement d'un palier
supérieur au sien : un module inclus dans une offre où ses prérequis manquent
serait vendu inutilisable.

---

## 15. Definition of Done

- [ ] Tout module monté dans `app.js` est déclaré au registre (test CI vert)
- [ ] Aucune règle d'accès dupliquée côté frontend
- [ ] Les 7 crons filtrent sur l'entitlement
- [ ] Un module `hidden` est indiscernable d'un module inexistant pour un
      utilisateur final (vérifié sur les 8 portails)
- [ ] Un module `read_only` conserve tout son historique consultable
- [ ] Un module portant des enregistrements ne peut pas passer `hidden` (§4.1.1)
- [ ] Les crons d'hygiène tournent même module coupé ; les crons d'émission se
      taisent (§9.1)
- [ ] Audit, export ADMIN et droits des personnes concernées survivent à
      `hidden` (§4.1.2)
- [ ] Aucun appel Mongoose introduit hors `campus.repository.js` ; le resolver
      ne reçoit que des données brutes (§15bis.3)
- [ ] Un CAMPUS_MANAGER ne peut ni élargir son offre, ni se verrouiller
- [ ] Toute mutation d'entitlement est tracée avec acteur, motif et horodatage
- [ ] La suite de tests IA existante passe sans modification
- [ ] `features` et `aiEntitlement` retirés du schéma après validation prod
- [ ] i18n des libellés dans les 10 locales

---

## 15bis. Articulation avec la migration PostgreSQL

Question posée le 2026-08-13 : *faut-il migrer vers PostgreSQL avant d'ouvrir ce
chantier ?* **Non** — et le dossier `POSTGRES_MIGRATION_ASSESSMENT.md` contient
déjà la réponse.

### 15bis.1 Le prérequis est levé

Ce document identifiait au §3 un blocage unique : *la persistance n'est pas
encapsulée* — 527 appels Mongoose dans les controllers. La décision utilisateur
du 2026-06-13 (§7) était : **faire l'étape 0 (couche repository), différer
Postgres.** L'étape 0 est **terminée** (vagues R1, R2, R3, cœur académique
inclus).

Vérification empirique du 2026-08-13 :

| Mesure | 2026-06-13 | 2026-08-13 |
|---|---|---|
| Appels Mongoose dans `modules/*/controllers/` | 527 | ~0 |
| Controllers important un modèle | 64 | 16 — **enums uniquement** (`RESULT_STATUS`, `SEMESTER`…) ou exceptions documentées (`GenericBulkController`, `profile.service`) |

### 15bis.2 La condition de déclenchement n'est pas remplie

Critère posé au §6 du dossier Postgres : *« différer tant qu'il n'y a pas de
contrainte réelle (échelle, coût, besoin transactionnel/relationnel) qui le
justifie. Migrer une base qui marche est un risque qu'on ne prend que pour une
raison concrète. »*

Aucun de ces signaux n'est constaté, et **5 des 6 décisions du §6 restent
ouvertes** (ORM, hébergement, format des ids, mapping de l'embarqué, calendrier).
La migration ne peut donc pas démarrer sans un tour de décisions préalable.

**Signaux à surveiller** — leur apparition rouvre le dossier :
coût d'exploitation Mongo devenu matériel · besoin de reporting transverse
exigeant de vraies jointures · besoin transactionnel dépassant les sessions Mongo
· volume de campus ou de données · exigence client/réglementaire (résidence des
données, déploiement on-premise imposant Postgres).

> L'entitlement **fabrique** ce déclencheur plutôt qu'il ne le contourne : paliers
> tarifaires → plus de campus → volume et besoin de reporting. Note également que
> PostgreSQL est **déjà exploité** par `ai-service` (pgvector) : l'outil est connu
> et opéré, ce qui abaisse le risque d'une future migration sans créer d'urgence.

### 15bis.3 Trois garde-fous — conception à l'épreuve de la migration

Contraintes de conception à respecter en phase 1, pour que ce chantier ne
produise aucune dette à repayer le jour de la bascule :

1. **`entitlement` est un candidat JSONB par excellence** — structure
   dénormalisée, lue souvent, écrite rarement, autonome : exactement le cas rangé
   en JSONB au §5 du dossier Postgres. Aucune complexité relationnelle ajoutée.
2. **Le resolver ne reçoit jamais un document Mongoose**, uniquement des données
   brutes : `resolveEntitlement(entitlementData)`. Le jour de la bascule, seul
   `campus.repository.js` change — resolver, middleware et 24 routeurs ne bougent
   pas.
3. **Zéro appel Mongoose hors repository.** Le chantier qui vient de s'achever ne
   doit pas être entamé par celui-ci ; le test de couverture (§11) le vérifie.

---

## 16. Périmètre

### 16.1 Hors périmètre v1 (assumé)

Granularité par bouton individuel · rollout en pourcentage · A/B testing ·
achat self-service par le campus · invalidation de cache distribuée.

### 16.2 Variante courte — si D-A est « non »

Si le modèle économique reste « un prix, tout inclus » de façon durable, 9,5
jours pour du confort d'affichage est disproportionné. Variante honnête, **~2
jours** :

- un simple `Campus.hiddenModules: [String]` ;
- filtrage de la navigation sur les 8 portails ;
- un écran de réglage pour le CAMPUS_MANAGER ;
- **aucun** gate serveur, **aucun** état `read_only`, **aucune** couche offre.

Assumée comme **purement cosmétique**, sans prétention de contrôle d'accès — et
documentée comme telle, pour que personne ne s'appuie dessus plus tard en
croyant à une barrière.

---

## 17. Journal d'avancement

| Date | Événement |
|---|---|
| 2026-08-13 | Analyse comparative des 4 alternatives (§2.3) ; conception rédigée (v1) |
| 2026-08-13 | **D-A tranchée : OUI** → version complète (~9,5 j) retenue, variante courte écartée. D-D (grille IA), D-E (manager autonome), D-F (12 mois) tranchées. D-C dérivée du code (§6.3). Liste `core` proposée (§5.1) — **D-B seule décision restante** (v1.1) |
| 2026-08-13 | **v1.2 — revue « ERP international ».** Correction : `teacher` (6 dépendants) manquait au noyau alors que `class` (5) y figurait. Ajout de `admin`. **Nouvelle catégorie `minState: 'read_only'`** (§4.1.1), fondée sur le registre de suppression définitive. **Correction du §9.1** : distinction émission / hygiène — la rétention documentaire et le drainage d'impression doivent tourner même module coupé. Ajout des 3 garanties intangibles (§4.1.2) |
| 2026-08-13 | **v1.3** — question de séquencement vs migration PostgreSQL instruite : §15bis ajouté. Prérequis (couche repository) vérifié comme levé (527 → ~0 appels Mongoose en controllers) ; condition de déclenchement Postgres non remplie ; 3 garde-fous de conception ajoutés pour une bascule ultérieure sans dette |
| 2026-08-13 | **PHASE 0 LIVRÉE** — `shared/constants/features.constants.js` (26 entrées : 8 modules core + `danger-zone`, 4 à plancher, 13 libres). D-B validée par le porteur. Validation structurelle passée. **Trois défauts trouvés et corrigés au gel** : (1) 4 cycles de dépendance entre modules non-core, (2) 8 incohérences de palier, tous deux causés par la confusion arêtes HARD/SOFT → `dependsOn` re-dérivé des clés étrangères `required` des modèles et `usesWhenAvailable` créé (§6.3.1-2) ; (3) refus de toggle rendu **piloté par la donnée** et non par la déclaration (§6.3.3), sans quoi `subject`/`level`/`department` devenaient indésactivables par fermeture transitive |
| 2026-08-14 | **PHASE 0 CLOSE.** D-B tranchée (noyau 8 + `danger-zone`, plancher sur 4). `public-portal` déplacé en `premium` → paliers **15 / 22 / 26**. `tests/unit/feature-registry.test.js` livré : **25 tests verts**, lint 0, suites voisines (hard-delete, soft-delete, register-jobs) 228 tests toujours verts. Registre gelé. **Réalignement** : les crons ont migré de `server.js` vers `shared/lib/register-jobs.js` (`projectJobs()`) pendant le chantier — §9.1 corrigé, noms canoniques repris, un seul nom divergeait (`exam-anticheat`) |
| — | ***Prochaine étape : PHASE 1** — socle backend (§10). Aucune décision porteur en attente ; la seule action qui t'appartient est le lancement de `scripts/migrate-entitlement.js` sur la base réelle, en fin de phase.* |

*(Tenir cette section à jour à chaque phase close — c'est le point d'entrée d'une
reprise du chantier par un tiers.)*
