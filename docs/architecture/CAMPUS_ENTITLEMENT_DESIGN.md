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
> **Statut** : **TOUTES LES PHASES LIVRÉES (0 → 5)**. Registre gelé, socle
> backend, absorption de l'IA, consommation frontend, pilotage UI et les bords.
> Toutes les décisions porteur sont tranchées (§14). L'API est protégée, l'IA est
> un module de la grille, l'interface consomme les états sans dupliquer la
> moindre règle, **rien n'émet plus au nom d'un module coupé** (crons, portail
> public, quotas, notifications), et les deux couches de décision — l'offre
> ADMIN et l'usage CAMPUS_MANAGER — se pilotent depuis l'interface.
>
> Reste **hors code** : lancer `scripts/migrate-entitlement.js` sur la base
> réelle (§10, phase 1.2), puis la **QA visuelle** sur un campus migré, qui est
> le seul contrôle capable de fermer les deux derniers points de la DoD (§15).
> Le retrait de `features` / `aiEntitlement` du schéma (§3.2) vient après cette
> validation, pas avant.
>
> **Révisions** : **v1.8 (2026-08-20)** — phase 4 livrée, chantier clos ;
> §8.5 (nouveau — ce que la phase 4 a tranché), §10 phase 4, §11 et §15 mis à
> jour d'après le code écrit ; §13.1 précisé (la vue parc existe). **v1.7 (2026-08-20)** — phase 5 livrée ; §9.1 (nouveau bloc
> « ce que la phase 5 a tranché »), §9.2, §9.3, §9.4 réécrits d'après le code
> écrit ; §10 phase 5, §11 et §15 mis à jour. **v1.6 (2026-08-20)** — phase 3
> livrée ; §8.2 (surface réelle livrée), §8.4 (nouveau — ce que la phase 3 a
> tranché) et §10 phase 3 mis à jour d'après le code écrit. **v1.5 (2026-08-20)** — phase 2 livrée ; §3 (`entitlement.ai.features`),
> §3.2 (repli legacy au premier write), §10 phase 2 et §17 mis à jour d'après le
> code écrit. **v1.4 (2026-08-15)** — phase 1 livrée ; §7.1 (montage dérivé
> du registre + `optionalAuth`), §6.3.3 (arêtes globales exclues, `level`
> tranché), §4.1.1 (contrôle porté sur la transition effective, donc aussi sur
> un déclassement de palier) et §15bis.3 (dérogation Mongoose assumée) corrigés
> d'après le code écrit. v1 (2026-08-13) — conception initiale, issue de l'analyse
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

  // Seuls reliquats réellement spécifiques à l'IA (phase 2). `features` ne porte
  // que les ÉCARTS au preset du palier — un campus conforme à son palier n'y
  // stocke rien et suit la grille quand le palier change.
  ai: {
    llmProfile: String,
    features:   { chat, search, analytics, advisors }   // booléens, écarts seuls
  }
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

**Un campus est soit migré, soit pas — jamais moitié-moitié** (tranché en
phase 2). Tant qu'il ne porte pas d'objet unifié, c'est l'objet legacy qui fait
foi ; dès qu'il en porte un, le legacy n'est plus lu du tout. Lire la moitié de
chacun laisserait un champ périmé survivre à la décision qui l'a remplacé.

**Asymétrie lecture / écriture, assumée.** Le repli legacy → unifié
(`shared/lib/entitlement/entitlement.legacy.js`) est appliqué à **l'écriture**,
jamais à la lecture :

| Chemin | Comportement sur un campus non migré | Motif |
|---|---|---|
| **Lecture** (resolver, garde) | pas de repli — tout reste activé (§4.3) | lire ne doit jamais changer ce qu'un campus atteint ; le socle reste inerte tant que la migration n'a pas tourné |
| **Écriture** (`applyChanges`) | repli d'abord, puis application | sans lui, le premier write stockerait un palier **sans son grand-père**, et tout module hors palier — utilisé quotidiennement — disparaîtrait comme effet de bord d'une édition sans rapport |

C'est le seul endroit du chantier où la migration s'applique paresseusement, et
l'entrée d'audit le déclare (`changes.foldedLegacy`) : les overrides créés par ce
repli n'ont pas été décidés par l'acteur dont le nom figure sur la ligne.

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

### 6.3.4 Ce que la phase 1 a tranché en écrivant ces filtres

**Les arêtes portées par une collection globale ne bloquent pas.** `Course.level`
est bien une clé étrangère `required`, mais `Course` n'a **pas** de `campusId` :
la compter refuserait `level` sur *tous* les campus du parc à cause d'un cours
créé ailleurs. Une collection sans lecture par campus ne peut pas justifier un
refus par campus. Seul `Class.level` bloque donc — et l'arête `Course` reste
visible dans l'aperçu d'impact.

**Un campus mature ne peut effectivement plus masquer `level` ni `subject`, et
c'est le comportement voulu.** Le §5.1 défendait « ranger la config après
paramétrage » ; la règle pilotée par la donnée le refuse dès qu'il existe une
classe ou un emploi du temps. La tension se résout par l'état intermédiaire :
la réponse pour un campus configuré est **`read_only`**, pas `hidden`. C'est la
même phrase que partout ailleurs dans ce document — *on n'empêche pas d'arrêter,
on empêche de faire disparaître*. Le cas « campus en pré-ouverture », lui, reste
entièrement ouvert : c'est exactement ce que la règle pilotée par la donnée
préserve.

**Le contrôle porte sur la transition effective, pas sur la charge utile.**
Les deux contrôles de données (plancher `minState` et usage structurel) sont
calculés sur le couple *résolu avant / résolu après*, et non sur les overrides
soumis. C'est ce qui rend un **déclassement de palier** aussi sûr qu'un toggle :
passer un campus de `standard` à `free` masque `finance` **par le preset**, sans
qu'aucun override ne le mentionne, et doit être refusé de la même manière quand
des paiements existent. Vérifier la charge utile seule laissait passer
précisément le chemin dangereux.

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
l'écriture en vol (§8.3). Ils sont gelés dans `FEATURE_ERROR_CODES`
(`shared/constants/features.constants.js`), miroir frontend compris.

**Montage (corrigé en phase 1)** : `mountEntitlementGates(app)`, **une seule
ligne** dans `app.js`, qui pose une garde par chemin déclaré au registre
(`FEATURE_REGISTRY[key].routers`). Écrire les 26 lignes à la main donnerait à
cette liste une seconde source de vérité non épinglée (CLAUDE.md §0.1), et le
mode de défaillance d'une ligne oubliée est le silencieux : un module qui ignore
le campus qui l'a coupé. Aucun contrôleur ne connaît le système.

