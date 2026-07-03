# Plan de migration — Monolithe Modulaire

> **À LIRE EN ENTIER AVANT TOUTE ACTION DE MIGRATION.**
> Ce fichier est la source de vérité du chantier. Avant de migrer un domaine, relis
> les sections 2 (structure), 3 (façade), 4 (règles d'import) et 7 (procédure).
> Après chaque domaine migré, mets à jour la section 11 (Journal).

---

## 0. Objet

Faire passer le backend Express d'une **architecture en couches techniques**
(`controllers/`, `models/`, `routers/`, `services/`…) à un **monolithe modulaire**
organisé **par domaine métier** (`modules/student/`, `modules/exam/`…), avec un
`shared/` pour le transverse.

**Invariants non négociables pendant tout le chantier :**

- ✅ Un seul déploiement, un seul process (`server.js`), une seule DB. On ne découpe RIEN.
- ✅ **Aucun changement de comportement** : c'est un déplacement de code, pas une réécriture.
- ✅ Le serveur démarre et toutes les routes répondent **après chaque domaine migré**
  (pas de big-bang). Si un domaine casse, on le revert seul.
- ✅ On ne touche PAS à MongoDB/Mongoose ici. (La migration Postgres est un chantier ultérieur.)

---

## 1. État actuel (constaté le 2026-06-12)

- Stack : **Node.js / Express / Mongoose (MongoDB)**.
- Couches techniques à plat : `routers/` (27), `controllers/` (77), `models/` (55),
  `services/` (13), `middleware/` (9), `validations/`, `schemas/`, `configs/`,
  `constants/`, `utils/`, `crons/`, `workers/`.
- `server.js` (464 lignes) monte 27 routers via `require` + `app.use('/api/...')`.
- Dérive organique déjà présente : certains domaines sont déjà des dossiers
  (`exam-models/`, `partner-controllers/`, `document-services/`), d'autres des fichiers
  plats (`announcement.model.js`). **Incohérence à uniformiser.**

### Pattern d'import actuel (exemple réel — `student.controller.js`)
```js
const Student        = require('../../models/student-models/student.model');
const Class          = require('../../models/class.model');          // cross-domaine
const studentConfig  = require('../../configs/student.config');
const { ... }        = require('../../utils/response-helpers');      // shared
const { getLoginPrefs } = require('../../utils/login-prefs.util');   // shared
```
→ Les chemins relatifs sont **explicites et fragiles** : déplacer un fichier oblige à
corriger tous ses importateurs. C'est pourquoi **l'ordre de migration suit le couplage entrant**
(on déplace d'abord ce que peu de gens importent).

---

## 2. Structure cible

```
backend/
  server.js                 ← ne fait QUE: bootstrap + monter modules/*/index.js (.routes via façade)
  app.js                    ← (optionnel) montage des modules extrait de server.js
  shared/                   ← transverse, ne dépend d'AUCUN module
    middleware/             ← auth, role, rate-limiter, locale, upload, formidable
    utils/                  ← response-helpers, validation-helpers, file-upload, schedule.*
    constants/              ← staff-permissions, …
    configs/                ← *.config.js
    db/                     ← connexion mongoose, counter.model + user.model (transverses, cf. §11)
    lib/                    ← generic-entity.controller, generic-bulk.controller (factory)
  modules/
    <domaine>/
      <domaine>.routes.js       ← le router Express du domaine (suffixe .routes.js)
      controllers/              ← TOUJOURS un sous-dossier (même pour 1 seul controller)
        <domaine>.controller.js
      <domaine>.service.js      ← logique métier réutilisable + API inter-modules
      <domaine>.model.js        ← ou dossier models/ si plusieurs
      <domaine>.validation.js   ← schémas de validation du domaine
      <domaine>.worker.js       ← worker/cron PROPRE au domaine (s'il existe), cf. ci-dessous
      index.js                  ← FAÇADE: seul point d'entrée public du module
```

**Règle de nommage (FIGÉE, cf. §11) :** suffixe `.routes.js` pour le router du domaine —
on **renomme** depuis `.router.js` au moment de la migration. C'est la convention cible,
on s'y tient.

**Workers & crons (FIGÉ) :** un worker/cron **propre à un seul domaine** vit DANS le module
(`modules/<domaine>/<domaine>.worker.js`, ou un sous-dossier `workers/` si plusieurs).
Il importe les internes du module en relatif court (`./<x>.model`) et les autres domaines
via leur **façade** `.service` (jamais leur model). Un worker réellement transverse
(orchestration multi-domaines) reste à la racine (`workers/` / `crons/`) et n'importe que
des façades `modules/*/index.js`. Idem pour un service propre au domaine
(ex. `gaet.conflict.service.js` → `modules/gaet/gaet.conflict.service.js`).

---

## 3. Convention `index.js` (la FAÇADE)

Chaque module expose **exactement** deux choses via son `index.js` :

```js
// modules/<domaine>/index.js
const routes = require('./<domaine>.routes');   // le router Express
const service = require('./<domaine>.service');  // l'API publique pour les AUTRES modules

module.exports = {
  routes,        // monté par server.js :  app.use('/api/<x>', mod.routes)
  service,       // appelé par les autres modules :  studentModule.service.findById(id)
  // PAS de model exporté. PAS de controller exporté.
};
```

**Pourquoi :** la façade est la frontière qui rend l'archi « modulaire » et pas juste
« des dossiers ». Un module externe qui a besoin de données d'un autre domaine passe par
`service`, jamais par le model. Le jour de la migration Postgres, on réécrit l'intérieur
du module sans toucher ses consommateurs.

**`service.js` minimal d'un domaine** doit au moins exposer les accès lus par d'autres
modules. Exemple pour `student` (17 réfs entrantes) :
```js
module.exports = {
  findById, findByCampus, exists, getEnrollmentInfo,  // ce que exam/result/parent lisent
};
```

---

## 4. Règles d'import (les LOIS — à respecter à la lettre)

1. **`shared/` ne `require` JAMAIS un `modules/...`.** Dépendance unidirectionnelle :
   `modules/ → shared/`. Jamais l'inverse. (Si du code « partagé » a besoin d'un domaine,
   c'est qu'il appartient à ce domaine.)

2. **Un module n'importe PAS le `model` ni le `controller` d'un autre module.**
   Il importe la **façade** : `require('../autre-domaine').service`.
   - ❌ `require('../../models/student-models/student.model')` depuis le module `exam`
   - ✅ `require('../student').service.findById(id)`

3. **À l'intérieur d'un module**, imports relatifs courts autorisés (`./x.model`,
   `./x.service`). C'est le seul endroit où on touche directement aux models.

4. **Le `server.js` n'importe QUE des `modules/*/index.js`** (la façade `routes`).
   Aucun `require('./controllers/...')` ni `require('./routers/...')` ne doit subsister.

5. **Pas de dépendance circulaire entre modules.** Si A.service a besoin de B.service et
   B.service de A.service → extraire la logique commune dans `shared/lib/` ou créer un
   module « core » dont les deux dépendent. (À surveiller surtout autour de
   `student ↔ result ↔ exam`.)

6. **Le « core académique » est un cas spécial** (voir §6) : `campus`, `student`, `teacher`,
   `class`, `level`, `subject`, `department`, `course` sont importés partout. Pendant la
   transition, on laisse un **shim de compatibilité** à l'ancien chemin (voir §8) pour ne
   pas devoir corriger ~34 fichiers d'un coup (cas campus).

---

## 5. Inventaire des domaines & couplage

Couplage ENTRANT = nb de fichiers hors-domaine qui `require` un model du domaine
(re-mesuré le 2026-06-12 par `grep -rln "require(.*<model>"`). Plus c'est élevé, plus
c'est risqué → plus c'est tard. Les nombres servent à **ordonner** ; ils peuvent dériver
de ±1-2, re-mesurer avant d'attaquer un domaine.

| Domaine            | Models (dossier actuel)                              | Réfs entrantes | Tier |
|--------------------|------------------------------------------------------|:--------------:|:----:|
| **gaet**           | gaet-constraint                                      | 0              | PILOTE |
| mentor             | mentor                                               | 4              | leaf |
| announcement       | announcement                                         | 3              | leaf |
| staff / staffRole  | staff, staffRole                                     | 4 / 2          | leaf |
| parent             | parent                                               | 4              | leaf |
| document           | document-models/ (6)                                 | 11             | leaf+ |
| result             | result, final-transcript, grading-scale              | 9              | leaf+ |
| exam               | exam-models/ (7)                                     | 10 (session)   | leaf+ |
| partner            | partner, partner.lead, partner.commission, partner.application | 6     | ⚠️ voir §9 |
| public-portal      | quiz, faq, testimonial, competition.prize, contact, course.preview | —  | ⚠️ voir §9 |
| finance            | income, expense, expense-category                    | bas            | leaf |
| settings / admin   | userPreferences, timezone_whitelist, admin           | 2              | leaf |
| notification       | notification, user-notification                      | —              | shared? |
| **course**         | course                                               | 7              | CORE |
| **department**     | department                                           | 5              | CORE |
| **subject**        | subject                                              | 7              | CORE |
| **level**          | level                                                | 1              | CORE |
| **class**          | class                                                | 13             | CORE |
| **teacher**        | teacher-models/ (3)                                  | 12             | CORE |
| **student**        | student-models/ (3)                                  | 19             | CORE |
| **campus**         | campus                                               | **34**         | CORE (noyau absolu) |

**`counter.model`** : transverse (compteurs globaux, importé par result/parent/…) → `shared/db/`.

**`user.model`** : → `shared/db/` (FIGÉ §11). Cas particulier : il n'est `require`é **nulle
part** directement (0 couplage require), il est seulement référencé par la **ref string
`"User"`** depuis les models de `exam` et `income`. ⚠️ Il n'est chargé à aucun boot connu —
ne pas le croire mort et le supprimer ; au contraire, profiter de la migration pour
s'assurer qu'il est bien `require`é au démarrage (sinon les `populate('User')` sont un bug
latent). Le placer dans `shared/db/` et le charger explicitement au bootstrap.

---

## 6. Stratégie pour le « core académique »

`campus/student/teacher/class/level/subject/department/course` sont le squelette : tout
les importe. On NE les migre PAS en premier (sinon 50+ fichiers à corriger avant d'avoir
validé la convention). Ordre :

1. On migre d'abord tous les **domaines feuilles** (qui *consomment* le core).
   Pendant cette phase, les feuilles importent encore le core via les **anciens chemins**.
2. Une fois les feuilles passées par des façades, on migre le core domaine par domaine,
   en posant à chaque fois un **shim** à l'ancien chemin (§8) pour absorber les
   importateurs pas encore convertis.
3. Quand plus aucun importateur n'utilise l'ancien chemin (vérifié par `grep`), on
   supprime le shim.

---

## 7. Procédure par domaine (CHECKLIST répétable)

Pour CHAQUE domaine, dans l'ordre :

- [ ] **a. Créer** `modules/<domaine>/`.
- [ ] **b. Déplacer** (git mv pour garder l'historique) : router → `<x>.routes.js`,
      controller(s), service(s), model(s), validation(s) du domaine dans le module.
- [ ] **c. Corriger les imports INTERNES** du module (les `../../models/...` deviennent
      `./...`). Vérifier chaque `require`.
- [ ] **d. Écrire `index.js`** : exporter `{ routes, service }`. Remplir `service.js`
      avec les fonctions que d'AUTRES modules consomment (déduites de la colonne
      « réfs entrantes » — voir qui importe ce domaine via
      `grep -rl "require(.*<model>" --include=*.js`).
- [ ] **e. Mettre à jour `server.js`** : remplacer l'ancien
      `require('./routers/<x>.router')` par `require('./modules/<domaine>').routes`.
- [ ] **f. Convertir les CONSOMMATEURS** de ce domaine pour qu'ils passent par la façade
      `require('.../<domaine>').service` au lieu du model. (Pour le core : poser un shim
      à la place — §8.)
- [ ] **g. Poser un shim** à l'ancien chemin model SI des consommateurs non encore migrés
      l'importent (surtout core). Sinon, supprimer l'ancien fichier.
- [ ] **h. VALIDER** (§10) : démarrage serveur + smoke test des routes du domaine + grep
      anti-régression.
- [ ] **i. Commit isolé** : `refactor(modules): migrate <domaine> to modular structure`.
- [ ] **j. Mettre à jour le Journal (§11).**

---

## 8. Shim de compatibilité (transition du core)

Quand on déplace un model encore importé par beaucoup, on laisse l'ancien fichier comme
simple ré-export :

```js
// models/campus.model.js  (ANCIEN chemin — shim temporaire)
module.exports = require('../modules/campus/campus.model');
```

Ainsi les ~34 importateurs continuent de marcher sans modification immédiate. On les
convertit ensuite par lots, puis on supprime le shim quand :
```bash
grep -rl "require(.*models/campus.model" --include=*.js . | grep -v modules/campus
# → doit ne RIEN retourner avant suppression du shim
```

---

## 9. ⚠️ Piège identifié : partner vs public-portal

Le dossier `models/partner-models/` **mélange deux domaines** :
- **Business partenaire** : `partner.model`, `partner.lead`, `partner.commission`,
  `partner.application` → module **`partner`**.
- **Portail public / marketing** : `quiz.*`, `faq.entry`, `testimonial`,
  `competition.prize`, `contact.message`, `course.preview` → module **`public-portal`**.

Les controllers `controllers/public/*` importent ces seconds models. **Avant de migrer
`partner`**, séparer ces deux groupes dans deux modules distincts. Ne pas reproduire le
mélange actuel. `controllers/portal-admin/` (competition.admin, partner.application.admin)
appartient au portail admin — décider s'il rejoint `public-portal` (back-office) ou un
module `portal-admin` dédié.

---

## 10. Validation après CHAQUE domaine

```bash
# 1. Le serveur démarre sans erreur d'import
node -e "require('./server.js')" 2>&1 | head -20   # ou: npm run start, puis Ctrl-C
# (vérifier: aucun "Cannot find module", aucune route en double)

# 2. Aucun require cassé / ancien chemin oublié pour ce domaine
grep -rn "require(.*controllers/<domaine>" --include=*.js server.js routers/ controllers/

# 3. server.js ne référence plus l'ancien router du domaine
grep -n "<domaine>.router" server.js   # → vide

# 4. Smoke test HTTP (serveur lancé) sur une route du domaine
#    ex: curl -s localhost:<port>/api/<x>/... -H "Authorization: ..." | head
```

Critère de réussite : serveur up + routes du domaine répondent comme avant + aucun import
mort. Si KO → revert le commit du domaine (isolé, donc sûr) et diagnostiquer.

---

## 11. Journal de migration (ÉTAT — mettre à jour à chaque domaine)

> Future-instance : LIS cette section en premier pour savoir où on en est.

**Décisions figées (2026-06-12) — APPLIQUER TELLES QUELLES :**
- Suffixe routes : **`<domaine>.routes.js`** (convention cible — renommer depuis `.router.js`).
- Controllers multiples : **sous-dossier `controllers/` dans le module** (ex.
  `modules/exam/controllers/exam.session.controller.js`). Même pour un seul controller,
  on reste cohérent → `modules/<x>/controllers/<x>.controller.js`.
- Emplacement `user.model` : **`shared/db/`** (transverse, pas de module `identity` dédié).

**Avancement :**

| # | Phase            | Domaine        | État        | Commit | Notes |
|---|------------------|----------------|-------------|--------|-------|
| 0 | Préparation      | créer `shared/`, déplacer utils/constants/configs/middleware | ✅ fait | 5a95780 | Seul le transverse PROPRE a bougé. Resté à l'ancien chemin (couplé aux models, migrera avec son domaine) : validation-helpers, schedule-helpers, login-prefs.util, configs/{campus,student,teacher,department,parent,exam}.config, middleware/document-middleware, middleware/public-portal. `user.model` désormais chargé au bootstrap (server.js). ⚠️ `middleware/formidable` = code mort préexistant (package npm absent, 0 importateur) — à supprimer en phase nettoyage. |
| 1 | Pilote           | **gaet**       | ✅ fait     | 9a0867c | Convention validée. Module = routes + controllers/ + service (façade `recoverZombieJobs` pour server.js) + conflict.service + model + validation + worker. Renommages : `gaet.router.js`→`gaet.routes.js`, `gaet.constraint.schema.js`→`gaet.validation.js`. Chemin spawn worker corrigé dans le controller. Imports cross-domaine (student/class/subject/teacher) restent aux anciens chemins (§6). |
| 2 | Feuilles         | mentor         | ✅ fait     | fa70d89 | campus.controller converti à la façade (getCampusStats, listByCampus). Script migrate_user_preferences mis à jour. |
| 3 | Feuilles         | announcement   | ✅ fait     | 1420aed | Inclut user-notification.model + expiry cron (planifié via façade service.runExpiryJob). ⚠️ `models/notification.model.js` = code mort (jamais requis, aucune ref) — supprimer en phase nettoyage. notification.service = public-portal, pas bougé. |
| 4 | Feuilles         | staff/staffRole| ✅ fait     | c92e248 | 1 module, router composite (`/api/staff` + `/api/staff-roles` via `app.use('/api', routes)` — URLs inchangées). campus.controller → façade getCampusStats. |
| 5 | Feuilles         | parent         | ✅ fait     | c949c07 | SHIM posé à models/parent.model.js (hook post-delete de student.model) — retirer à la migration de student. ⚠️ configs/parent.config.js = code mort (0 importateur) — nettoyage. |
| 6 | Feuilles         | finance        | ✅ fait     | 9e0a7d9 | Domaine SANS routes (3 models seulement) → façade `{ routes: null, service }`. campus.controller → countPendingIncomes. expense/expense-category jamais chargés (ERP futur). |
| 7 | Feuilles         | settings/admin | ✅ fait     | 2f42459 | 2 modules distincts. SHIMS posés : models/userPreferences_model.js + models/timezone_whitelist.js (consommateurs restants : login-prefs.util, exam.delivery) — retirer à la migration d'exam et du core. settings.service expose SUPPORTED_TIMEZONES. |
| 8 | Séparation       | public-portal  | ✅ fait     | 274db36 | §9 appliqué. DÉCISION : portal-admin REJOINT public-portal (back-office du même domaine, mêmes models) — pas de module dédié. 7 models extraits de partner-models/, 15 controllers (public/ + portal-admin/ en sous-dossiers), router composite `app.use('/api', routes)` → /api/public + /api/portal-admin (URLs inchangées, chaque sous-router porte sa propre auth). Inclut middleware publicPortal, notification.service (notifyWinners, interne) et competition.closing.cron (façade service.runCompetitionClosingJob). Scripts seed-* mis à jour. AUCUN shim (aucun consommateur externe). Restent dans partner-models/ : partner, partner.lead, partner.commission, partner.application. |
| 9 | Feuilles+        | partner        | ✅ fait     | ea2b6bb | 4 models + 4 controllers + routes (/api/partners inchangé). SHIMS posés : models/partner-models/{partner, partner.lead, partner.application}.model.js (consommateurs : modules/public-portal) — retirer en phase nettoyage quand public-portal passera par un service partner. partner.commission : aucun consommateur externe, pas de shim. models/partner-models/ ne contient plus QUE des shims. |
| 10| Feuilles+        | document       | ✅ fait     | d68db96 | 6 models + 6 controllers + 2 middlewares + 5 services internes (sous-dossier services/) + cron rétention. Façade service : runRetentionJob + shutdownPool. ⚠️ FIX bug latent préexistant : requires paresseux cassés (document.router /verify/:ref et /search → 500 masqué ; template.controller ../services/document.pdf.service) — chemins écrits pour une structure module, réparés par la migration, /verify revalidé (404 DB). SHIMS posés : models/document-models/document.model.js (consommateur : staff.readonly) + services/document-services/document.qr.service.js (consommateur : academic-pdf.service). NB : document.service.js (façade, racine module) ≠ services/document.service.js (interne, recherche). |
| 11| Feuilles+        | result         | ✅ fait     | 658c29c | 3 models (result, final-transcript, grading-scale) + 3 controllers + helper + routes. grading-scale INTÉGRÉ au module (seul consommateur require = result ; exam.session ne l'utilise qu'en ref string, enregistré au boot). ⚠️ FIX bug latent : pre-save result.model requérait './gradingScale.model' (inexistant) → gradeBand jamais résolu ; corrigé vers './grading-scale.model'. SHIMS posés : models/result.model.js (parent/staff/mentor + student.dashboard) + models/final-transcript.model.js (academic-print + parent). |
| 12| Feuilles+        | exam           | ✅ fait     | c1b5649 | 7 models + 8 controllers + 2 helpers + routes (/api/examination inchangé). exam.config (ex-configs/) et exam-analytics.worker (ex-services/, in-process pas spawné) à la racine du module. Façade : runAntiCheatJob. SHIMS posés : models/exam-models/{exam.session (staff.readonly), exam.enrollment (student.dashboard), exam.grading (teacher.dashboard)}.model.js. exam.delivery consomme toujours le shim userPreferences_model (retrait au nettoyage). |
| 13| Core             | course         | ✅ fait     | d73e9cc | 1 model (racine module) + 3 controllers + helper + routes. SHIMS posés : models/course.model.js (staff/mentor readonly + document.access.middleware) + controllers/course-controllers/course.resources.controller.js (⚠️ subject.router consommait directement un CONTROLLER course — couplage préexistant détecté à la validation serveur, à résorber phase 15). |
| 14| Core             | department     | ✅ fait     | 670674c | 1 model + config (racine module) + 1 controller + routes. generic-entity.controller désormais consommé depuis shared/lib (plus via shim Phase 0). SHIM posé : models/department.model.js (campus.controller + teacher.controller). |
| 15| Core             | level/subject  | ✅ fait     | c7f28bb | 2 modules distincts. level : AUCUN consommateur externe, pas de shim. subject : SHIM models/subject.model.js (gaet, exam, course, campus.controller, schedule-helpers). ⚠️ subject.routes consomme toujours course.resources.controller via shim phase 13 — résorption (service ou relocalisation des routes) reportée au nettoyage. |
| 16| Core             | class          | ✅ fait     | 6a425de | 1 model + 1 controller + routes. SHIM models/class.model.js — 10 consommateurs (dont utils/validation-helpers, d'où son couplage §4-1). |
| 17| Core             | teacher        | ✅ fait     | 09b2a27 | 3 models + 5 controllers + teacher.config + 3 routers → composite `app.use('/api', routes)` (/api/teachers + /api/schedules/teacher + /api/attendance/teacher, URLs inchangées). SHIMS : models/teacher-models/{teacher, teacher.schedule}.model.js (teacher.attend sans consommateur externe). teacher.schedule.model → shared/utils/schedule.base direct. |
| 18| Core             | student        | ✅ fait     | 7e73f71 | Miroir de teacher : 3 models + 5 controllers + config + 3 routers → composite `app.use('/api', routes)`. ⚠️ FIX bug latent : hook post-delete requérait './parent.model' (chemin inexistant) → hard-delete étudiant = MODULE_NOT_FOUND ; corrigé vers shim models/parent.model.js (vraie résorption = parent.service.removeChildFromAllParents, au nettoyage). SHIMS : models/student-models/{student (13 réfs), student.schedule (6), student.attend (5)} + configs/student.config.js (campus.controller). |
| 19b| Hors plan       | academic-print | ✅ fait     | 681a882 | Domaine OUBLIÉ du plan initial (détecté post-core : router+controller+academic-pdf.service restés à la racine). Façade : shutdownAcademicPool (server.js) + cleanupExpiredPrintFiles (module document via façade). document.qr.service via shim phase 10. |
| 19| Core (noyau)     | campus         | ✅ fait     | f45883e | 1 model + campus.config (0 consommateur externe, intégré sans shim) + 1 controller + routes. Dashboard → façades finance/mentor/settings/staff en siblings. SHIM models/campus.model.js (~32 consommateurs — résorption progressive via campus.service au nettoyage). Smoke test final : les 20 points de montage répondent. |
| 20a| Nettoyage (sûr) | code mort + shims orphelins | ✅ fait | 7bc7e2d | Supprimés (tous vérifiés 0 importateur) : shims counter.model, timezone_whitelist, general.config, generic-{entity,bulk}.controller ; code mort notification.model, parent.config, formidable (root + shared) ; dossier crons/ vide. |
| 20b-1| Nettoyage (transverse) | shims Phase 0 → shared/ | ✅ fait | | Consommateurs réels bien moindres que les comptes grep (gonflés par les requires internes des modules) : seulement server.js (rate-limiter, locale) et services/profile.service.js (response-helpers) — rebranchés vers shared/. Les requires `'../utils/…'` dans shared/lib/ résolvaient déjà DANS shared/ (chemins relatifs). Supprimés (8 shims, 0 importateur restant, grep vide) : utils/{response-helpers, schedule.base, file-upload}.js + middleware/{auth, rate-limiter, upload, locale, role}/ — dossier racine middleware/ ÉLIMINÉ. Validation : health 200, students/teachers/public 401, log sans erreur. |
| 20b| Nettoyage (design) | résorber les shims restants via services de façade | ⬜ à faire | | ~17 shims actifs (campus 32 réfs, class 10, student 13/6/5, teacher 8/4, subject 6, result, final-transcript, exam ×3, partner ×3, course ×2, department, parent, userPreferences, document ×2, student.config). Remplacer chaque import de model cross-module par une fonction de service exposée par la façade du module propriétaire — domaine par domaine, avec validation serveur à chaque étape. Ensuite : supprimer les shims (grep vide) et les dossiers racine controllers/ routers/ models/ configs/ devenus vides. |

États possibles : ⬜ à faire · 🟡 en cours · ✅ fait · ⛔ bloqué.

### 11.1 Programme du chantier 20b (établi 2026-06-12, recensement exact des consommateurs)

Pattern de chaque étape : (1) lire les usages réels du model chez le consommateur ; (2) ajouter
la/les fonctions dans le `*.service.js` du module propriétaire ; (3) le consommateur appelle
`require('../../<owner>').service.fn(...)` ; (4) supprimer le shim ; (5) validation serveur ;
(6) commit isolé. NB : un simple `ref: 'X'` + populate ne nécessite PAS de service (model
enregistré au boot) — seuls les requires directs comptent.

**Étape 0 — gratuits** ✅ 49f4b4a : `models/user.model.js` supprimé (0 consommateur) ;
`services/send-email.service.js` supprimé (fichier VIDE, 0 octet, 0 référence).

**Vague A — roder le pattern (1-2 consommateurs chacun)** ✅ (2026-06-12)
| A1 ✅ 0196b0f | document.qr.service | generateQrCodeDataUrl via façade document. ⚠️ cycle document ↔ academic-print révélé → require paresseux dans document.retention.cron |
| A2 ✅ f87a077 | document.model | listPublishedForCampus via façade document (staff.readonly) ; dossier models/document-models/ éliminé |
| A3 ✅ 9569716 | configs/student.config | student.service.entityConfig (campus.controller) ; dossier racine configs/ ÉLIMINÉ |
| A4 ✅ 5aeeffa | parent.model | parent.service.removeChildFromAllParents, require paresseux dans le hook post-delete (cycle parent ↔ student) — vraie résorption du bug latent phase 18 |
| A5 ✅ 48722e8 | userPreferences_model | settings.service.getPreferredLanguage (exam.delivery) ; shim CONSERVÉ pour login-prefs.util (→ C0) |
| A6 ✅ 7be1ae9 | exam ×3 (session, enrollment, grading) | exam.service : listCampusExaminations, getUpcomingExamsForStudent (filtre/tri/cap déplacés dans le module), countPendingGrading ; dossier models/exam-models/ éliminé |

**Vague B — moyens (2-5 consommateurs)** ✅ (2026-06-12)
| B1 ✅ ef8b2e0 | partner ×3 | partner.service : 9 fonctions (findActivePartnerByCode, upsertPreRegistrationLead — dédup first-touch + IP_BURST déplacés du controller vers le module —, registerSessionAlert, getLeadContact, createApplication, list/get/review/deleteApplication). notifyWinners ne reçoit plus le model en paramètre. Dossier models/partner-models/ éliminé |
| B2 ✅ 081ef27 | course.model + course.resources.controller | course.service : listApprovedCourses (⚠️ fix latent : la recherche mentor n'échappait pas la regex), isTeacherOfAnyCourse (require paresseux dans document.access), getApprovedCourseForLinking. link/unlinkSubjectCourse DÉPLACÉS vers modules/subject/controllers/subject.course-link.controller.js (ils mutent le Subject). Dossier racine controllers/ ÉLIMINÉ |
| B3 ✅ 8dd398a | department.model | department.service : listDepartmentsForCampus, getDepartmentCampusRef, findDepartmentForBulk. GenericBulkController accepte findRelatedById(id, session) en alternative à RelatedModel (student ↔ Class suivra en C4) |
| B4 ✅ 3330a3c | result.model + final-transcript.model | result.service : 10 fonctions. ⚠️ BUG LATENT n°5 corrigé : mentor.readonly importait result.model SANS destructurer { Result } → toutes les routes résultats mentor répondaient 500 depuis toujours. Incohérence isDeleted mentor préservée via withDeleted |

**C0 — décision utils racine (préalable à la vague C)** ✅ (2026-06-13)
- C0a ✅ 7262f1e — `validation-helpers` scindé : 11 fonctions pures → `shared/utils/validation-helpers.js`
  (~45 consommateurs repointés) ; validateTeacherBelongsToCampus → teacher.service ;
  validateStudentBelongsToCampus → student.service (requires paresseux dans class.controller
  — cycle class↔teacher attendu en C4 — et result.crud — cycle via student.dashboard→result).
  ⚠️ Code mort supprimé (0 consommateur) : validateClassBelongsToCampus,
  validateMultipleClassesBelongToCampus, checkCampusCapacity.
- C0b ✅ c696f28 — `schedule-helpers` → `modules/student/student.schedule.helpers.js`
  (StudentSchedule = source de vérité du miroir). resolveSessionParticipants + syncTeacherSchedule
  exposés via la façade student ; gaet consomme la façade. Getters paresseux internes encore
  sur les shims class/subject/teacher×2 (→ C1/C2/C4).
- C0c ✅ 86695b3 — `login-prefs.util` → settings.service.getLoginPrefs ; 8 controllers d'auth
  repointés ; shim models/userPreferences_model.js SUPPRIMÉ. Campus encore via shim (→ C5).
- C0d ✅ 99393df — profile/export/import.service → `shared/services/` ; dossiers racine
  `services/` et `utils/` ÉLIMINÉS.

**Vague C — les gros (cœur académique)** ✅ (2026-06-13)
| C1 ✅ 60e47f1 | subject.model | subject.service ×6 (countSubjectsOnCampus, listCampusSubjects, getLinkedCourseRefIds, listActiveSubjectsLinkedToCourse, getSubjectCampusRef, resolveSubjectForSchedule). Requires paresseux course.crud + campus.controller. |
| C2 ✅ 87f18c7 | teacher.model + teacher.schedule.model | teacher.service ×13 (validate/count/list teachers, payslip, campusRef, resolveTeacherForSchedule, syncTeacherScheduleMirror, listTeacherSchedulesForStaff, detectTeacherConflicts, upsert/update TeacherSchedule par ref). class.controller réutilise validateTeacherBelongsToCampus. |
| C3 ✅ ff2747e | student ×3 (student, schedule, attend) | student.service ×25 (Student : count/list/refs/print ; StudentSchedule : create/list/roster/sync/ref ; StudentAttendance : summaries/listings/stats). 15 consommateurs ; requires paresseux result + exam (cycles via student.dashboard). **BUG LATENT n°7** : regex non échappée recherche étudiants mentor → corrigée. |
| C4 ✅ 056b466 | class.model | class.service ×17 (counts, listings, resolveClassesForSchedule, getClassForCourseLink/DocumentList, campusRefs, classExistsInCampus, findClassManagedBy, findClassForBulk + mutations Class.teachers[]/classManager orchestrées par teacher.config). student.controller GenericBulkController → findRelatedById. **BUG LATENT n°8** : document.template generateClassList interrogeait `campus`/`mainTeacher` (inexistants) → 404 permanent. **CORRIGÉ post-migration le 2026-06-13 (commit 15b6129, point 2)** : filtre schoolCampus + roster via student.service. |
| C5 ✅ f4c787a | campus.model | campus.service ×9 (getCampusName/ForPdf/StorageInfo/Defaults/DocById/CommissionConfig, getActiveCampusBySlug/ById, listActivePublicCampuses). Campus = hub → **tous les consommateurs en require PARESSEUX**. 6 scripts seed repointés direct vers le model. subject.controller : import mort supprimé. |

**Clôture ✅ (2026-06-13)** : grep vide confirmé (aucun module ne require un model/service/util racine ; `shared/` ne require aucun `modules/`). Dossiers racine supprimés : `models/`, `services/`, `utils/`, `validations/`, `workers/`, `configs/`, `controllers/`, `routers/` + shim mort `constants/staff-permissions.js` (→ `constants/` supprimé). Serveur validé après chaque vague (boot 0 erreur, smokes 200/401). **26 shims sur 26 résorbés.**

> Restant hors périmètre 20b : `schemas/document.create.schema.js` (orphelin, 0 consommateur — à supprimer dans un nettoyage séparé) ; `scripts/` (outillage ops, requiert directement les models de modules) ; quelques `mongoose.model('Campus')` (lookup registre, pas un require de fichier) dans teacher.config/student.config/partner.commission.

---

## 12. Définition de « terminé »

- `server.js` n'importe plus que des `modules/*/index.js`. ✅
- Les dossiers racine `controllers/`, `routers/`, `models/`, `services/`, `validations/`,
  `configs/`, `constants/`, `workers/` sont supprimés. ✅
  (`schemas/` subsiste avec 1 orphelin sans consommateur — nettoyage hors 20b.)
- Aucun module n'importe le model/controller d'un autre module : seuls des
  `require('../<autre>').service` (façades). ✅
- `shared/` ne `require` aucun `modules/...`. ✅
- Le serveur démarre, toutes les routes répondent, aucun shim restant. ✅

**✅ CHANTIER 20b TERMINÉ le 2026-06-13** — 26/26 shims résorbés
(C0 49f4b4a→99393df, Vague A/B 49f4b4a→3330a3c, Vague C 60e47f1→f4c787a, clôture).
Le monolithe modulaire est complet : `modules/` (façades `{routes, service}`) + `shared/`.