Deux contraintes de montage découvertes à l'écriture, non anticipées :

1. **La garde est montée avant les routeurs, donc avant leur `authenticate()`
   interne** — `req.user` n'existe pas encore. Elle lit donc l'identité via
   `optionalAuth` (même algorithme, même `issuer`, ne refuse jamais) : la garde
   voit qui appelle sans prendre en charge l'authentification, et un jeton absent
   ou invalide reçoit toujours son 401 du routeur.
2. **Trois modules (`student`, `teacher`, `staff`) montent leur routeur sur
   `/api` nu** et exposent plusieurs préfixes depuis l'intérieur. Les garder à
   leur point de montage placerait la garde devant toute la surface API : elles
   sont donc montées par chemin (`/api/students`, `/api/schedules/student`, …),
   ce que le registre déclarait déjà.

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

### 8.2 Consommation — livrée en phase 3

| Livrable | Fichier | Rôle |
|---|---|---|
| Miroir des constantes | `src/config/featureConstants.js` | états + codes d'erreur seuls. **Ni les clés, ni les libellés, ni les paliers** ne sont dupliqués : ils voyagent dans le champ `registry` de la réponse, donc ajouter un module au registre backend ne demande aucune livraison frontend |
| Client API | `src/services/entitlementService.js` | un appel, aucune règle |
| Contexte | `src/context/EntitlementContext.jsx` | hydratation unique par identité × campus (cache module, même patron que `useHardDelete`), refetch sur refus, Snackbar global |
| Hook | `src/hooks/useFeature.js` | `useFeature(key)` → `{ state, visible, canWrite, readOnly, restricted, label }` ; `useEntitlement()` pour le contexte complet |
| Garde de rendu | `src/components/shared/FeatureGate.jsx` | masque section/bouton ; `mode="write"` pour le cas `read_only` |
| Garde de route | `src/routes/FeatureGuard.jsx` | **composé** avec `ProtectedRoute` (pas substitué) : accès direct par URL → écran « module non activé », jamais un 404. Pose aussi le bandeau `read_only` (§8.4) |
| Filtrage nav | `src/components/AppShell.jsx` + 6 fichiers portail | les portails **déclarent** (`feature: 'finance'`), AppShell **décide** |
| Écriture en vol | `src/api/featureRefusal.js` + intercepteur axios | §8.3 |
| i18n | `common.features.*`, 10 locales | écran de refus, message d'interception, badges |

### 8.3 L'écriture en vol

Un utilisateur a la page Finance ouverte au moment du toggle : son POST part et
prend un 403. Sans traitement, cela ressemble à un bug.

Intercepteur axios global : sur `FEATURE_DISABLED` / `FEATURE_READ_ONLY` →
message explicite + re-hydratation des flags + rafraîchissement de la navigation.

---

### 8.4 Ce que la phase 3 a tranché en écrivant le code

**Le fail-open ne se transpose pas tel quel au rendu.** Le resolver répond
`enabled` quand il ne sait pas (§4.3), et la tentation était d'appliquer la même
règle pendant le chargement. C'est faux : « je ne sais pas encore » et « je n'ai
pas pu savoir » sont deux questions différentes. Supposer `enabled` le temps
d'une requête fait apparaître des entrées de menu et des boutons qui disparaissent
une demi-seconde plus tard — exactement le bouton mort que le §4.1.2 proscrit, et
la seule défaillance qu'un utilisateur remarque. **Rien de gardé ne s'affiche
avant la réponse** ; en revanche l'**échec**, lui, reste fail-open (une requête
en erreur résout vers « tout activé », jamais vers un écran vide).

**La place du provider est contrainte des trois côtés, ce n'est pas une
préférence.** Il doit être *dans* `BrowserRouter` (il lit `/campus/:campusId`
pour savoir quel tenant un ADMIN visite), *dans* `AuthProvider` (son cache est
clé sur l'identité connectée) et *dans* `RtlProvider` **et** la frontière
`Suspense` de l'i18n (il rend un Snackbar thémé et traduit). i18next tourne avec
`useSuspense: true` : le placer au-dessus de cette frontière suspend l'arbre
entier sans boundary.

**Deux portails ne sont délibérément pas filtrés.** Le §8.2 comptait « les 8
fichiers portail » ; six seulement portent des clés. `Admin.jsx` et
`Director.jsx` servent des rôles globaux, que la garde serveur laisse passer
(§5.2) : y filtrer retirerait les entrées des deux seuls opérateurs capables de
rallumer un module. Ce sont eux que sert le **badge**, et il apparaît là où ils
naviguent réellement dans un tenant — le portail campus.

**Le filtrage nettoie aussi les séparateurs et les groupes vides.** Retirer 7
entrées sur 24 laisse un en-tête « Évaluation » sans rien dessous et des filets
qui s'empilent. Un groupe vide est l'« onglet vide » du §4.1.2 au même titre
qu'un bouton mort ; il part avec ses enfants, et les séparateurs orphelins
(en tête, en queue, deux de suite) sont repliés.

**Un module `read_only` garde sa route ET son entrée de menu.** `FeatureGuard`
ne refuse que `hidden`. Bloquer la route d'un module gelé amputerait précisément
l'historique que cet état existe pour préserver (§4.1) ; ce sont les actions
mutantes *à l'intérieur* de la page qui disparaissent, via
`<FeatureGate mode="write">`.

**Un module gelé est annoncé une fois, au-dessus de la page.** Masquer chaque
contrôle mutant sur quatre modules et une douzaine d'onglets, c'est la
granularité par bouton que le §6.2 écarte de la v1 — et la faire à moitié est
pire que ne pas la faire : une page dont trois boutons ont disparu et deux sont
restés est une page dont l'utilisateur conclut que les deux restants sont
cassés. Un bandeau posé par `FeatureGuard` énonce la règle pour tout l'écran,
l'intercepteur (§8.3) rattrape ce que l'utilisateur tente quand même, et
`<FeatureGate mode="write">` reste disponible pour les écrans qui veulent
descendre plus fin. Le bandeau ne s'affiche pas pour un rôle global : ses
écritures passent, le lui annoncer serait faux (§5.2).

**Le portail parent garde sur le module qui POSSÈDE la donnée, pas sur celui qui
sert la route.** `/api/parents/me/children/:id/transcripts` est gardé par
`parent` côté serveur : masquer `result` n'y déclenche aucun 403. Mais un campus
qui masque les Résultats ne doit pas les proposer aux parents — c'est le §4.1.2,
pas un effet de bord. **C'est le seul endroit du chantier où la garde frontend
est plus stricte que la garde serveur**, et c'est assumé. Le sens inverse
resterait un bug ; celui-ci ne fait que refuser d'afficher.

---

### 8.5 Ce que la phase 4 a tranché en écrivant le code

**Ce qu'une couche a le droit de sélectionner est calculé par la garde, pas
redessiné par l'écran.** La tentation était de griser les états côté React à
partir de `core`, `offerState` et du rang des trois états. C'est exactement la
duplication que le §8.2 interdit, et elle échoue du côté que personne ne voit :
un bouton simplement absent pour un opérateur qui y a droit. `describeForCampus()`
prend donc la couche appelante en paramètre et renvoie `allowedStates` par
module, obtenu en interrogeant `checkOverrideAuthority()` — la fonction que la
route appellera de toute façon au moment d'écrire. Une seule implémentation, et
l'écran ne peut pas être plus permissif que le serveur.

**Seuls les contrôles déclaratifs peuvent voyager ainsi.** `allowedStates` porte
le noyau et le plafond de l'offre. Il ne porte **pas** les contrôles pilotés par
la donnée (§6.3.3) — un module qui détient des enregistrements, un module dont
une autre collection a encore besoin : ils dépendent de ce que le campus a
stocké, ils sont sondés au moment de l'écriture, et les prédire à l'affichage
reviendrait à deviner. L'écran laisse donc demander, et affiche le 409 avec
**toute** la liste des refus. C'est le même parti que le rapport d'impact de la
suppression définitive.

**L'IA perd son dialogue, pas ses réglages.** `AiEntitlementDialog` pilotait un
module derrière un champ « palier » qui était devenu, en phase 2, le palier de
**toute la plateforme** (D-D) : un admin qui passait un campus en `premium` pour
son IA élargissait son offre entière sans qu'aucun écran ne le dise. Le palier
est désormais au-dessus de la matrice qu'il déplace, et l'aperçu nomme les
modules que le changement ouvre **et ceux qu'il ferme** avant d'enregistrer.
Ce qui reste réellement propre à l'IA — profil LLM, budget de jetons, quatre
sous-fonctions — vit dans un onglet du même dialogue ; l'activation, elle, est
la ligne `ai` de la matrice, comme tout le monde.

**Un seul enregistrement, donc une seule ligne d'audit.** La porte générique
(`applyAndRespond`) transporte désormais aussi les champs de **valeur**
(`quotas`, `ai`) que `applyChanges()` acceptait depuis la phase 2 mais qu'aucune
route ne lui passait — seule la console IA le faisait, par son propre chemin.
Le dialogue envoie donc palier, modules, quotas et réglages IA dans **un** PATCH :
un audit, un refus, et aucun état à moitié appliqué où le palier aurait bougé
sans les modules qu'il gouverne. Les valeurs suivent la même règle de couche que
le palier — refusées explicitement à la couche usage, jamais ignorées.

**La vue parc ne se compose pas d'appels par campus.** `describeEstate()` fait
**une** lecture et résout en mémoire : le resolver est pur, donc N campus coûtent
N appels de fonction et un seul aller-retour base. Le cache par campus n'est
délibérément pas consulté — une matrice recousue à partir d'entrées d'âges
différents montrerait deux campus à deux instants différents. Et la ligne qui
compte le plus est celle **qu'on serait tenté de filtrer** : un campus sans
entitlement, donc en fail-open, est précisément le locataire qui dispose
aujourd'hui de tous les modules payants. Il est signalé, pas masqué.

**Les libellés se traduisent sans que le registre bouge.** `useModuleLabel()`
résout `common.features.modules.<clé>` avec le libellé anglais du registre en
repli : ajouter un module au backend continue de ne demander aucune livraison
frontend — il s'affiche simplement en anglais jusqu'à sa traduction. `useFeature`
passe par le même résolveur, donc l'écran « module non activé », le bandeau
`read_only` et les matrices de pilotage ne peuvent pas nommer la même clé de
trois façons.

**Défaut de la phase 3 corrigé au passage** : `features.notActivatedBody` et
`features.frozenBody` étaient écrits en `{{module}}` dans les dix locales. Le
projet tourne sous `i18next-icu` (`src/i18n/i18n.js`), dont l'interpolation est
à accolade simple — les deux phrases n'ont jamais résolu leur variable. Les
1 180 chaînes du namespace `features` compilent désormais sous `IntlMessageFormat`
dans les dix langues.

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

#### Ce que la phase 5 a tranché en écrivant ces trois jobs

**La nature est une propriété du JOB ; l'émission est une propriété d'un SITE à
l'intérieur.** `competition-closing` est déclaré `HYGIENE` — la clôture doit
toujours régler le classement, sans quoi un concours resté actif ne se ferme
jamais et son palmarès continue de bouger — et il porte pourtant une émission :
les mails aux gagnants. Dériver le comportement de `nature` seul aurait donné
l'un des deux, jamais les deux. La carte des sites d'émission est donc
**déclarée** dans `shared/lib/entitlement/entitlement.jobs.js` et épinglée dans
les deux sens : tout cron marqué `EMISSION` au registre doit y figurer (un
nouveau job émetteur ne peut pas partir non câblé), et tout nom qui y figure
doit être un job réellement planifié, appartenant à la feature qu'il nomme (un
job renommé ne peut pas laisser derrière lui une garde qui ne pointe sur rien).

**`finance-overdue` se coupe en deux, et le §9.1 le disait déjà.** Le job fait
deux choses de natures opposées. Le passage en `overdue` **tourne pour tous les
campus** : c'est un fait à propos d'une date, invisible là où Finance est
masqué, et là où Finance est seulement gelé le figer laisserait le grand-livre
afficher `pending` sur des dettes manifestement échues — un module gelé doit
garder son historique *lisible* (§4.1), pas le rendre faux. Il déclencherait en
prime une rafale de transitions le jour de la réactivation. Seules les
**relances** sont supprimées par campus. C'est l'application littérale de « on
coupe l'émission, jamais l'hygiène », à la granularité où les deux se séparent
réellement.

**L'exclusion doit atteindre la REQUÊTE, pas le résultat.** Filtrer après coup
paraît équivalent et ne l'est pas : `claimFeeForReminder` estampille
`lastRemindedAt` et incrémente `reminderCount` **au moment où il prend la dette**,
donc une relance jetée après le claim aurait quand même consommé le créneau de
relance — le campus serait silencieux aujourd'hui *et* ses dettes non
relançables pendant toute une fenêtre de cadence une fois le module revenu. Même
histoire pour `exam-anticheat`, qui rendrait des lots de sessions qu'il n'a pas
le droit de scanner, affamerait celles qu'il peut scanner, et les retrouverait
identiques au run suivant puisqu'elles gardent leur marqueur nul. D'où
`suppressedCampusIds(feature)` → `$nin`, résolu **une fois par run**, jamais par
ligne. Le compteur de reliquat porte la même exclusion : un backlog comptant des
sessions interdites au job grossirait indéfiniment et se lirait comme une panne.

**L'émission exige `enabled`, pas seulement « non masqué ».** Émettre est une
mutation du monde extérieur : la porte lit donc `isFeatureActive(..., { write:
true })`, le prédicat exact que la garde HTTP utilise pour refuser un POST. La
règle est écrite une seule fois, dans le résolveur, et n'est jamais redite.

**Un module `core` répond sans requête.** Il est `enabled` pour tout le monde par
construction (§5.1) ; ce n'est pas une micro-optimisation mais le chemin le plus
fréquent — `account.welcome` et `account.activate` partent une fois par compte
créé, et personne ne devrait payer un défaut de cache pour réapprendre que le
module comptes ne peut pas être coupé.

### 9.2 Portail public

`/api/public` n'est pas authentifié : pas de `campusId` dans un JWT. La garde
applicative n'y voit aucune identité et laisse passer **par construction**
(§7.1). Le contrôle a donc lieu là où le campus devient connu — juste après sa
résolution — dans `modules/public-portal/portal-campus.js`, qui absorbe aussi le
`if (!campus) return sendNotFound(...)` que les dix contrôleurs répétaient.

**`hidden` répond 404, exactement comme un campus absent ou archivé.** C'est le
§4.1.2 pris au mot : pour un visiteur du web public, un module non activé doit
être indiscernable d'un module jamais construit. Un 403 « ce campus n'a pas
souscrit au portail » publierait la situation commerciale d'un locataire à
quiconque possède une URL. Les trois cas partagent **un seul chemin de code**
plutôt que de s'accorder par convention.

**`read_only` ferme la collecte, pas le site.** Le portail continue de servir
programmes, FAQ, témoignages et classement, et refuse les cinq soumissions
(préinscription, réponse au quiz, contact, candidature partenaire, alerte
prochaine session) avec le code `FEATURE_READ_ONLY` déjà utilisé par la surface
authentifiée. Un campus qui suspend son recrutement en gardant sa page en ligne
est exactement le cas que cet état sert ; répondre 404 y couperait tout le site.

La liste de sélection (`GET /api/public/campuses`) est filtrée : c'est le seul
endroit où un campus apparaît sans avoir été demandé nommément, et y laisser un
campus masqué reviendrait à annoncer une page qui répond ensuite 404. Les campus
gelés y restent — leur site est debout, seule l'entrée est fermée.

### 9.3 Quotas

`maxStudents` / `maxTeachers` / `maxClasses` / `maxDocumentStorageMB` lus par
`resolveQuota(campus, name)` (`shared/utils/entitlement.js`, pur) : chaîne
`entitlement.quotas` → `features` (héritage) → `DEFAULT_QUOTAS` → repli de
déploiement optionnel. Cinq sites câblés : les quatre méthodes `canAdd*` de
`campus.model.js` et le préflight de stockage de la GED.

**L'étape héritée n'est pas décorative** : tant que `scripts/migrate-entitlement.js`
n'a pas tourné, `entitlement` est absent partout et `features` est la **seule**
source portant le plafond réel d'un campus. La supprimer remettrait tout le parc
au défaut le jour du déploiement. Les défauts du sous-schéma `features` dérivent
désormais de `DEFAULT_QUOTAS`, donc le nombre existe une fois (§0.1) — il était
écrit trois fois, dont un `|| 5120` en dur dans la GED.

Une valeur stockée inutilisable (0, négative, non numérique) **retombe** sur la
source suivante au lieu d'être appliquée : `0` ne veut dire « illimité » nulle
part ici, il veut dire « personne ne peut plus rien créer ». Et un nom de quota
inconnu **lève** au lieu de résoudre vers `undefined` — `n < undefined` est
`false`, donc une faute de frappe refuserait toute création sans rien dire.

Ancien `features` retiré après validation prod, avec `aiEntitlement` (§3.2).

### 9.4 Notifications

Aucune émission (in-app **ou** email) pour un module non actif sur le campus
destinataire. Le contrôle vit dans `notify()` — la porte unique par laquelle
passent les sept émetteurs — **avant le rendu et avant la persistance** : une
notification in-app est une émission au même titre qu'un email, elle atterrit
dans la boîte du destinataire au nom d'un module dont son campus a été informé
qu'il est coupé.

Le socle notifications ne sait rien des modules qu'il sert (façade §3) : la
seule chose qu'il détient et qui identifie l'émetteur est la **clé de
template**. L'attribution est donc **déclarée**, dans
`modules/notification/notification.features.js`, et la suite de tests refuse un
template ajouté sans propriétaire. `generic` — le passe-plat dont le contenu est
écrit par l'appelant — est attribué à `null` et n'est jamais supprimé : rien
dans son contenu ne dit de quel module il vient, et deviner ferait taire une
annonce à l'échelle du campus.

Cette porte couvre aussi, par construction, l'émission de `finance-overdue`
(§9.1) : la relance d'impayé passe par `notify()` comme le reste.

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

### Phase 2 — Absorption de l'IA · 1 j — ✅ **livrée le 2026-08-20**

L'IA devient un module comme les autres **pour l'activation**, et garde sa
logique propre là où elle est réellement différente : comptage de tokens, profil
LLM, JWT S2S.

| Concept IA | Source unifiée |
|---|---|
| souscrit | état du module `ai` dans `entitlement.modules` |
| palier | `entitlement.plan` (une seule grille, D-D) |
| budget mensuel | `entitlement.quotas.aiMonthlyTokens` |
| profil LLM | `entitlement.ai.llmProfile` |
| chat / search / analytics / advisors | `entitlement.ai.features`, sinon le preset du palier |

Livrables : `shared/lib/entitlement/entitlement.ai.js` (la vue IA de l'objet
unifié, forme de sortie **identique** à l'ancien `aiEntitlement`) ·
`entitlement.legacy.js` (le repli, partagé avec la migration) · gate IA, signal
d'ingestion et console admin rebranchés · `applyChanges()` ouvert aux champs de
**valeur** (`quotas`, `ai`) · `AI_PLANS` dérivé de `FEATURE_PLANS`.

**Critère d'acceptation tenu : la suite de tests IA existante passe sans
modification** (11 tests, fichier non touché). Suite complète **1326 tests /
63 suites**, lint 0 erreur.

#### Ce que la phase 2 a tranché en écrivant le code

**L'IA ne tombe pas en fail-open, et c'est la seule exception du chantier.**
Le resolver répond `enabled` à un campus sans entitlement (§4.3) : une donnée
absente ne doit jamais éteindre un tenant. Pour l'IA le raisonnement s'inverse —
elle **dépense de l'argent par requête** chez un tiers. L'absence de donnée peut
allumer un module, jamais une dépense. Concrètement : tant qu'un campus n'est pas
migré, l'IA continue de lire `aiEntitlement.enabled`, dont le défaut est `false`.

**La migration ne grand-pérennise jamais `ai`.** C'est le seul module qui portait
déjà un drapeau de souscription par campus : son usage passé est un **fait**, pas
une hypothèse. Le traiter comme les 25 autres aurait offert un module payant à
tout le parc le jour de la migration. Défaut trouvé en écrivant la phase, corrigé
dans le repli partagé.

**Le premier write sur un campus non migré replie d'abord** (§3.2) : sans cela,
régler l'IA depuis la console aurait stocké un palier sans grand-père et fait
disparaître Finance, Examens et Documents d'un campus qui les utilisait.

**`plan` est le palier de la plateforme, pas un palier IA** (D-D). Basculer un
campus en `premium` depuis la console IA élargit donc **toute** son offre. C'est
l'aboutissement voulu de l'unification, mais la conséquence n'est visible sur
aucun écran avant la **phase 4**, qui remplace ce dialogue par la matrice
complète. À garder à l'esprit d'ici là.

**Le refus arrive dans un endpoint qui n'en avait pas.** La console IA passant
désormais par la porte unique, un **déclassement de palier** y est contrôlé comme
partout ailleurs : il est refusé (409) s'il enterrait des enregistrements d'un
autre module (§6.3.4). Le mappage refus → HTTP est factorisé
(`sendRefusal`), donc les deux surfaces refusent dans les mêmes termes.

**Reliquat assumé** : `aiEntitlement` reste dans le schéma (§3.2) et
`setCampusAiEntitlement` n'a plus d'appelant — les deux partent ensemble au
retrait post-validation prod, pas avant.

---

### Phase 3 — Front, consommation · 2 j — ✅ **livrée le 2026-08-20**

Livrables du §8.2 (tableau détaillé) et du §8.3. Ce que la phase a tranché en
écrivant le code : §8.4.

**Surface touchée** : 7 fichiers créés · 3 socles modifiés (`main.jsx`,
`AppShell.jsx`, l'intercepteur axios) · 6 portails annotés · 6 tables de routes
gardées · 10 `common.json`. `npm run build` vert, `eslint` sans erreur nouvelle
(la seule sur `EntitlementContext.jsx` est `react-refresh/only-export-components`,
identique à celle que porte déjà `AuthContext.jsx` — même patron).

**Limite à connaître** : le frontend n'a **aucun framework de test** (`lint` +
`build` sont les seuls contrôles automatiques du dépôt). Les épinglages de cette
phase vivent donc côté backend, où le contrat est produit : registre, resolver,
sondes, service, vue IA et garde d'intégration — **157 tests / 6 suites,
re-passés verts après la phase 3**, contrat inchangé. Ce qui n'est pas épinglé,
et ne peut pas l'être ici : la correspondance entre une entrée de menu et sa
clé, et celle entre une route et sa garde. Les deux sont déclarées explicitement
à chaque site (deux surfaces distinctes — visibilité du menu et accès direct par
URL), et une divergence est silencieuse dans un sens comme dans l'autre. **À
vérifier à la QA visuelle**, avec un campus migré.

---

### Phase 4 — Pilotage (UI) · 2 j — ✅ **livrée le 2026-08-20**

Ce que la phase a tranché en écrivant le code : §8.5.

| Surface | Livrable |
|---|---|
| **Admin — un campus** | `EntitlementDialog.jsx` (remplace `AiEntitlementDialog.jsx`, supprimé) : palier + aperçu de son effet, matrice des 26 modules, badges « inclus / décidé par la plateforme / décidé par le campus / hors offre », `until`, motif, historique d'audit **en phrases** et non en JSON, onglet IA (profil LLM · budget · 4 sous-fonctions) |
| **Campus manager** | Onglet « Modules » dans `CampusSettings` → `CampusModulesSection.jsx` : son offre, 3 états, `until`, **motif obligatoire** sur toute restriction, ré-hydratation de sa propre navigation après enregistrement |
| **Vue parc (admin)** | `EntitlementEstate.jsx` sur `/admin/entitlement` : matrice campus × modules, palier par ligne, campus **non configurés signalés**, ligne cliquable → le dialogue (jamais d'édition par cellule : c'est le chemin qui porte le motif et le rapport d'impact) |
| **Socle partagé** | `useEntitlementPilot.js` (chargement · brouillon · dirty · refus) et `components/entitlement/` — les deux couches ne diffèrent que par leurs endpoints, tout le reste est écrit une fois |
| **i18n** | `common.features.modules.*` (26 clés) + `common.features.pilot.*` (85 clés) dans les **10 locales**, via `useModuleLabel()` avec repli sur le libellé anglais du registre |

**Backend ajouté par la phase** : `GET /api/admin/entitlement/overview`
(`describeEstate()` — une lecture, résolution en mémoire) · `allowedStates` par
module dans `describeForCampus({ layer })`, calculé par la garde · `quotas` et
`ai` transportés par la porte générique · `PILOT_REQUIREMENTS` servi aux deux
routes GET plutôt que recopié côté frontend.

**Contrôles** : suite backend **1385 tests / 66 suites** verte, `eslint` sans
erreur nouvelle sur les fichiers touchés, `npm run build` vert, et les
**1 180 chaînes** du namespace `features` compilent sous `IntlMessageFormat`
dans les 10 langues. Le frontend n'a toujours aucun framework de test (limite
connue depuis la phase 3) : ce que cette phase ajoute d'épinglable vit côté
backend — `allowedStates` contre la garde, la matrice parc contre le resolver,
les champs de valeur contre la porte générique.

---

### Phase 5 — Les bords · 1,5 j · **non négociable** — ✅ **livrée le 2026-08-20**

Livrables du §9 : 7 crons, portail public, quotas, notifications.

| Bord | Livrable |
|---|---|
| §9.1 — crons | `shared/lib/entitlement/entitlement.jobs.js` (`isEmissionAllowed` · `suppressedCampusIds` · carte `EMISSION_SITES`) · `finance-overdue` (relances exclues **dans la requête**, transition conservée) · `exam-anticheat` (lot **et** compteur de reliquat exclus) · `competition-closing` (clôture toujours, n'émet plus) · les 4 jobs d'hygiène **non touchés** |
| §9.2 — portail public | `modules/public-portal/portal-campus.js` · 10 contrôleurs câblés · `hidden` → 404 indiscernable · `read_only` → lectures servies, 5 soumissions refusées · liste de sélection filtrée |
| §9.3 — quotas | `resolveQuota()` + `DEFAULT_QUOTAS` · 4 méthodes `canAdd*` + préflight de stockage GED · chaîne `entitlement.quotas` → `features` → défaut |
| §9.4 — notifications | garde dans `notify()`, **avant persistance** · attribution déclarée `notification.features.js` |

**Tests livrés dans la phase** : `tests/unit/entitlement.jobs.test.js` (22),
`portal-campus.test.js` (9), `competition.closing.cron.test.js` (5), plus les
cas ajoutés aux suites voisines (finance, anti-triche, notifications). Suite
complète **1368 tests / 66 suites**, lint sans erreur ni avertissement nouveau.

---

### Récapitulatif

| Phase | Charge | Livrable seule ? |
|---|---|---|
| 0 — Registre | 0,5 j | — ✅ **livrée le 2026-08-14** |
| 1 — Socle backend | 2,5 j | ✅ API protégée, pilotage par API — ✅ **livrée le 2026-08-15** |
| 2 — Absorption IA | 1 j | ✅ — ✅ **livrée le 2026-08-20** |
| 3 — Front | 2 j | ✅ UI cohérente — ✅ **livrée le 2026-08-20** |
| 4 — Pilotage UI | 2 j | ✅ autonomie du manager — ✅ **livrée le 2026-08-20** |
| 5 — Bords | 1,5 j | ❌ **doit sortir avec 1-4** — ✅ **livrée le 2026-08-20** |
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
| `tests/unit/entitlement.jobs.test.js` | **la carte des sites d'émission ne peut pas dériver du registre** (dans les deux sens) ; le repli ouvert sur chaque mode de défaillance ; chaque template de notification a un propriétaire déclaré ; la chaîne des quotas |
| `tests/unit/portal-campus.test.js` | `hidden` répond **octet pour octet** comme un campus absent ; `read_only` sert les pages et refuse les soumissions ; le chemin `?ref=` est fermé comme le chemin slug |
| `tests/unit/competition.closing.cron.test.js` | le job d'hygiène **clôture quand même** et gèle son palmarès, n'émet plus |
| `tests/unit/entitlement.service.test.js` (phase 4) | `allowedStates` **est la garde**, pas une seconde lecture des règles : noyau fermé aux deux couches, offre qui élargit, usage arrêté au plafond ; la matrice parc liste le campus non configuré, résout chaque ligne sur son propre objet en **une** lecture, lit `until` à l'instant donné et **ne sert jamais une ligne depuis le cache par campus** ; les champs de valeur passent la porte générique et sont **refusés**, non ignorés, à la couche usage |

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
| **ADMIN** | Matrice de tout le parc (`/admin/entitlement`). Vend un plan, ouvre/ferme un module par campus, voit qui a quoi et depuis quand — et repère d'un coup d'œil les campus **non configurés**, qui disposent de tout |
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

- [x] Tout module monté dans `app.js` est déclaré au registre (test CI vert)
      *(`tests/unit/feature-registry.test.js`)*
- [x] Aucune règle d'accès dupliquée côté frontend *(phase 3 — le filtrage vit
      dans `AppShell`, la décision dans `useFeature`, et le registre voyage
      dans la réponse au lieu d'être recopié)*
- [x] Les 7 crons filtrent sur l'entitlement *(phase 5 — 3 gardés, 4 d'hygiène
      délibérément non gardés, la carte épinglée contre le registre)*
- [ ] Un module `hidden` est indiscernable d'un module inexistant pour un
      utilisateur final (vérifié sur les 8 portails) — *mécanique livrée en
      phase 3 (entrées retirées, groupes vides et séparateurs orphelins repliés,
      accès direct par URL renvoyé sur un écran explicite) ; **reste la QA
      visuelle réelle**, qui suppose un campus migré*
- [x] Un module `read_only` conserve tout son historique consultable *(gate §7.1 +
      bandeau phase 3 + §9.1 : la transition d'impayé continue pour ne pas rendre
      un grand-livre gelé faux)*
- [x] Un module portant des enregistrements ne peut pas passer `hidden` (§4.1.1)
      *(garde phase 1 + affiché en phase 4 : le refus arrive avec **toute** sa
      liste, jamais un item à la fois)*
- [x] Les crons d'hygiène tournent même module coupé ; les crons d'émission se
      taisent (§9.1) *(phase 5)*
- [ ] Audit, export ADMIN et droits des personnes concernées survivent à
      `hidden` (§4.1.2) — *mécanique en place (§5.2 : les rôles globaux ne sont
      bornés par aucun entitlement, et la vue parc de la phase 4 le montre) ;
      **reste la vérification de bout en bout à la QA visuelle***
- [x] Aucun appel Mongoose introduit hors `campus.repository.js` ; le resolver
      ne reçoit que des données brutes (§15bis.3) *(la vue parc de la phase 4
      lit par `listCampusesForEstate()` dans le repository campus, `.lean()`,
      et résout en mémoire — seule dérogation, bornée et déclarée : les sondes
      d'usage)*
- [x] Un CAMPUS_MANAGER ne peut ni élargir son offre, ni se verrouiller
      *(garde serveur phase 1 ; en phase 4 l'écran ne lui **propose** même pas
      l'état interdit — `allowedStates` vient de la garde, pas d'une règle
      recopiée)*
- [x] Toute mutation d'entitlement est tracée avec acteur, motif et horodatage
      *(phase 1 pour l'écriture, phase 4 pour la lecture : l'historique est
      rendu en phrases, et un override créé par le repli legacy est signalé
      comme non décidé par l'acteur dont le nom figure sur la ligne)*
- [x] La suite de tests IA existante passe sans modification *(critère
      d'acceptation de la phase 2, toujours vrai après les phases 3, 4 et 5)*
- [ ] `features` et `aiEntitlement` retirés du schéma après validation prod
      — *opération distincte et postérieure (§3.2). Depuis la phase 4 plus
      aucun écran ne les lit : la route `ai-entitlement` n'a plus de client*
- [x] i18n des libellés dans les 10 locales *(phase 4 — 26 libellés de modules
      + 85 chaînes de pilotage ; `useModuleLabel()` retombe sur le libellé
      anglais du registre, donc un module ajouté au backend n'exige toujours
      aucune livraison frontend)*

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

> **Dérogation assumée en phase 1 — les sondes de refus.** Le point 3 est tenu
> pour le chemin de requête : le resolver, la garde et les 26 routeurs ne voient
> qu'un objet plat, et toute la persistance campus passe par
> `campus.repository.js`. Il ne l'est **pas** pour
> `shared/lib/entitlement/entitlement.usage.js`, qui compte des lignes dans une
> vingtaine de collections pour décider d'un refus (§6.3.3). Faire transiter ce
> comptage par vingt façades de modules ajouterait vingt méthodes publiques dont
> le seul appelant serait ce fichier. Il réutilise donc `MODEL_ACCESSORS` déjà
> exporté par `hard-delete.registry.js` — même précédent, même besoin, pas de
> seconde carte de modèles à faire dériver. Deux garde-fous : le chemin campus de
> chaque modèle est **lu dans le schéma** et non déclaré, et
> `tests/unit/entitlement-deps.test.js` épingle chaque sonde contre les schémas
> réels. Le jour de la bascule Postgres, ce fichier et le registre de suppression
> définitive migrent ensemble.

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
| 2026-08-15 | **PHASE 1 LIVRÉE — socle backend.** 9 livrables (1.1 → 1.9) : schéma `Campus.entitlement` + `entitlementAudit` **ajoutés à côté** de `features` / `aiEntitlement` (§3.2, rien retiré) · resolver pur `shared/utils/entitlement.js` · sondes `shared/lib/entitlement/entitlement.usage.js` · garde · cache TTL 60 s · `shared/middleware/entitlement.js` monté en une ligne · `GET /api/settings/entitlement` · `PATCH /api/admin/campuses/:id/entitlement` (offre) · `PATCH /api/campus/:id/entitlement` (usage) · `scripts/migrate-entitlement.js`. **Tests livrés dans la phase** : 83 unitaires (resolve · deps · service) + 18 d'intégration sur la garde ; suite complète **1265 tests verts / 61 suites**, lint 0 erreur. **Quatre points tranchés à l'écriture** : (1) le contrôle de données porte sur la **transition effective** et non sur la charge utile, ce qui couvre le déclassement de palier (§6.3.4) ; (2) les arêtes portées par une collection **globale** ne bloquent pas, et `level` / `subject` d'un campus mature se **gèlent** au lieu de se masquer (§6.3.4) ; (3) la garde lit l'identité via `optionalAuth` — montée avant les routeurs, elle précède leur `authenticate()` (§7.1) ; (4) dérogation Mongoose assumée et bornée pour les sondes (§15bis.3). **Deux défauts trouvés par les tests** : le chemin `subjectId` déclaré à la racine sur `GaetConstraint` et `StudentSchedule` (il est imbriqué — un bloqueur qui ne bloque jamais), et `describeForCampus` qui ne renvoyait qu'**un** override quand les deux couches en portent un (la décision de l'ADMIN s'affichait sur l'écran du manager) |
| 2026-08-20 | **PHASE 2 LIVRÉE — absorption de l'IA.** L'IA rejoint la grille pour l'activation et garde ce qui lui est propre (budget, profil LLM, sous-features). `shared/lib/entitlement/entitlement.ai.js` (vue IA, **forme de sortie identique** à l'ancien `aiEntitlement`, donc contrat frontend intact) · `entitlement.legacy.js` (le repli legacy → unifié, désormais **partagé** entre `scripts/migrate-entitlement.js` et le premier write) · gate IA, `signalIngest` et console admin `PUT /admin/campuses/:id/ai-entitlement` rebranchés sur la porte unique · `applyChanges()` ouvert aux champs de valeur (`quotas`, `ai`) avec fusion partielle et `null` = effacement · `AI_PLANS` dérivé de `FEATURE_PLANS` · `PLATFORM_ENTITLEMENT` dérivé du preset premium. **Critère d'acceptation tenu** : `tests/unit/ai.entitlement.test.js` passe **sans une ligne modifiée**. Suite complète **1326 tests / 63 suites**, lint 0 erreur (+31 tests : `entitlement.ai.test.js` 22, service 9). **Deux défauts trouvés en écrivant la phase** : (1) la migration **grand-pérennisait `ai`** comme les 25 autres modules — elle aurait offert un module payant, facturé à l'usage, à tout le parc le jour de son exécution ; (2) un premier write sur un campus non migré aurait stocké un **palier sans grand-père**, faisant disparaître Finance / Examens / Documents comme effet de bord d'une édition IA. **Deux points tranchés** : l'IA est la seule exception au fail-open (une donnée absente peut allumer un module, jamais une dépense, §3.2) ; `plan` étant le palier plateforme (D-D), la console IA élargit toute l'offre — conséquence assumée, rendue visible en phase 4. |
| 2026-08-20 | **PHASE 3 LIVRÉE — front, consommation.** L'interface consomme les états sans réimplémenter une seule règle. **7 fichiers créés** : miroir de constantes `src/config/featureConstants.js` (états + codes d'erreur **seuls** — clés, libellés et paliers voyagent dans le champ `registry` de la réponse, donc un module ajouté au registre backend n'exige aucune livraison frontend) · `entitlementService.js` · `EntitlementContext.jsx` (hydratation unique par identité × campus, cache module comme `useHardDelete`, Snackbar global) · `useFeature.js` · `FeatureGate.jsx` (`mode="write"` pour `read_only`) · `FeatureGuard.jsx` (composé avec `ProtectedRoute`) · `api/featureRefusal.js` (canal intercepteur → provider, sans cycle d'import). **3 socles modifiés** : `main.jsx`, `AppShell.jsx` (le filtrage vit **là et nulle part ailleurs** — six portails déclarent `feature:`, un seul décide), intercepteur axios (§8.3). **6 portails annotés**, **6 tables de routes gardées**, **10 `common.json`** (`common.features.*`). `npm run build` vert, aucune erreur lint nouvelle. **Six points tranchés à l'écriture** (§8.4) : (1) le fail-open ne se transpose pas au rendu — « je ne sais pas encore » withhold, « je n'ai pas pu savoir » reste fail-open ; (2) la place du provider est contrainte des trois côtés (routeur, auth, thème + frontière Suspense i18n en `useSuspense: true`) ; (3) `Admin.jsx` / `Director.jsx` **ne sont pas filtrés** — rôles globaux, ce sont eux que sert le badge ; (4) groupes vides et séparateurs orphelins sont repliés, un en-tête de section vide est l'« onglet vide » du §4.1.2 ; (5) `read_only` garde sa route **et** son entrée de menu, et est **annoncé par un bandeau unique** plutôt que par un masquage partiel des boutons (le §6.2 écarte la granularité par bouton en v1, et la faire à moitié fait conclure à l'utilisateur que les boutons restants sont cassés) ; (6) le portail parent garde sur le module qui **possède** la donnée (`result`) et non sur celui qui sert la route (`parent`) — **seul endroit du chantier où la garde frontend est plus stricte que la garde serveur**, assumé. |
| 2026-08-20 | **PHASE 5 LIVRÉE — les bords.** La partie qu'on reporte, et celle qui produit les incidents visibles par le client final. **§9.1 crons** : `shared/lib/entitlement/entitlement.jobs.js` (`isEmissionAllowed` · `suppressedCampusIds` · carte `EMISSION_SITES` épinglée **dans les deux sens** contre le registre) ; `finance-overdue` relances exclues, transition conservée ; `exam-anticheat` lot **et** compteur de reliquat exclus ; `competition-closing` clôture toujours, n'émet plus ; les 4 jobs d'hygiène non touchés. **§9.2 portail public** : `portal-campus.js`, 10 contrôleurs câblés, `hidden` → 404 indiscernable d'un campus absent, `read_only` → lectures servies et 5 soumissions refusées, liste de sélection filtrée. **§9.3 quotas** : `resolveQuota()` + `DEFAULT_QUOTAS`, 5 sites, chaîne `entitlement.quotas` → `features` → défaut. **§9.4 notifications** : garde dans `notify()` **avant persistance**, attribution template → module déclarée. Suite complète **1368 tests / 66 suites** (+42), lint sans erreur ni avertissement nouveau. **Cinq points tranchés à l'écriture** (§9.1) : (1) la nature est une propriété du JOB, l'émission une propriété d'un SITE — `competition-closing` est hygiène *et* porte une émission, donc la carte est déclarée et non dérivée ; (2) `finance-overdue` se coupe en deux — la transition en `overdue` tourne pour tous, sans quoi un grand-livre gelé afficherait `pending` sur des dettes échues et une rafale partirait à la réactivation ; (3) l'exclusion doit atteindre la **requête** — `claimFeeForReminder` estampille `lastRemindedAt` à la prise, donc un filtrage après coup consommerait quand même le créneau de relance ; (4) l'émission exige `enabled`, pas « non masqué » — c'est une mutation du monde extérieur, donc le prédicat de la garde HTTP en écriture ; (5) un module `core` répond sans requête (`account.*` part une fois par compte créé). **Un point tranché au §9.2** : un portail masqué répond **404**, pas 403 — un refus explicite publierait la situation commerciale d'un locataire à quiconque possède une URL. |
| 2026-08-21 | **PHASE 4 LIVRÉE — pilotage UI. CHANTIER CLOS.** Les deux couches de décision se pilotent enfin depuis l'interface. **Frontend, 8 fichiers créés** : socle partagé `hooks/useEntitlementPilot.js` (chargement · brouillon · dirty · motif · refus) et `components/entitlement/` (`EntitlementMatrix` · `ModuleRow` · `PlanSelector` · `AiValuesSection` + `aiPreset.js` · `EntitlementAudit` · `EntitlementRefusal`), `hooks/useModuleLabel.js` ; **3 écrans** : `EntitlementDialog.jsx` (admin, un campus — **remplace `AiEntitlementDialog.jsx`, supprimé**), `CampusModulesSection.jsx` + onglet « Modules » dans `CampusSettings`, `EntitlementEstate.jsx` sur `/admin/entitlement` (vue parc) ; `entitlementService.js` étendu aux 5 appels de pilotage, `admin_service.js` **débarrassé** de ses deux clients IA devenus une seconde porte vers la même décision. **i18n** : `common.features.modules.*` (26) + `common.features.pilot.*` (85) dans les **10 locales**. **Backend ajouté** : `GET /api/admin/entitlement/overview` (`describeEstate()` — **une** lecture, résolution en mémoire, cache par campus délibérément ignoré), `allowedStates` par module dans `describeForCampus({ layer })` **calculé par la garde elle-même**, `quotas` / `ai` transportés par la porte générique (un seul PATCH, donc une seule ligne d'audit), `PILOT_REQUIREMENTS` servi aux deux GET. Suite complète **1403 tests / 66 suites** verte, lint sans erreur nouvelle, `npm run build` vert, **1 180 chaînes du namespace `features` compilées sous `IntlMessageFormat`** dans les 10 langues. **Six points tranchés à l'écriture** (§8.5) : (1) ce qu'une couche peut sélectionner vient de `checkOverrideAuthority()`, jamais d'un grisage recalculé côté React ; (2) seuls les contrôles **déclaratifs** voyagent — les contrôles pilotés par la donnée restent un 409 affiché, jamais prédit ; (3) l'IA perd son dialogue mais garde ses réglages, et son palier est enfin montré pour ce qu'il est depuis la phase 2: celui de toute la plateforme ; (4) un seul enregistrement pour palier + modules + valeurs, donc aucun état à moitié appliqué ; (5) la vue parc **signale** le campus non configuré au lieu de le filtrer — c'est le locataire qui a tous les modules payants ; (6) les libellés se traduisent sans que le registre bouge. **Un défaut de la phase 3 corrigé au passage** : `features.notActivatedBody` et `features.frozenBody` étaient écrits en `{{module}}` dans les 10 locales alors que le projet tourne sous `i18next-icu` (accolade simple) — les deux phrases n'ont jamais résolu leur variable. |
| — | ***Il ne reste aucune phase de code.***<br>***Action porteur, une seule et inchangée*** : lancer `node scripts/migrate-entitlement.js --dry-run` puis sans le drapeau sur la base réelle. Tant qu'elle n'a pas tourné, aucun campus ne porte d'`entitlement` et **tout reste activé partout** (fail-open, §4.3), bords compris — les crons n'excluent personne, le portail sert tout le monde, les quotas retombent sur `features`. Seule exception depuis la phase 2 : l'IA, qui continue de lire son drapeau de souscription historique. La vue parc rend cet état visible d'un coup d'œil : tous les campus y sont marqués « non configuré » tant que la migration n'a pas tourné.<br>***Puis, dans cet ordre*** : (1) **QA visuelle sur un campus migré** — c'est le seul contrôle capable de fermer les deux derniers points de la DoD (§15), et notamment de vérifier la correspondance entrée de menu ↔ clé et route ↔ garde, que rien n'épingle et dont la divergence est silencieuse dans les deux sens ; (2) retrait de `features` / `aiEntitlement` du schéma et de la route `ai-entitlement` (§3.2), **après** validation prod, pas avant.<br>***Suivi inter-briques connu, non bloquant*** : le portail Next.js (brique 4) relaie la réponse de l'ERP telle quelle et affiche un message générique sur tout non-2xx. Un 403 `FEATURE_READ_ONLY` sur une soumission s'y affiche donc correctement mais sans texte dédié. Aucun contrat n'a changé (ni route, ni forme de réponse, ni champ lu) ; le message spécifique est un ajout d'i18n côté portail, désormais utile puisque l'état `read_only` est réellement posable.*

*(Tenir cette section à jour à chaque phase close — c'est le point d'entrée d'une
reprise du chantier par un tiers.)*
