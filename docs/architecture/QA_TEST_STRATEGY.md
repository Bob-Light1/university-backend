# Stratégie de test de la plateforme — chantiers, spécifications et passation

> **Document de conception et de passation.** Il décrit *quoi* construire pour
> doter la plateforme d'un dispositif de test professionnel, *comment*, *dans
> quel ordre*, et *à quelles conditions* chaque chantier est considéré terminé.
>
> **Public visé** : un développeur ou un ingénieur QA qui rejoint le projet. Il
> connaît JavaScript, Node et React, mais **pas** cette plateforme. Ce document
> est sa source de vérité. Plusieurs personnes doivent pouvoir s'y relayer sans
> se perdre : c'est la contrainte de conception n° 1 du document lui-même.
>
> Rédigé le **2026-08-20**. Périmètre : les **quatre briques** (`backend/`,
> `frontend/`, `ai-service/`, `partner/`).
>
> **Statut global** : cadrage approuvé ; **CH-0 livré le 2026-08-21**, les autres chantiers non démarrés.
> Le prérequis absolu de tout le reste — **CH-0** — est donc levé : CH-2, CH-4, CH-5 et CH-6
> peuvent démarrer.
>
> **Révision v1.1 — 2026-08-20**, après audit du document par rapport au code. Trois corrections
> de fond : `PARTNER` reconnu comme **9ᵉ rôle connecté** (la matrice passe de 160 à **180
> contextes**, et gagne une famille d'isolation **intra-campus** — décision D-12) ; le périmètre
> de `ai-service` est explicité (D-13) ; la recette d'un chantier revient à une seconde personne
> (D-14). Corrections de forme : répartition d'effort qui totalisait 110 %, total en semaines
> qui reprenait la borne basse, modèle `Schedule` inexistant, modèle `Counter`, `bullmq` présenté
> comme inutilisé alors qu'il l'est déjà.
>
> **Révision v1.2 — 2026-08-20**, après un second audit du document contre le code des quatre
> briques. Trois corrections de fond : `Partner` et `GradingScale` **sont scopés campus** sous le
> nom de champ `schoolCampus`, contrairement à ce qu'affirmaient §4.3 et §4.8 (décision **D-15**) ;
> les huit `getCampusFilter` locaux **délèguent tous** au helper canonique, ce qui révise le
> diagnostic du §1.3 et la décision D-07 (**D-16**) ; la matrice CH-2 gagne une famille **C″**
> sans laquelle la fuite inter-campus la plus probable — une route de liste au filtre oublié —
> reste verte (**D-18**). Trois failles de spécification comblées : la famille B n'était pas
> générable depuis le livrable décrit (**D-17**), les cas d'écriture de la famille C corrompaient
> la fixture (**D-19**), et le limiteur de débit n'est partagé que si `REDIS_URL` est défini —
> c'est un second défaut de mise à l'échelle, ajouté au §11.3. Corrections de forme : chemin
> critique confondu avec l'effort total, dépendances CH-3/CH-6 absentes du §0, « 8 rôles »
> résiduel, décomptes de cas et de parcours incohérents avec leurs définitions de terminé,
> commandes du §1 non exécutables telles quelles.

---

## Comment utiliser ce document

**Si vous prenez le relais sur ce dispositif, lisez dans cet ordre — sans sauter d'étape :**

1. **§0 — Tableau de bord.** Vous y voyez l'état réel de chaque chantier. C'est la
   seule section qui fait foi sur l'avancement. Toute autre affirmation d'avancement,
   dans un commit, un ticket ou une conversation, lui est subordonnée.
2. **§2 — Doctrine.** Douze règles non négociables. Elles expliquent *pourquoi* le
   dispositif est construit ainsi. Un intervenant qui les ignore produira du code
   qui sera retiré au chantier suivant.
3. **§3 — Architecture cible.** La vue d'ensemble en sept couches et leurs dépendances.
4. **La section du chantier que vous prenez** (§4 à §11). Chaque section est
   **autonome** : identité, objectif, périmètre, spécification, arborescence,
   dépendances, définition de terminé, pièges propres à ce dépôt.
5. **§16 — Journal des décisions.** Ce qui a été tranché et pourquoi. Ne rouvrez une
   décision qu'en ajoutant une entrée datée, jamais en réécrivant l'ancienne.

**Quand vous terminez ou interrompez un travail**, vous mettez à jour, dans le même
commit que le code :

- la ligne du chantier dans le **§0 Tableau de bord** (état, date, intervenant) ;
- le bloc **« Reste à faire »** de la section du chantier ;
- une entrée dans le **§16 Journal des décisions** si vous avez tranché quelque chose.

Un chantier laissé en `EN COURS` sans « Reste à faire » à jour est un chantier perdu
pour la personne suivante. C'est la seule faute de procédure qui compte vraiment ici.

**Langue.** Prose en français, conforme aux documents voisins de `docs/architecture/`.
**Tout artefact de code — identifiants, commentaires, JSDoc, messages de log, noms de
fichiers, libellés de test — est en anglais**, conformément au §0 de `CLAUDE.md`. Cette
règle ne souffre aucune exception, y compris dans les fichiers de test.

---

## §0 — Tableau de bord des chantiers

> **Source de vérité de l'avancement.** À mettre à jour à chaque commit touchant un chantier.

| ID | Chantier | Couche | État | Dépend de | Effort | Intervenant | Dernière MAJ |
|---|---|---|---|---|---|---|---|
| **CH-0** | Fixture déterministe multi-campus | 0 | `EN PLACE` | — | 1 sem. | Claude (session Bob Light) | 2026-08-21 |
| **CH-1** | Socle unitaire backend | 1 | `EN PLACE` — à maintenir | — | continu | — | 2026-08-20 |
| **CH-2** | Matrice API : auth · rôle · isolation campus | 2 | `À FAIRE` | CH-0 | 1–2 sem. | — | 2026-08-20 |
| **CH-3** | Tests composant frontend | 3 | `À FAIRE` | — *(CH-2 pour les handlers MSW, §7.2)* | 2–3 sem. | — | 2026-08-20 |
| **CH-4** | E2E déterministe (Playwright) | 4 | `À FAIRE` | CH-0 | 2–3 sem. | — | 2026-08-20 |
| **CH-5** | Agent IA exploratoire | 5 | `À FAIRE` | CH-0, CH-4 | 2–3 sem. | — | 2026-08-20 |
| **CH-6** | Charge · performance · sécurité · accessibilité | 6 | `À FAIRE` | CH-0 *(+ CH-2 pour ZAP et k6, §10)* | 2 sem. | — | 2026-08-20 |
| **CH-7** | Revue d'architecture — passage à l'échelle | transverse | `À FAIRE` | — | 1 sem. | — | 2026-08-20 |

**États autorisés** : `À FAIRE` · `EN COURS` · `BLOQUÉ (motif)` · `EN PLACE` · `ABANDONNÉ (motif)`.

**Chemin critique** : `CH-0 → CH-2 → CH-4 → CH-5`, soit **six à neuf semaines** — et non les
onze à quinze du §19, qui sont l'**effort total** et non le délai. CH-3, CH-6 et CH-7 sont
parallélisables et peuvent être confiés à des intervenants distincts dès aujourd'hui, avec une
réserve : CH-3 démarre sans rien (schémas Yup, `useHardDelete`, services) mais ses gestionnaires
MSW dérivent de `routes.json`, livré par CH-2 (§7.2) ; CH-6 n'a besoin de cette même table que
pour ZAP et k6 (§10). Ni l'un ni l'autre n'est bloqué au démarrage ; les deux le sont à
mi-parcours.

**Si vous ne pouvez financer qu'une seule chose : `CH-0 + CH-2`**, deux à trois semaines.
« CH-2 seul » n'existe pas : la matrice consomme la fixture, que le §4.1 appelle sa condition
d'existence. Justification en §6.

---

## §1 — Diagnostic : l'état mesuré au 2026-08-20

Les chiffres ci-dessous ont été relevés sur les dépôts à cette date. **Re-mesurez-les avant
de vous appuyer dessus** ; les commandes exactes sont données pour que le relevé soit
reproductible et non déclaratif.

**Toutes les commandes s'exécutent depuis `~/Projects`** et portent leur propre `cd` : les briques
ont des racines différentes, et une commande donnée sans son répertoire de travail n'est pas
reproductible — ce qui est tout ce qu'on lui demande.

| Indicateur | Valeur | Commande de vérification (depuis `~/Projects`) |
|---|---|---|
| Routes déclarées (backend) | **546** | `cd university/backend && grep -rhoE "router\.(get\|post\|put\|patch\|delete)\(" modules/ shared/ \| wc -l` |
| Fichiers de modèles Mongoose | **58** | `cd university/backend && find . -name "*.model.js" -not -path "./node_modules/*" -not -path "./docs/*" \| wc -l` |
| Modèles Mongoose enregistrés distincts | **57** | `cd university/backend && grep -rhoE "mongoose\.model\([\"'][A-Za-z_]+" --include=*.js . --exclude-dir=node_modules --exclude-dir=docs \| tr -d "\"'" \| sed -E "s/.*\(//" \| sort -u \| grep -vE "^(X\|__SoftDeleteAmbiguous__)$" \| wc -l` |
| Modules métier | **25** | `cd university/backend && ls modules/ \| wc -l` |
| Fichiers de test unitaires backend | **59** | `cd university/backend && find tests/unit -name "*.test.js" \| wc -l` |
| Fichiers de test d'intégration backend | **3** | `cd university/backend && find tests/integration -name "*.test.js" \| wc -l` |
| Fichiers `.jsx` (frontend) | **256** | `cd university/frontend && find src -name "*.jsx" \| wc -l` |
| Tests frontend | **0** — aucun outil installé | `cd university/frontend && grep -E "vitest\|jest\|playwright\|cypress\|testing-library" package.json` |
| Tests portail Next.js | **0** — aucun outil installé | `cd partner && grep -E "vitest\|jest\|playwright\|cypress\|testing-library" package.json` |
| Tests end-to-end, toutes briques | **0** | — |
| Rôles applicatifs connectés | **9** | `ADMIN · DIRECTOR · CAMPUS_MANAGER · TEACHER · STUDENT · PARENT · MENTOR · STAFF · PARTNER` |
| Locales | **10** — dont `ar` (RTL) | `cd university/frontend && ls public/locales` |
| Thèmes | **2** — clair, sombre | — |

> Deux pièges de lecture sur ce tableau. **`find src -name "*.jsx"` compte des fichiers, pas des
> composants** : les ~40 « écrans significatifs » du §1.2 sont une estimation dérivée, pas une
> mesure. Et les deux lignes « modèles » se vérifient par **deux** commandes distinctes — la
> première compte des fichiers `*.model.js`, la seconde des appels `mongoose.model()` — parce
> qu'un fichier peut n'enregistrer aucun modèle et un modèle peut vivre hors d'un `*.model.js`.
> Le décompte des modèles enregistrés exclut `X` et `__SoftDeleteAmbiguous__`, deux schémas
> fabriqués par les suites de test.

### 1.1 La conclusion qui commande tout le reste

Le backend possède un socle unitaire honnête : 59 fichiers verrouillent notamment les
trois conventions de *soft delete* et le registre de *hard delete*. **Au-dessus, c'est le
vide** : 3 tests d'intégration pour 546 routes, et pas une ligne de test sur les
256 fichiers `.jsx` du frontend ni sur le portail public.

> **La totalité du risque de régression du frontend, et la quasi-totalité du risque de
> contrat entre les quatre briques, repose aujourd'hui sur une seule personne qui clique
> dans un navigateur.** Le problème n'est pas que le test manuel fatigue. C'est qu'il n'y
> a aucun filet en dessous de l'humain.

### 1.2 L'explosion combinatoire, chiffrée

| Dimension | Valeurs | Cardinalité |
|---|---|---|
| Rôles | ADMIN, DIRECTOR, CAMPUS_MANAGER, TEACHER, STUDENT, PARENT, MENTOR, STAFF, **PARTNER** | 9 |
| Locales | ar, de, en, es, fr, it, ja, pt, ru, zh-CN | 10 |
| Thèmes | clair, sombre | 2 |
| **Contextes** | rôle × locale × thème | **180** |
| Écrans significatifs | estimation basse sur 256 fichiers `.jsx` | ~40 |
| **États à vérifier** | contextes × écrans | **~7 200** |
| **Coût humain** | à 90 s par état, hors saisie de données | **~180 h** |

180 heures par passe de régression complète. En pratique, le testeur humain **échantillonne**.
Un échantillonnage non tracé n'a pas de couverture connue — c'est la définition d'un test
dont on ne peut rien conclure.

**Conséquence de conception** : aucun outil, IA comprise, ne rend 180 heures de clic
soutenables. Le dispositif doit **supprimer** la plus grande partie de ce produit cartésien
en le traitant à des couches moins chères, et non l'automatiser tel quel.

### 1.3 Constat de dérive relevé pendant l'étude

`CLAUDE.md` §2 prescrit un helper unique `getCampusFilter(req, res)` et interdit le filtre
inline. La réalité du dépôt au 2026-08-20, **relevée fichier par fichier** :

- `shared/utils/validation-helpers.js:133` expose `buildCampusFilter(user, requestedCampusId)` — le helper canonique ;
- **huit modules redéfinissent localement un `getCampusFilter`**, avec **quatre signatures
  différentes** : `(req)` dans `parent.crud`, `mentor`, `staff`, `staffRole` ; `(req, res)` dans
  `result.helper` et `exam.helper` ; `(req, res, paramCampusId)` dans `gaet` ;
  `(user, requestedCampusId)` dans `parent.analytics` ;
- **mais les huit délèguent à `buildCampusFilter`.** Vérifié ligne à ligne : ce sont des
  adaptateurs de signature et de gestion d'erreur au-dessus d'un noyau unique, pas des
  implémentations concurrentes de la frontière. Les deux que la v1.1 de ce document omettait —
  `result.helper.js:48` et `exam.helper.js` — sont d'ailleurs celles qui portent la signature
  `(req, res)` que `CLAUDE.md` §2 prescrit ;
- `isGlobalRole`, lui, est **réellement dupliqué douze fois** : onze fonctions locales
  (`partner.auth`, `partner.crud`, `partner.lead`, `partner.commission`, `teacher.attendance`,
  `student.attendance`, `class`, `course.helper`, `announcement.admin`, `result.helper`,
  `exam.helper`) plus une expression en ligne dans `subject.controller.js:207`.

> **Ce que ce constat justifie — et ce qu'il ne justifie pas.** Il ne dit **pas** que la frontière
> de sécurité est écrite huit fois : la logique est centralisée, et la divergence est ergonomique.
> Il dit que la *surface d'appel* est incohérente — quatre signatures, deux conventions de
> signalement d'erreur — et qu'une surface incohérente est ce qui fait qu'un contrôleur oublie
> l'appel sans que rien ne le signale. Vérifier l'implémentation ne prouve donc toujours rien ;
> seul un test du **comportement observable de chaque route** peut établir que l'isolation tient.
> C'est ce que produit CH-2.
>
> En revanche, la conclusion opérationnelle de la v1.1 était fausse. L'harmonisation de ces huit
> adaptateurs, et la déduplication des douze `isGlobalRole`, sont des renommages au-dessus d'un
> noyau déjà unique : elles **n'ont pas à attendre CH-2**. Voir §16, décision **D-07 révisée par
> D-16**.

---

## §2 — Doctrine : douze règles non négociables

Ces règles priment sur les préférences individuelles. Un intervenant qui souhaite en écarter
une ouvre une entrée dans le §16 Journal des décisions ; il ne la contourne pas en silence.

**R1 — Le déterminisme est une exigence, pas un confort.**
Un test qui échoue une fois sur cinq est pire que pas de test : il entraîne l'équipe à ignorer
les échecs, ce qui neutralise aussi les vrais. Tout test qui ne peut être rendu déterministe
sort de la CI et rejoint la couche exploratoire (CH-5).

**R2 — L'ordre des couches est un ordre de dépendance, pas une préférence.**
Une couche haute construite sur une couche basse absente coûte plus cher et rend moins. On ne
démarre pas CH-5 avant CH-0 et CH-4.

**R3 — Aucun test ne s'exécute jamais sur des données réelles.**
Ni en production, ni sur une copie de production, ni sur une base contenant de vraies données
d'étudiants. Un agent autonome qui parcourt de vrais dossiers étudiants est un incident RGPD
en attente. Le jeu de données de CH-0 est intégralement synthétique.

**R4 — L'IA écrit des tests ; elle ne les exécute pas en CI.**
L'exploration IA est nocturne, hors du *gate* CI, jamais bloquante. Sa sortie de valeur est
du **code Playwright**, pas un rapport. Voir R5.

**R5 — Tout bug confirmé devient une spécification permanente.**
Un bug trouvé par l'agent, par un testeur ou en production donne lieu à un test déterministe
en CH-2, CH-3 ou CH-4 dans le même commit que le correctif. L'agent ne doit jamais retrouver
deux fois le même problème : sinon son coût croît pendant que sa valeur décroît.

**R6 — Le backend est la source de vérité des énumérations, statuts et codes d'erreur.**
Les tests ne redéclarent jamais un littéral qui existe déjà comme constante. Ils importent
la constante. Un test qui code en dur `'archived'` est un second point de vérité, donc un bug
en attente. Conforme au §0.1 de `CLAUDE.md`.

**R7 — Un filtre de suppression ne s'écrit jamais à la main, y compris dans un test.**
Trois conventions coexistent (`status: 'archived'`, `isDeleted`, `deletedAt`) et se trompent
*silencieusement*. Les fixtures et les assertions passent par
`shared/utils/soft-delete.js` (`notDeletedFilter`, `deletedOnlyFilter`, `softDeletePatch`,
`restorePatch`). Voir `CLAUDE.md` §5.1.

**R8 — La charge se mesure au niveau protocolaire, jamais au navigateur.**
Un navigateur sert à mesurer le coût de rendu client sur 1 à 5 sessions. Il ne sert jamais à
simuler une foule. Démonstration chiffrée en §10.2.

**R9 — La sécurité systématique est générée, pas explorée.**
L'exhaustivité sur 546 routes × 9 rôles s'obtient par génération depuis la table de routes.
L'exploration IA n'y est qu'un complément opportuniste, jamais une garantie de couverture.

**R10 — Tout échec est rejoué avant d'être déclaré.**
Deux rejeux automatiques. Non reproductible = instable, classé à part, jamais présenté comme
un bug. C'est le filtre anti-faux-positifs le plus rentable du dispositif.

**R11 — Un rapport doit être diffable, pas joli.**
Sortie JSON structurée, empreinte stable par constat, affichage de **ce qui a changé depuis
la veille**. Un rapport qui repart de zéro chaque nuit cesse d'être lu en deux semaines, et
un rapport que personne ne lit est un coût pur.

**R12 — Les changements inter-briques ne sont pas terminés tant que les consommateurs ne suivent pas.**
Un test de contrat qui casse côté `frontend/` ou `partner/` bloque la livraison backend au
même titre qu'un test backend. Conforme à la section « Cross-brick tasks » de `CLAUDE.md`.

---

## §3 — Architecture cible : sept couches

```
 CH-6  ┌──────────────────────────────────────────────────────────────┐
       │ 6 · Charge · Perf · Sécurité · Accessibilité                 │  outils dédiés
       │   k6 · Lighthouse CI · OWASP ZAP · axe-core                  │  hors gate
       └──────────────────────────────────────────────────────────────┘
 CH-5  ┌──────────────────────────────────────────────────────────────┐
       │ 5 · Agent IA exploratoire                     ◀── votre idée │  nocturne
       │   180 contextes · jugement de rendu · émet des specs         │  jamais bloquant
       └──────────────────────────────────────────────────────────────┘
 CH-4  ┌──────────────────────────────────────────────────────────────┐
       │ 4 · E2E déterministe — Playwright                            │  CI bloquant
       │   30–60 parcours canoniques · captures de référence          │
       └──────────────────────────────────────────────────────────────┘
 CH-3  ┌──────────────────────────────────────────────────────────────┐
       │ 3 · Composant frontend — Vitest · Testing Library · MSW      │  CI bloquant
       └──────────────────────────────────────────────────────────────┘
 CH-2  ┌──────────────────────────────────────────────────────────────┐
       │ 2 · Matrice API — auth · rôle · isolation campus             │  CI bloquant
       │   546 routes × rôles, GÉNÉRÉE · 5 familles · en secondes     │
       └──────────────────────────────────────────────────────────────┘
 CH-1  ┌──────────────────────────────────────────────────────────────┐
       │ 1 · Unitaire backend — 59 fichiers                EN PLACE   │  CI bloquant
       └──────────────────────────────────────────────────────────────┘
 CH-0  ┌──────────────────────────────────────────────────────────────┐
       │ 0 · Fixture déterministe — 2 campus · 9 rôles · données figées│ PRÉREQUIS
       └──────────────────────────────────────────────────────────────┘
```

**Règle de lecture** : chaque couche est un prérequis de celle du dessus. La couche 0 n'est
pas optionnelle — sans jeu de données figé, un constat comme « 0 étudiant affiché » est
**indécidable** : bug, ou base vide ? L'agent ne peut rien conclure, et le lecteur du rapport
non plus.

### 3.1 Répartition de l'effort

Part calculée sur les points médians des estimations du §19, hors CH-7 qui est transverse
et parallélisable : 1 + 1,5 + 2,5 + 2,5 + 2,5 + 2 = **12 semaines-développeur**.

| Couche | Médiane | Part de l'effort | Rôle dans le dispositif |
|---|---|---|---|
| 0 — Fixture | 1 sem. | ~8 % | Condition d'existence de tout le reste |
| 2 — Matrice API | 1,5 sem. | ~12 % | Preuve exhaustive de la frontière de sécurité |
| 3 — Composant front | 2,5 sem. | ~21 % | Fermeture du plus grand angle mort |
| 4 — E2E | 2,5 sem. | ~21 % | Non-régression des parcours réels |
| **5 — Agent IA** | **2,5 sem.** | **~21 %** | **Exploration jugée des 180 contextes** |
| 6 — Charge/sécu/a11y | 2 sem. | ~17 % | Disciplines séparées, outils dédiés |
| | **12 sem.** | **100 %** | |

L'agent IA représente environ **un cinquième** du dispositif. Le lui faire porter la totalité
— ce qui était l'intention initiale — le condamnait : posé au-dessus d'un frontend sans aucun
test, il aurait trouvé de vrais bugs les deux premières semaines, puis noyé ces trouvailles
sous les faux positifs, et le rapport aurait cessé d'être lu au bout d'un mois. C'est le
scénario d'échec classique de ce type de projet, et il s'évite par l'ordre des couches.

---

## §4 — CH-0 · Fixture déterministe multi-campus

| | |
|---|---|
| **Couche** | 0 |
| **État** | `EN PLACE` — livré le 2026-08-21 |
| **Dépend de** | — |
| **Bloque** | CH-2, CH-4, CH-5, CH-6 — **débloqués** |
| **Effort** | 1 semaine-développeur |
| **Brique** | `backend/` |

### 4.1 Objectif

Produire un **jeu de données synthétique, complet, figé et rejouable**, qui puisse être
reconstruit à l'identique par n'importe quel intervenant en une commande, et sur lequel
toutes les couches supérieures s'appuient.

C'est la condition d'existence du dispositif : sans lui, aucun test ne peut distinguer
un bug d'une base vide.

### 4.2 Périmètre

**Inclus** — génération, purge, rejeu, vérification d'intégrité, export des identifiants
de test, couverture des trois conventions de suppression, couverture des deux campus.

**Exclu** — toute donnée dérivée d'une base réelle, même anonymisée (R3) ; les données du
portail public (CH-6 les traitera séparément) ; la génération de volumétrie de charge
(spécifiée séparément en §10.3).

### 4.3 Spécification du jeu de données

Le jeu doit couvrir **la frontière d'isolation** (deux campus), **les neuf rôles connectés**, et
**les trois conventions de suppression**, faute de quoi CH-2 ne peut rien prouver.

| Entité | Campus A (`CAMPUS_A`) | Campus B (`CAMPUS_B`) | Global | Intention de test |
|---|---|---|---|---|
| `Campus` | 1 | 1 | — | La frontière elle-même |
| `Admin` | — | — | 1 ADMIN + 1 DIRECTOR | Rôles globaux, sans filtre |
| Compte `CAMPUS_MANAGER` | 1 | 1 | — | Le rôle qui doit être cloisonné |
| Compte `PARTNER` | **2** | **2** | — | 9ᵉ rôle connecté — voir §4.9. **Deux par campus** : sans un second partenaire dans le *même* campus, la famille C′ de CH-2 n'a aucune cible |
| `Teacher` | 3 | 2 | — | Dont 1 archivé côté A |
| `Student` | 12 | 8 | — | Dont 2 archivés, 2 `pending`, 1 `suspended` côté A |
| `Parent` | 6 | 4 | — | Dont 1 rattaché à 2 enfants |
| `Mentor` | 2 | 1 | — | Rattachement via `Student.mentor` |
| `Staff` + `StaffRole` | 2 + 2 | 1 + 1 | — | `StaffRole` est scopé campus |
| `Class` | 4 | 2 | — | Dont 1 archivée |
| `Level` · `Department` · `Subject` | 3 · 2 · 8 | 2 · 1 · 5 | — | Dont 1 sujet à coefficient 0 |
| `Course` | — | — | 6 | Collection **globale**, sans `campusId` |
| `Partner` | 3 | 2 | — | **Scopé campus via `schoolCampus`** — voir §4.8. Les 2 premiers de chaque campus ont un compte connecté (`role: 'PARTNER'`, `partnerCode`, `partnerType`) |
| `PartnerLead` · `PartnerCommission` | 6 · 4 | 3 · 2 | — | **Répartis entre les deux partenaires connectés du campus**, sinon la famille C′ ne peut rien assérir |
| `GradingScale` | 1 | 1 | — | **Scopé campus via `schoolCampus`** ; un seul `isDefault` par campus (invariant du `pre-save`) |
| `Result` | 40 | 20 | — | Dont 5 `isDeleted: true`, 3 `status: 'ARCHIVED'` mais **vivants** |
| `Document` | 10 | 5 | — | Dont 3 `deletedAt` non nul **conservant** `status: PUBLISHED` |
| `Announcement` | 6 | 3 | — | Dont 2 `deletedAt` non nul, et 2 `status: 'archived'` **vivants** (expirés) |
| `Income` · `Expense` · `StudentFee` | 8 · 6 · 12 | 4 · 3 · 8 | — | Dont impayés en retard, et 2 `isDeleted` |
| `ExamSession` + enrôlements | 2 | 1 | — | Un cycle complet jusqu'à la notation |
| `StudentSchedule` · `TeacherSchedule` | 1 semaine | 1 semaine | — | Créneaux vivants + créneaux retirés (`isDeleted`) |

**Les lignes en gras de la colonne « intention » sont la raison d'être de la fixture.**
Trois pièges du domaine y sont matérialisés délibérément, parce qu'ils sont la source
historique des bugs les plus coûteux du projet :

1. un `Result` en `status: 'ARCHIVED'` est **vivant** — `Result.status` est un état de
   *workflow*, pas un marqueur de suppression ;
2. un `Announcement` en `status: 'archived'` est **vivant** — c'est l'état d'*expiration*
   écrit par le cron nocturne ;
3. un `Document` supprimé conserve `status: PUBLISHED` — seul `deletedAt` fait foi.

Un test qui passe sur une fixture ne contenant pas ces trois cas ne prouve rien sur la
correction des filtres de suppression.

### 4.4 Contraintes techniques

- **Identifiants stables.** Les `ObjectId` sont **dérivés déterministement** d'une graine
  fixe, jamais aléatoires. Un test doit pouvoir référencer « l'étudiant `STU-A-001` » par
  un identifiant constant d'une exécution à l'autre. Sans cela, aucune capture de référence
  visuelle (CH-4) n'est stable.
- **Dates figées.** Aucun `new Date()` implicite dans les données : toutes les dates sont
  calculées par rapport à une **date d'ancrage** définie dans le script. Sinon les écrans
  « échéances à venir » et « retards » changent chaque jour et cassent CH-4 et CH-5.
- **`{ timestamps: true }` contourne la règle précédente, et c'est le piège.** `CLAUDE.md` §5
  l'impose sur **tous** les schémas : Mongoose écrit alors `createdAt` et `updatedAt` à l'heure
  courante, sans jamais consulter les données du seed. « Aucun `new Date()` implicite » devient
  donc faux exactement là où ça compte — toute colonne « créé le », tout tri par `createdAt`,
  toute capture de référence CH-4 qui en affiche une. Le seed écrit ces deux champs
  explicitement : insertion par le driver (`Model.collection.insertMany()`) ou écriture Mongoose
  avec `{ timestamps: false }`.
- **Mots de passe connus.** Un mot de passe unique en clair dans le script pour tous les
  comptes de test, haché à **bcrypt rounds = 12** conformément au §8 de `CLAUDE.md`.
  Il ne doit jamais apparaître dans un `.env` de production. Le mot de passe étant commun par
  construction, on ne le hache **qu'une fois** et on réutilise l'empreinte : à 250–400 ms par
  appel sur une cinquantaine de comptes, hacher compte par compte consommerait à lui seul le
  tiers du budget de 60 s du §4.7.
- **Idempotence.** Deux exécutions consécutives produisent une base identique. Le script
  purge avant de créer.
- **Garde-fou de destruction.** Le script **refuse de s'exécuter** si l'URI de base ne
  correspond pas à un motif de test explicite, ou si `NODE_ENV === 'production'`. Un
  seed qui purge une base de production est le pire incident possible de ce dispositif.
  Le motif doit **admettre dès sa conception** l'URI éphémère que CH-2 lui présentera en
  `globalSetup` (§6.5) : `MongoMemoryReplSet` génère un port **et** un nom de base aléatoires à
  chaque exécution. Autoriser explicitement (a) l'hôte de bouclage sur un port éphémère et
  (b) un nom de base préfixé, refuser tout le reste. Un garde-fou taillé pour une seule URI fixe
  sera affaibli au premier jour de CH-2 — précisément ce qu'il est censé empêcher.
- **Écriture des marqueurs de suppression via le helper.** Les lignes supprimées sont
  produites avec `softDeletePatch(Model)`, jamais avec un littéral (R7).

### 4.5 Arborescence

```
backend/
  tests/
    fixtures/
      seed.js                  # entry point: purge + build + verify
      seed.config.js           # anchor date, seed, counts, guard patterns
      ids.js                   # deterministic ObjectId derivation from stable keys
      builders/
        campus.builder.js
        actors.builder.js      # admin, campus manager, teacher, student, parent, mentor, staff
        academics.builder.js   # level, department, subject, class, course, schedule
        records.builder.js     # result, exam session, enrollment, grading
        finance.builder.js     # income, expense, student fee, payment
        content.builder.js     # document, announcement
      verify.js                # post-seed integrity assertions
      exports.js               # writes tests/fixtures/.generated/accounts.json
```

`tests/fixtures/.generated/` est ajouté au `.gitignore` : il contient les identifiants et
le mot de passe de test, produits à chaque exécution et consommés par CH-2, CH-4 et CH-5.

### 4.6 Interface de commande

```bash
npm run seed:test              # purge + build + verify sur la base de test
npm run seed:test -- --verify  # vérifie sans reconstruire
npm run seed:test -- --print   # affiche la table des comptes et identifiants
```

### 4.7 Définition de terminé

- [ ] `npm run seed:test` s'exécute en moins de 60 s sur une base vierge.
- [ ] Deux exécutions consécutives produisent des `ObjectId` identiques.
- [ ] `verify.js` échoue explicitement si un compteur attendu n'est pas atteint.
- [ ] Le script refuse de s'exécuter contre une URI hors motif de test — **testé**.
- [ ] Les trois pièges de suppression du §4.3 sont présents et vérifiés par `verify.js`.
- [ ] `.generated/accounts.json` couvre les **9 rôles** avec identifiants stables : les 7 rôles
      scopés × 2 campus — dont **2 comptes `PARTNER` par campus** pour la famille C′ — plus les
      2 comptes globaux `ADMIN` et `DIRECTOR`, qui n'appartiennent à aucun campus.
- [ ] Aucun littéral de marqueur de suppression dans le code du seed (R7).
- [ ] Un intervenant qui n'a jamais vu le projet obtient une base peuplée en une commande.

### 4.8 Pièges propres à ce dépôt

- **Les compteurs auto-incrémentés** passent par le modèle `Counter`. Une purge qui oublie
  la collection `counters` produit des matricules qui dérivent d'une exécution à l'autre —
  et casse les phrases de confirmation de la *danger zone*, qui sont construites sur le
  matricule.
- **Une seule des trois « collections globales » l'est vraiment.** `Course` n'a effectivement
  aucun champ de campus : lui en affecter un ferait passer des tests d'isolation qui devraient
  échouer. Mais **`Partner` et `GradingScale` sont scopés campus** — sous un autre nom de champ,
  `schoolCampus`, ce qui est précisément ce qui les a fait passer pour globaux :
  `partner.model.js:84` le déclare *required* sous l'en-tête « Campus isolation invariant:
  schoolCampus toujours obligatoire » et l'indexe quatre fois ; `grading-scale.model.js` impose
  l'unicité du nom par campus et `getDefault(campusId)` filtre dessus. Le `campusId` du jeton
  `PARTNER` **en est dérivé** — `partner.auth.controller.js:49` :
  `campusId: partner.schoolCampus`. Une fixture qui laisse ces deux collections sans campus
  échoue sur un `required`, ou produit des comptes `PARTNER` au `campusId` indéfini — et les
  familles C et C′ de CH-2 ne testent alors plus rien.
  `CLAUDE.md` §5 portait la même erreur (« Global collections (`Course`, `Partner`,
  `GradingScale`) : no `campusId` ») ; **elle y est corrigée depuis le 2026-08-20**. Voir
  décision **D-15**.
- **Chercher `campusId` ne suffit pas** pour savoir si un modèle est scopé. Trois noms coexistent
  dans ce dépôt : `campusId`, `schoolCampus`, et le `campusPath` déclaré par entrée dans le
  registre de *hard delete*. Le registre est la liste la plus fiable de ce qui est scopé, parce
  que sa suite de tests échoue tant qu'un modèle scopé n'y est pas déclaré (`CLAUDE.md` §5.2).
- **`Student.mentor` est la source unique** du rattachement mentor↔étudiant ;
  `Mentor.students[]` est un *virtual populate*. Écrire dans `Mentor.students` ne produit rien.
- **Les quotas de campus** (`canAddStudent`, `canAddTeacher`, `canAddClass`,
  `canAddDocumentStorage`) comptent contre le plan du tenant. Un campus de fixture doit avoir
  un plan assez large, sinon les tests de création échouent pour une raison sans rapport
  avec ce qu'ils testent.
- **`Campus.aiEntitlement`** doit être renseigné sur au moins un campus, sinon toute la
  surface `/api/ai` répond de manière uniforme et n'est pas testable.

### 4.9 Le neuvième rôle : `PARTNER`

**Relevé à l'audit du 2026-08-20, après la première rédaction de ce document.**

`PARTNER` est un **rôle connecté à part entière**, et non un simple enregistrement de données :

- il possède son propre contrôleur d'authentification —
  `modules/partner/controllers/partner.auth.controller.js`, routes
  `POST /api/partners/auth/login`, `/auth/forgot-password`, `/auth/reset-password/:token` ;
- son jeton porte `{ id, role: 'PARTNER', campusId, partnerCode, partnerType }` — il est donc
  **scopé campus**, exactement comme `CAMPUS_MANAGER` ;
- il dispose d'une **interface complète dans le frontend ERP** : `src/partner/`, découpée en
  `components/leads/MyLeads.jsx`, `components/commissions/MyCommissions.jsx`, plus `dashboard`,
  `kit`, `profile`, `notification` et `partnerDetails` — routée par
  **`src/routes/PartnerRoutes.jsx`**, et **non** par `ClientRoutes.jsx`, qui n'en conserve qu'un
  commentaire hérité sur la pré-inscription partenaire.

> **`CLAUDE.md` §2 ne le listait pas dans son tableau d'isolation campus.** C'était un écart de
> documentation, pas de code : le rôle est bien scopé dans les contrôleurs. Mais un intervenant
> qui construit sa matrice d'après ce tableau **omet une surface authentifiée entière** —
> précisément ce qui est arrivé à la première version du présent document. Le tableau a été
> corrigé le 2026-08-20, avec la règle d'isolation intra-campus. Voir décision **D-12**.

Conséquences déjà répercutées : 9 rôles et 180 contextes partout, un compte `PARTNER` par campus
dans la fixture, et un parcours canonique dédié en §8.2 vérifiant qu'un partenaire ne voit
**jamais** les prospects ni les commissions d'un autre.

**Test d'isolation spécifique à ce rôle** : le cloisonnement `PARTNER` n'est pas seulement
campus-à-campus, il est **partenaire-à-partenaire à l'intérieur d'un même campus**. La famille C
de la matrice CH-2 doit donc être étendue d'un cas : jeton du partenaire A du campus A visant
une ressource du partenaire B du **même** campus. Un filtre purement campus laisserait passer.

> **Conséquence sur la fixture, à ne pas manquer.** Ce test exige **deux comptes `PARTNER` par
> campus**, chacun avec ses propres `PartnerLead` et `PartnerCommission`. Avec un seul compte par
> campus — ce que prévoyait la v1.1 — le partenaire B n'existe pas et la famille C′ n'a aucune
> cible : elle serait écrite, exécutée, et verte sans rien vérifier. Le §4.3 a été corrigé en
> conséquence.

### 4.10 Ce qui a été livré — 2026-08-21

Le chantier est **terminé**. Arborescence conforme au §4.5, aux deux ajouts près signalés
ci-dessous.

```
backend/
  tests/
    fixtures/
      seed.js                # purge + build + verify + export ; CLI (--verify/--print/--ephemeral)
      seed.config.js         # ancre, graine, VOLUMES ATTENDUS, garde-fou de destruction
      ids.js                 # ObjectId dérivés, horloge figée, sel bcrypt dérivé
      models.js              # ← ajout : chargement des 58 modèles depuis le disque
      verify.js              # 127 assertions d'intégrité, toutes dérivées de seed.config.js
      exports.js             # écrit/lit .generated/accounts.json + table `--print`
      self-check.js          # ← ajout : preuve exécutable du §4.7 (16 contrôles)
      builders/{campus,academics,actors,records,finance,content}.builder.js
  tests/unit/fixture-seed.test.js   # garde-fou + déterminisme, sans base, dans le gate CI
```

**Les deux fichiers en plus.** `models.js` parce que le seed doit connaître *tous* les modèles
pour les purger, y compris ceux que personne n'importe — il les charge depuis le disque plutôt
que de faire confiance à `mongoose.modelNames()`, comme `hard-delete.test.js` ; et il ne passe
pas par la table interne du registre de *hard delete*, qui est privée (`CLAUDE.md` §5.2).
`self-check.js` parce que la moitié de la définition de terminé n'est pas vérifiable sans base
et n'a donc pas sa place dans le projet Jest `unit`.

**Commandes**

```bash
npm run seed:test                    # purge + build + verify sur MONGODB_TEST_URI
npm run seed:test -- --verify        # vérifie sans reconstruire
npm run seed:test -- --print         # affiche la table des 18 comptes
npm run seed:test -- --ephemeral     # base jetable en mémoire (aucun mongod requis)
npm run seed:test:self-check         # 16 contrôles : budget, idempotence, verify, comptes, login
```

**Définition de terminé — mesures relevées le 2026-08-21**

| Critère §4.7 | État | Mesure |
|---|---|---|
| Seed < 60 s sur base vierge | ✅ | **5,7 à 10,7 s** pour 283 documents, 31 collections |
| Deux exécutions → `ObjectId` identiques | ✅ | Empreinte SHA-256 de **toute** la base identique d'un run à l'autre |
| `verify.js` échoue si un compteur manque | ✅ | Testé en supprimant un étudiant : la vérification refuse |
| Refus hors motif de test — **testé** | ✅ | 6 URI refusées / 5 acceptées, dans `tests/unit/fixture-seed.test.js` |
| Les trois pièges de suppression présents | ✅ | Assertions dédiées « TRAP 1/2/3 » dans `verify.js` |
| `.generated/accounts.json` couvre les 9 rôles | ✅ | 18 comptes ; **2 `PARTNER` par campus**, chacun avec ses prospects et commissions |
| Aucun littéral de marqueur de suppression (R7) | ✅ | `ctx.softDelete(model)` → `softDeletePatch()` ; idem pour les lectures de `verify.js` |
| Une commande suffit à un nouvel intervenant | ✅ | `npm run seed:test -- --ephemeral` ne demande **aucun** MongoDB installé |

En prime, non exigé par le §4.7 mais décisif pour CH-2/CH-4 : **les neuf rôles se connectent
réellement** sur l'application (`supertest` sur `app.js`, `200` + jeton pour chacun des neuf
points d'entrée de connexion). Un catalogue de comptes que les routes de login refusent serait
passé vert sur tous les autres critères.

**Écarts assumés par rapport au §4.3** — tous trois consignés au §16 :

- `Level` est seedé **globalement** (5 niveaux) et non 3 + 2 : le schéma ne porte aucun champ de
  campus et le registre de *hard delete* le déclare `campusPath: null` (**D-21**) ;
- un gestionnaire de classe est **unique par enseignant** (index partiel unique sur
  `classManager`), donc les classes au-delà du nombre d'enseignants vivants n'en ont pas (**D-22**) ;
- « dont 2 `isDeleted` » sur la ligne finance est lu comme **2 par collection** de campus A
  (2 revenus, 2 dépenses, 2 frais), et non 2 au total (**D-23**).

### 4.11 Reste à faire

- [ ] **Recette par une seconde personne** (D-14) : dérouler `npm run seed:test:self-check` et
      relire les volumes du §4.3 ligne à ligne contre `seed.config.js`.
- [ ] Trancher **D-06** en même temps que le démarrage de CH-2 : `startEphemeralDatabase()`
      livre déjà un `MongoMemoryReplSet` prêt pour le `globalSetup`, mais le choix
      « mémoire vs conteneur en CI » reste à consigner.
- [ ] Le portail public (`QuizQuestion`, `Testimonial`, `FaqEntry`, `CoursePreview`,
      `CompetitionPrize`) n'est **pas** seedé — hors périmètre déclaré au §4.2, à reprendre par
      CH-6 s'il en a besoin.
- [ ] `GaetConstraint`, `Notification`, `UserPreferences`, `PrintJob`, `FinalTranscript` et les
      pièces jointes GED (`DocumentVersion`, `DocumentShare`, `DocumentTemplate`) ne sont pas
      seedés non plus : aucune couche supérieure ne les réclame aujourd'hui, mais CH-4 en aura
      besoin dès qu'un parcours GAET ou une notification entrera dans les parcours canoniques.

---

## §5 — CH-1 · Socle unitaire backend (existant)

| | |
|---|---|
| **Couche** | 1 |
| **État** | `EN PLACE` — à maintenir |
| **Effort** | continu |
| **Brique** | `backend/` |

### 5.1 Ce qui existe

59 fichiers sous `tests/unit/`, 1 test de contrat sous `tests/contracts/facades.test.js`,
3 smokes sous `tests/integration/`. Harnais Jest configuré ainsi :

- `testEnvironment: 'node'`, `setupFiles: ['<rootDir>/tests/setup.js']` ;
- **aucune connexion MongoDB** : `app.js` est sans effet de bord, la connexion vit dans
  `server.js` ;
- `moduleNameMapper` remplace `nanoid` (ESM pur) par un stub CJS ;
- `forceExit: true` — certains modules posent des timers.

Deux suites font office de garde-fous structurels et **doivent rester vertes** :

- `tests/unit/soft-delete.test.js` — épingle les trois conventions contre les schémas réels.
  Changez le marqueur d'un modèle et cette suite vous dit quelles requêtes vous venez de casser.
- `tests/unit/hard-delete.test.js` — épingle chaque filtre de relation contre les schémas
  réels, et surtout : **toute référence `ref` d'un schéma pointant vers une entité supprimable
  doit être déclarée par une relation**. Elle charge les fichiers de modèles depuis le disque
  plutôt que de faire confiance à `mongoose.modelNames()`.

### 5.2 Règle de maintenance

> **Ajouter un modèle scopé campus n'importe où dans la plateforme fait échouer
> `hard-delete.test.js` tant que le modèle n'est pas déclaré sur l'entrée `campus`.**
> Ce n'est pas un faux positif : un campus est la frontière du tenant, et une collection
> non déclarée, ce sont les lignes d'un tenant entier abandonnées derrière un campus supprimé.

Les modèles simulés doivent porter `modelName` + un stub de schéma
(`tests/helpers/soft-delete-stub.js`). Un simple sac de `jest.fn()` ne tient plus lieu de modèle.

### 5.3 Le cas de `ai-service` (brique 3)

Le périmètre annoncé en tête de document est « les quatre briques ». `ai-service` fait
exception, et il faut le dire explicitement pour que personne ne croie à une couverture qui
n'existe pas :

- il possède **sa propre suite Python** (`ai-service/tests/`, 19 fichiers `test_*.py`,
  configuration dans `pyproject.toml`), maintenue dans son dépôt, avec son propre cycle ;
- **les chantiers CH-1 à CH-6 ne la remplacent ni ne la dupliquent.**

Ce qui relève **bien** du présent dispositif est le **contrat entre les deux briques**, et lui
seul :

- `/api/ai` — la passerelle Node, **inerte sans `AI_SERVICE_URL`** (503). La matrice CH-2 doit
  couvrir les deux états : configurée et inerte ;
- `/internal/ai` — l'API S2S consommée par `ai-service`, **jamais publiée** par le proxy inverse.
  La matrice doit vérifier qu'elle refuse un jeton utilisateur ordinaire et n'accepte qu'un jeton
  S2S (HS256, TTL ≤ 300 s) ;
- `Campus.aiEntitlement` — le droit par campus, qui conditionne toute la surface.

Décision **D-13** : `ai-service` conserve sa suite propre ; aucun chantier de ce document ne la
prend en charge. Seul le contrat inter-briques est testé, depuis CH-2.

### 5.4 Reste à faire

- [ ] Aucune action requise pour ouvrir les autres chantiers.
- [ ] **À la fin de CH-2** : basculer les 3 smokes de `tests/integration/` dans le projet
      Jest `api` décrit en §6.5, ou les conserver dans le projet `unit` si l'on souhaite
      garder un test de câblage sans base. Décision à tracer en §16.

---

## §6 — CH-2 · Matrice API : authentification, rôle, isolation campus

| | |
|---|---|
| **Couche** | 2 |
| **État** | `À FAIRE` |
| **Dépend de** | CH-0 |
| **Bloque** | — (mais conditionne la refonte du filtre campus, D-07) |
| **Effort** | 1–2 semaines-développeur |
| **Brique** | `backend/` |

### 6.1 Objectif

Établir, **par génération et non par écriture manuelle**, que chacune des 546 routes se
comporte correctement face à :

1. **l'absence de jeton** → 401 ;
2. **un jeton de rôle non autorisé** → 403 ;
3. **un jeton de rôle scopé visant une ressource d'un autre campus** → 403 ou 404, jamais 200 ;
4. **une route de liste interrogée par un rôle scopé** → un `200` légitime, mais **aucun
   identifiant d'un autre campus dans le corps**. C'est le point 4 qui ferme le mode de rupture
   le plus probable, et c'est celui que la v1.1 de ce document laissait ouvert.

### 6.2 Pourquoi ce chantier prime sur tous les autres

- L'isolation campus est la **frontière de sécurité** de la plateforme (`CLAUDE.md` §2).
  Un défaut d'isolation entre établissements est le seul bug de ce projet capable de coûter
  le produit entier sur un marché international.
- Elle est **testable exhaustivement par génération** — ce qui n'est vrai d'aucune autre
  propriété du système.
- Le rapport coût/certitude est sans équivalent : quelques centaines de lignes, **toute la
  surface de routes couverte ou explicitement dérogée**, exécution en secondes, **zéro faux
  positif**. À lire précisément : la couverture est celle de la *surface* — chaque route est
  visitée par au moins une famille — et non celle de la justesse métier des réponses (§6.4).
- Et, comme établi en §1.3, la frontière est appelée à travers **huit adaptateurs de signatures
  différentes** posés sur un noyau unique. Le noyau est sain ; c'est l'oubli d'appel que
  l'incohérence de surface rend possible, et lui seul, qu'un test de comportement peut détecter.

> **Aucun agent IA n'approchera jamais ce rapport coût/certitude sur ce problème précis.**
> C'est la raison pour laquelle la sécurité systématique sort du périmètre de CH-5 (R9).

### 6.3 Spécification de l'énumération des routes

**Piège majeur, à lire avant d'écrire la première ligne.** On ne peut **pas** dériver la
table des routes en analysant les appels `app.use('/api/...')` : quatre routeurs sont montés
sur le préfixe nu `/api` et reconstituent leurs propres sous-chemins.

```js
app.use('/api', publicPortalRoutes);
app.use('/api', studentRoutes);  // → /api/students + /api/schedules/student + /api/attendance/student
app.use('/api', teacherRoutes);  // → /api/teachers + /api/schedules/teacher + /api/attendance/teacher
app.use('/api', staffRoutes);    // → /api/staff/... + /api/staff-roles/...
```

L'énumération doit donc **parcourir la pile de routeurs Express** de l'application importée,
en concaténant les préfixes de montage jusqu'aux couches terminales, et produire une table :

```
{ method, path, mountedAt, paramNames, routerFile, allowedRoles }
```

Cette table est le **produit livrable central** de CH-2. Elle est écrite dans
`tests/api-matrix/.generated/routes.json` et sert aussi à CH-6 (ZAP, k6).

**Second piège, propre à la famille B — à régler avant d'écrire l'énumérateur.** Le dernier champ
de la table ci-dessus n'est pas gratuit : la pile Express **ne porte aucune information de rôle**.
Les rôles autorisés sont passés en argument à la fabrique `shared/middleware/role.js`
(`module.exports = (allowedRoles = []) => (req, res, next) => …`), donc **capturés dans une
closure** qu'aucune inspection de la fonction middleware ne peut atteindre. Sans `allowedRoles`,
la famille B — « un jeton de rôle non autorisé pour *cette* route » — n'est tout simplement pas
générable. Deux options, à trancher au démarrage du chantier (décision **D-17**) :

1. **Instrumenter la fabrique.** `role.js` attache `fn.allowedRoles = allowedRoles` au middleware
   qu'il retourne. Trois lignes, aucune incidence à l'exécution, et la pile devient
   auto-descriptive pour toujours. **Recommandé** : c'est du code applicatif au service du test,
   comme les `data-testid` du §8.7, et c'est le seul des deux qui ne peut pas dériver.
2. **Analyser la source** des fichiers `*.routes.js`. Ne demande rien à l'application, mais casse
   sur la moindre déclaration dynamique et institue un second point de vérité sur les
   autorisations — ce que `CLAUDE.md` §0.1 interdit ailleurs.

### 6.4 Spécification de la matrice

Pour chaque route de la table, **cinq** familles de cas :

| Famille | Requête | Attendu | Portée |
|---|---|---|---|
| **A — Anonyme** | sans en-tête `Authorization` | `401` | Toutes les routes **hors** liste publique déclarée |
| **B — Rôle** | jeton valide, rôle non autorisé pour la route | `403` | Toutes les routes authentifiées |
| **C — Isolation campus** | jeton `CAMPUS_MANAGER` du campus A, paramètre d'URL désignant une ressource du campus B | `403` ou `404` — **jamais `200`** | Toutes les routes portant un paramètre d'identifiant |
| **C′ — Isolation intra-campus** | jeton du partenaire A, paramètre désignant une ressource du partenaire B **du même campus** | `403` ou `404` — **jamais `200`** | Surface `PARTNER` — voir §4.9 |
| **C″ — Isolation sur les listes** | jeton `CAMPUS_MANAGER` du campus A, route de **collection**, sans paramètre d'identifiant | `200` attendu, mais **aucun identifiant du campus B dans le corps** | Toutes les routes de liste des collections scopées |

**Liste publique déclarée.** Les routes légitimement publiques (portail, `/api/ping`,
`/api/health`, activation de compte, connexion, liens courts `/r/{code}`) sont énumérées
dans un fichier d'allowlist **versionné et commenté**, une ligne par route avec sa
justification. Toute route absente de la table *et* de l'allowlist fait échouer la suite.

> **L'allowlist est un allowlist, jamais un fallback.** Le test échoue par défaut sur une
> route inconnue. C'est le même principe de « fail closed » que `buildCampusFilter()` et que
> le registre de *hard delete*. Une nouvelle route publique doit être un acte délibéré et
> tracé, pas un effet de bord.

**Cas C : substitution des paramètres.** Le générateur doit savoir quelle ressource du campus B
injecter dans `:id`, `:studentId`, `:classId`… Il s'appuie sur une **table de correspondance
`paramName → entité de fixture`** déclarée explicitement. Un paramètre non déclaré fait échouer
la suite plutôt que d'être ignoré — sinon une route non couverte serait comptée comme verte.

**Pourquoi la famille C′ existe.** Le cloisonnement de `PARTNER` n'est pas seulement
campus-à-campus : deux partenaires du **même** campus ne doivent pas voir les prospects ni les
commissions l'un de l'autre. Un filtre purement `campusId` — celui que décrit `CLAUDE.md` §2 —
laisserait passer. C'est le seul rôle du système dans ce cas, et c'est pour cela qu'il est
signalé ici plutôt que traité comme une variante de C.

**Pourquoi la famille C″ existe — et pourquoi son absence rendait la matrice trompeuse.** La
famille C ne couvre que les routes portant un identifiant. Or la fuite inter-campus la plus
probable n'est pas un accès direct à une ressource nommée : c'est un `GET /api/students` dont le
filtre a été oublié, qui répond `200` avec les étudiants du campus B dans le corps. Sans C″, ce
cas est **vert** — et c'est exactement le mode de rupture décrit au §9.2 : « liste affichée,
simplement plus longue, aucun signal visuel ». Une matrice qui manque cela ne peut pas être
présentée comme la preuve que l'isolation tient.

L'assertion ne demande pourtant aucun jugement métier, **parce que la fixture est figée** : tout
identifiant renvoyé doit appartenir au jeu du campus appelant, et cette appartenance est connue
par construction (§4.3). C″ est la seule famille qui consomme l'index de la fixture plutôt que la
seule table de routes ; c'est le prix de la seule couverture qui compte vraiment.

**Ce que la matrice ne teste pas** : la justesse métier des **valeurs**. Un `200` dont les champs
sont faux, mais dont tous les identifiants appartiennent bien au campus appelant, passe. C'est
assumé — c'est le rôle de CH-3 et CH-4. Ce qui n'est **plus** assumé, et que C″ ferme, c'est un
`200` contenant les données d'un autre établissement.

### 6.5 Contrainte d'infrastructure : la base de données

Le harnais Jest actuel **ne se connecte à aucune base** — c'est un choix explicite documenté
dans `jest.config.js`. CH-2 a besoin d'une base réelle. La solution :

- **Séparer les projets Jest.** `jest.config.js` déclare deux projets : `unit` (l'existant,
  sans base) et `api` (CH-2, avec base). `npm test` exécute les deux ; `npm run test:unit`
  reste instantané pour la boucle de développement.
- **`mongodb-memory-server` en mode jeu de répliques** (`MongoMemoryReplSet`), **pas** en
  instance seule. Motif impératif : le système de *hard delete* exécute ses cascades **dans
  une transaction**, et les transactions MongoDB exigent un jeu de répliques. Une instance
  seule ferait échouer toute la surface `/api/danger-zone` pour une raison d'infrastructure,
  et non de code.
- **Alternative acceptable** : un MongoDB en conteneur avec `--replSet`, si la CI le permet.
  Décision **D-06** — à trancher et consigner en §16.
- Le seed de CH-0 s'exécute **une fois par run**, dans un `globalSetup`, pas par fichier de test.
  Le garde-fou de destruction du §4.4 doit accepter l'URI éphémère du serveur en mémoire — à
  vérifier avant d'écrire la première ligne, sinon le `globalSetup` refuse de démarrer.
- **La famille C écrit, et c'est le piège de déterminisme du chantier.** Les familles A et B sont
  rejetées avant d'atteindre le contrôleur ; la famille C, elle, porte un rôle *autorisé* et
  traverse tout le code métier. Sur un `POST`, un `PUT` ou un `DELETE`, si l'isolation est trouée,
  la requête **modifie la fixture** — et tous les cas suivants s'exécutent alors sur une base
  différente, donc dépendante de l'ordre d'exécution et de la parallélisation de Jest. C'est
  l'inverse exact de R1, et le symptôme est perfide : la matrice devient instable **le jour où
  elle trouve un vrai bug**. Règle (décision **D-19**) : les cas C en lecture s'exécutent contre
  la base seedée une fois ; **les cas C en écriture vivent dans un fichier de test dédié qui
  re-seede**, ou annulent leur transaction en fin de cas. Une écriture de la famille C ne touche
  jamais la base partagée.

### 6.6 Arborescence

```
backend/
  tests/
    api-matrix/
      enumerate-routes.js       # walks the Express router stack → routes.json
      public-allowlist.js       # declared public routes, one justification per entry
      param-map.js              # paramName → fixture entity
      fixture-index.js          # campus → ids it owns; the oracle behind family C″
      matrix.test.js            # generated read cases A / B / C / C′ / C″
      matrix.write.test.js      # family C write cases — re-seeds, never shares the base (D-19)
      tokens.js                 # signs JWTs for the 9 roles; 2 PARTNER accounts per campus (C′)
      .generated/routes.json
  jest.config.js                # projects: unit | api
```

### 6.7 Définition de terminé

- [ ] Aucune route déclarée en source n'est absente de `routes.json`, y compris celles montées
      sur `/api` nu. **Ne pas épingler le nombre 546** : il vient d'un `grep` de déclarations
      (§1), là où `routes.json` vient d'un parcours de la pile Express à l'exécution — les deux
      ne mesurent pas la même chose et ne coïncident que si chaque routeur est monté exactement
      une fois. Tout écart est acceptable ; un écart **non expliqué** ne l'est pas : chaque ligne
      d'écart est justifiée par écrit (routeur monté deux fois, déclaration morte, ligne commentée).
- [ ] Chaque entrée de `routes.json` porte son `allowedRoles`, par instrumentation de `role.js`
      ou par analyse de source (D-17) — sans quoi la famille B n'existe pas.
- [ ] Chaque route est **soit** couverte par la matrice, **soit** dans l'allowlist justifiée.
- [ ] Une route ni couverte ni déclarée fait **échouer** la suite — testé en ajoutant une route factice.
- [ ] Les cinq familles A, B, C, C′ et C″ s'exécutent en moins de 5 minutes.
- [ ] La famille C″ compare les identifiants renvoyés au jeu de fixture du campus appelant, sur
      **toutes** les routes de liste des collections scopées — pas sur un échantillon.
- [ ] La famille C′ dispose de deux comptes `PARTNER` par campus et vérifie le cloisonnement
      partenaire-à-partenaire sur les prospects **et** les commissions.
- [ ] Aucun cas d'écriture de la famille C ne modifie la base partagée (D-19) — vérifié en
      relançant la suite deux fois de suite et en comparant les résultats case par case.
- [ ] Un paramètre d'URL non déclaré dans `param-map.js` fait échouer la suite.
- [ ] La suite est **bloquante en CI**.
- [ ] Les échecs réels constatés lors du premier passage sont **tous** ouverts en tickets
      avant que la suite ne soit rendue bloquante — et corrigés ou explicitement dérogés.
- [ ] Le nombre d'échecs initiaux est consigné en §16 : c'est la mesure de la dette de
      sécurité au 2026-08-20, et elle a une valeur documentaire durable (**D-11**).

### 6.8 Pièges propres à ce dépôt

- **`?hard=true` est lu pour tous les rôles** et refusé par le registre quand le rôle n'est pas
  autorisé. La matrice doit vérifier le **refus**, et surtout qu'il ne se transforme pas en
  archivage silencieux rapporté comme un succès.
- **Les alias de compatibilité** (`/api/students/:id/permanent`, `/teachers`, `/staff`,
  `/mentors`, `/staff-roles/:id`, `/api/parents/:id?hard=true`, `/api/documents/:id?hard=true`)
  atteignent le même `execute()` et doivent porter le **même limiteur de débit**. La matrice
  doit les couvrir comme des routes de plein droit.
- **`/internal/ai`** n'est jamais publié par le proxy inverse. La matrice doit vérifier qu'il
  refuse un jeton utilisateur ordinaire et n'accepte qu'un jeton S2S.
- **Les limiteurs de débit** (`apiLimiter`, `strictLimiter`, `deletionLimiter` à 10/h,
  `loginLimiter`) vont **se déclencher** pendant une matrice de plusieurs milliers de requêtes
  et produire des `429` pris pour des échecs. Prévoir un interrupteur de test explicite, dont
  la désactivation en production est elle-même testée.
- **`express-mongo-sanitize`** est global : les charges utiles de test contenant `$` ou `.`
  sont réécrites avant d'atteindre le contrôleur.
- **Les services externes ne sont atteints que par la famille C**, et c'est suffisant pour casser
  la suite. A et B s'arrêtent au middleware ; C traverse le contrôleur, donc Puppeteer
  (`/api/print`, PDF de la GED), Cloudinary, les files `bullmq` de `gaet` et `public-portal`, et
  le store Redis du limiteur. Absents, ces services rendent `500` — un échec d'infrastructure qui
  se lit exactement comme un échec d'isolation, et qui sera classé comme tel par la personne qui
  triera le premier passage. Les déclarer au même rang que la base : fournis en CI, ou simulés au
  niveau du module. Jamais laissés au hasard.
- **`/api/ai` est inerte sans `AI_SERVICE_URL` et répond alors `503`.** La règle « jamais `200` »
  de la famille C est satisfaite par un `503`, ce qui rend la route **verte sans avoir rien
  testé**. Les deux états doivent donc être exécutés explicitement (§5.3), et l'état inerte
  compté comme non couvert plutôt que comme réussi.

### 6.9 Reste à faire

*Chantier non démarré.* Ce que CH-0 lui a déjà livré, au 2026-08-21, pour qu'il ne soit pas
réécrit :

- `tests/fixtures/seed.js` exporte **`startEphemeralDatabase()`** — un `MongoMemoryReplSet`
  (jeu de répliques, donc transactions du *hard delete* possibles) dont le `dbPath` est en
  tmpfs pour la raison mesurée en **D-25**. C'est le corps du `globalSetup` du §6.5 ;
- le **garde-fou accepte déjà l'URI éphémère** que ce `globalSetup` lui présentera : hôte de
  bouclage sur port éphémère + nom de base préfixé *ou* UUID. Le §4.4 demandait de le vérifier
  avant d'écrire la première ligne de CH-2 : c'est fait, et testé
  (`tests/unit/fixture-seed.test.js`) ;
- `tests/fixtures/exports.js` expose **`readAccounts()`** : `tokens.js` doit signer ses jetons
  depuis ce catalogue plutôt que redériver des identifiants, sinon un compte renommé casse en
  silence. Il porte les **2 comptes `PARTNER` par campus** de la famille C′, avec la liste de
  leurs prospects et commissions — l'oracle de C′ est donc déjà écrit ;
- `verify.js` expose **`CAMPUS_PATH`**, la correspondance modèle → champ de campus
  (`campusId` / `schoolCampus` / `campus`). `fixture-index.js` (§6.6) en a besoin pour la
  famille C″ et ne doit pas la redéclarer.

---

## §7 — CH-3 · Tests composant frontend

| | |
|---|---|
| **Couche** | 3 |
| **État** | `À FAIRE` |
| **Dépend de** | — (parallélisable dès aujourd'hui) |
| **Effort** | 2–3 semaines-développeur |
| **Brique** | `frontend/`, puis `partner/` |

### 7.1 Objectif

Fermer le plus grand angle mort du projet : **256 fichiers `.jsx`, zéro test, aucun outil
installé.** Le portail Next.js est dans le même état.

### 7.2 Pile retenue

| Outil | Rôle | Motif |
|---|---|---|
| **Vitest** | exécuteur | Partage la configuration Vite existante — pas de second pipeline de build à maintenir |
| **@testing-library/react** | rendu et interaction | Teste le comportement observable, pas l'implémentation |
| **@testing-library/user-event** | saisie | Simule une frappe réelle, pas un `fireEvent` synthétique |
| **MSW** | interception réseau | Simule l'API **au niveau HTTP** ; les mêmes gestionnaires resserviront à CH-4 |
| **jsdom** | environnement | Suffisant à cette couche |

> **Décision structurante** : les gestionnaires MSW sont dérivés de la table `routes.json`
> produite par CH-2. Une route qui change de forme casse les tests front — c'est précisément
> le mécanisme de contrat inter-briques exigé par R12 et par la section « Cross-brick tasks »
> de `CLAUDE.md`.
>
> **Cela crée une dépendance de mi-parcours à CH-2, et le §0 la mentionne désormais.** Elle ne
> bloque pas le démarrage : les trois premiers postes du §7.3 — schémas Yup, `useHardDelete`,
> services — ne touchent pas au réseau et s'écrivent dès aujourd'hui. Elle bloque en revanche
> tout ce qui monte un composant qui appelle l'API. Ordonnancez CH-3 en conséquence plutôt que
> de le découvrir au milieu du chantier.

### 7.3 Périmètre par ordre de valeur

1. **Schémas Yup** (`src/yupSchema/`) — purs, rapides, et **premiers en valeur** : ils doivent
   refléter exactement les énumérations du backend. Un test qui importe la liste attendue et
   la compare détecte immédiatement une dérive d'énumération, qui est le mode de rupture
   inter-briques le plus fréquent.
2. **`src/hooks/useHardDelete.js`** — porte la logique d'autorisation de suppression permanente
   pour les 15 entités. **Cinq cas, tous obligatoires** :
   1. `GET /danger-zone/entities` n'est lu **qu'une fois par identité connectée**, quel que soit
      le nombre de composants qui montent le hook ;
   2. le cache de module est clé par utilisateur **et** par rôle — un autre compte ne doit jamais
      hériter des permissions du précédent ;
   3. un échec de récupération donne un **catalogue vide**, sans nouvelle tentative à chaque
      montage ;
   4. `canDelete(isArchived)` renvoie `false` **par défaut pendant le chargement**, pour qu'un
      bouton de suppression permanente ne clignote jamais sur une ligne vivante ;
   5. `canDelete` applique `requireArchivedFirst` **tel que le registre le déclare**, jamais une
      règle réécrite dans le composant : c'est la régression qui avait rendu le bouton invisible
      pour `announcement` et `document` (DIRECTOR) et pour `staff-role` (CAMPUS_MANAGER).
3. **`src/services/`** — construction des requêtes, propagation de `campusId` en paramètre,
   traitement des erreurs, forme de réponse `{ success, message, data, meta }`.
4. **Composants partagés** — `HardDeleteDialog`, `HardDeleteAction`, `ImportDialog`,
   `GenericEntityPage`, tables paginées, sélecteurs de campus.
5. **Gardes de rôle et routage** — un `STUDENT` ne doit atteindre aucune route d'administration.
6. **Rendu i18n** — aucune clé manquante ; le sélecteur de langue bascule effectivement
   la direction du texte pour `ar`.

### 7.4 Arborescence

```
frontend/
  vitest.config.js
  src/
    test/
      setup.js               # jest-dom matchers, i18n test instance, theme wrapper
      render.jsx             # renderWithProviders: Router + Theme + i18n + QueryClient
      msw/
        handlers.js          # derived from backend tests/api-matrix/.generated/routes.json
        server.js
    **/__tests__/*.test.jsx  # colocated with the component under test
```

### 7.5 Définition de terminé

- [ ] `npm test` existe côté frontend et s'exécute en moins de 2 minutes.
- [ ] Tous les schémas Yup sont couverts, énumérations comparées à la source backend.
- [ ] `useHardDelete` couvert sur les **cinq** cas énumérés au §7.3, point 2, cache de module inclus.
- [ ] Un `renderWithProviders` unique — thème, i18n, routeur, contexte d'authentification —
      est utilisé partout ; aucun test ne remonte sa propre pile de fournisseurs (DRY, §0.1).
- [ ] MSW intercepte **tout** le réseau : un appel non simulé fait échouer le test au lieu
      de partir sur le réseau réel.
- [ ] La suite est bloquante en CI.
- [ ] Le portail `partner/` reçoit le même socle, au minimum sur le tunnel de pré-inscription
      et les liens courts `/r/{code}`.

### 7.6 Pièges propres à ce dépôt

- **MUI v7 + Emotion** : le rendu de test doit passer par le même `RtlProvider` et la même
  fabrique de thème que l'application, sinon les tests de thème sombre et de RTL valident
  un arbre qui n'existe pas en production.
- **i18next avec ICU** : l'instance de test doit charger le backend ICU, faute de quoi toute
  chaîne pluralisée rend brute et fausse les assertions de texte.
- **`framer-motion`** : neutraliser les animations dans le setup, sinon les tests deviennent
  dépendants du temps (R1).
- **Les énumérations sont mirrorées, pas dupliquées.** Si un test frontend redéclare une liste
  de statuts, il crée le second point de vérité que `CLAUDE.md` §0.1 interdit. Le test doit
  importer la liste depuis un module partagé, ou la lire depuis une ressource générée par le
  backend. Décision **D-08** — à trancher et consigner en §16.

### 7.7 Reste à faire

*Chantier non démarré. À renseigner par le premier intervenant.*

---

## §8 — CH-4 · End-to-end déterministe (Playwright)

| | |
|---|---|
| **Couche** | 4 |
| **État** | `À FAIRE` |
| **Dépend de** | CH-0 |
| **Bloque** | CH-5 |
| **Effort** | 2–3 semaines-développeur |
| **Brique** | dépôt dédié ou `frontend/e2e/` — voir §8.6 |

### 8.1 Objectif

Verrouiller **30 à 60 parcours canoniques**, un par rôle et par flux critique, exécutés en CI,
bloquants, déterministes. C'est le filet qui empêche une régression visible d'atteindre la
production — et c'est aussi la **destination** des specs produites par l'agent de CH-5.

### 8.2 Les parcours canoniques

Un parcours canonique est le chemin qu'un utilisateur de ce rôle emprunte le plus souvent, de la
connexion jusqu'à un résultat vérifiable. Le **socle obligatoire** ci-dessous en compte
**dix-sept** — un par ligne. Il ne suffit pas à la définition de terminé, qui en exige trente
(§8.7) : les treize restants viennent des flux secondaires de chaque rôle — finance, GED,
notifications, emploi du temps, examens — et des specs promues depuis CH-5 (R5). Le socle est ce
qu'on écrit d'abord, pas ce qu'on livre.

| Rôle | Parcours | Assertion terminale |
|---|---|---|
| ADMIN | Connexion → création de campus → attribution d'un plan | Le campus apparaît avec son plan |
| ADMIN | Import d'une cohorte d'étudiants → écran d'activation | `data.activations[]` listé, comptes en `pending` |
| ADMIN | Suppression permanente d'une entité archivée via la *danger zone* | Aperçu → phrase → mot de passe → motif → ligne au registre |
| DIRECTOR | Consultation multi-campus → analytique consolidée | Chiffres agrégés sur les deux campus |
| DIRECTOR | Corbeille des annonces → suppression permanente | Corbeille listée, action limitée à la suppression |
| CAMPUS_MANAGER | Création de classe → affectation d'enseignants → emploi du temps | Créneaux visibles côté enseignant |
| CAMPUS_MANAGER | **Tentative d'accès à une ressource du campus B** | Refus — jamais de données du campus B |
| TEACHER | Saisie de notes en lot → publication | Résultat visible côté étudiant, moyenne pondérée par coefficient |
| TEACHER | Appel de présence → tableau de bord | Le taux de présence n'est pas 0 % |
| STUDENT | Consultation des résultats → export du bulletin PDF | PDF produit, contenu conforme |
| STUDENT | Inscription à une session d'examen | Éligibilité correctement calculée — **piège historique, voir §8.5** |
| PARENT | Consultation d'un enfant, puis d'un second | Cloisonnement entre enfants respecté |
| MENTOR | Liste des étudiants suivis | Rattachement lu depuis `Student.mentor` |
| STAFF | Accès aux écrans autorisés par son `StaffRole` | Aucun écran hors périmètre |
| PARTNER | Connexion → mes prospects → mes commissions | Seuls ses propres prospects et commissions, jamais ceux d'un autre partenaire |
| Public | Pré-inscription depuis le portail → réception côté ERP | Dossier visible en back-office |
| Public | Lien court `/r/{code}` → attribution au partenaire | Attribution enregistrée une seule fois |

### 8.3 Règles de déterminisme

Sans ces cinq règles, la suite devient instable et sera désactivée en trois mois (R1) :

1. **Base réinitialisée** par le seed de CH-0 avant chaque exécution de la suite.
2. **Horloge figée** au moment du test, alignée sur la date d'ancrage de la fixture.
3. **Animations désactivées** (`prefers-reduced-motion`, `animations: 'disabled'` dans la
   configuration Playwright) — sinon les captures de référence sont instables.
4. **Sélecteurs `data-testid`**, jamais de sélection par texte visible. Le texte change avec
   la locale : une suite qui sélectionne par texte est une suite qui ne peut pas être exécutée
   dans les dix langues, c'est-à-dire exactement le besoin.
5. **Attentes explicites sur un état**, jamais de `waitForTimeout`.

### 8.4 Régression visuelle

`toHaveScreenshot()` de Playwright suffit et est gratuit. Périmètre raisonnable :

- **les 10 locales × 2 thèmes** sur un jeu réduit de **5 écrans denses** (tableau de bord,
  liste paginée, formulaire long, boîte de dialogue de suppression permanente, bulletin) ;
- soit **100 captures**, ce qui est tenable ; pas les 7 200 états du §1.2, ce qui ne l'est pas ;
- **sur Chromium seul.** Une référence visuelle est propre à son moteur : les rendus de police et
  d'antialiasing diffèrent entre Chromium, Firefox et WebKit, et couvrir les trois triplerait la
  ligne de base — 300 références à trier à la main — sans rien apprendre de plus sur le produit.
  Les trois moteurs restent utiles aux parcours **fonctionnels** du §8.2 ; ils ne le sont pas aux
  captures. Décision **D-20**.

Le reste des 180 contextes est traité par l'agent de CH-5, qui **juge** au lieu de comparer,
et n'a donc pas besoin d'une référence par contexte. **C'est la répartition du travail entre
CH-4 et CH-5 : CH-4 compare, CH-5 juge.**

### 8.5 Piège historique à couvrir en priorité

Ce parcours est cité parce qu'il correspond à un bug réel du projet : l'éligibilité aux examens
filtrait sur `currentClass` au lieu de `studentClass`, ce qui produisait **zéro étudiant
éligible**. L'écran s'affichait parfaitement — un état vide est plausible. Un test E2E qui
se contente de vérifier que la page se charge ne l'aurait pas vu. Le test doit assérir un
**nombre attendu issu de la fixture**, pas l'absence d'erreur.

> **C'est la règle générale des assertions E2E de ce projet : on assère une valeur attendue
> issue de la fixture, jamais l'absence de plantage.** Les bugs de cette plateforme rendent
> impeccablement.

### 8.6 Arborescence et décision d'emplacement

```
e2e/                              # dépôt dédié OU frontend/e2e/ — à trancher, D-05
  playwright.config.ts
  fixtures/
    accounts.ts                   # reads backend tests/fixtures/.generated/accounts.json
    auth.setup.ts                 # one storageState per role, reused across specs
  specs/
    admin/ director/ campus-manager/ teacher/ student/ parent/ mentor/ staff/ public/
  visual/
    locales.spec.ts               # 10 locales × 2 themes × 5 screens
  support/
    testids.ts                    # the data-testid contract, shared with the app
```

**Décision d'emplacement (D-05, à trancher).** Un dépôt dédié isole la suite des quatre briques
qu'elle traverse et évite d'attacher les tests inter-briques à l'une d'elles ; `frontend/e2e/`
est plus simple à démarrer. Les tests traversent le portail Next.js **et** l'ERP, ce qui plaide
pour le dépôt dédié — mais cela ajoute une cinquième brique à maintenir. Trancher avant d'écrire
la première spec, consigner en §16.

### 8.7 Définition de terminé

- [ ] 30 parcours minimum, couvrant les 9 rôles connectés et le portail public.
- [ ] Exécution complète en moins de 15 minutes en CI, en parallèle.
- [ ] Zéro `waitForTimeout` dans la base de code.
- [ ] Zéro sélecteur par texte visible.
- [ ] Le contrat `data-testid` est documenté dans `support/testids.ts` et **respecté par
      l'application** — ajouter un `data-testid` est un travail applicatif, pas un travail de test.
- [ ] Captures de référence produites pour 10 locales × 2 thèmes × 5 écrans, **sur Chromium seul** — 100 références exactement (D-20).
- [ ] Taux d'instabilité mesuré sur 10 exécutions consécutives : **< 1 %**.
- [ ] Suite bloquante en CI.

### 8.8 Reste à faire

*Chantier non démarré. À renseigner par le premier intervenant.*

---

## §9 — CH-5 · Agent IA exploratoire

| | |
|---|---|
| **Couche** | 5 |
| **État** | `À FAIRE` |
| **Dépend de** | CH-0 **et** CH-4 |
| **Effort** | 2–3 semaines-développeur |
| **Brique** | dépôt/dossier `qa-agent/` |

### 9.1 Objectif, formulé avec précision

L'agent a **une seule mission irremplaçable** : parcourir les **180 contextes
rôle × locale × thème** et **juger le rendu** — libellé non traduit, texte tronqué,
chevauchement en arabe RTL, contraste illisible en thème sombre, libellé allemand débordant
de son bouton, formulation incompréhensible pour un novice.

Ni un humain ni un Playwright scripté ne peuvent faire cela : l'humain n'en a pas le temps
(§1.2), et Playwright ne sait comparer que par rapport à une référence qu'il faudrait produire
et maintenir 180 fois.

**Mission secondaire, à haute valeur** : produire des **specs Playwright candidates** pour CH-4
(R4, R5).

### 9.2 Ce que l'agent ne peut pas faire — le problème de l'oracle

> **Objection décisive, à comprendre avant d'écrire une ligne de cet agent.**
> Un agent qui navigue détecte ce qui **casse**. Il ne détecte pas ce qui est **faux**.

L'historique d'audits de ce projet est presque entièrement composé de bugs de la seconde
catégorie :

| Bug réel du projet | Ce que voyait l'écran | Pourquoi l'agent ne le trouve pas |
|---|---|---|
| `exam-eligibility` filtrait sur `currentClass` au lieu de `studentClass` | 0 étudiant éligible | Un état vide est plausible |
| Totaux de présence comparant `status: 'present'` à un booléen | Tableaux de bord à 0 % | Un 0 % est un chiffre, pas une erreur |
| `{ isDeleted: false }` appliqué à `students` — champ inexistant | Liste affichée, simplement plus longue | Aucun signal visuel |
| Marqueur inexistant dans un `$match` d'agrégation finance | Total à 0 € | Un total de 0 se lit comme un chiffre |
| `{ status: { $ne: 'archived' } }` sur `announcements` | Annonces vivantes masquées, supprimées affichées | Faux **dans les deux sens**, sans erreur |

**Un agent navigateur aurait trouvé zéro de ces bugs. Ils rendent tous impeccablement.**

C'est la limite structurelle de l'approche et elle est irréductible. Elle se compense de deux
façons, et de deux seulement : les couches basses (CH-1, CH-2, CH-3), et l'**oracle métier**
fourni explicitement à l'agent (§9.4, amélioration n° 4).

### 9.3 Ce qui sort du périmètre — définitivement

| Demande initiale | Verdict | Où elle est traitée |
|---|---|---|
| Simuler des milliers d'utilisateurs simultanés | **Hors périmètre** — physiquement et économiquement impossible par le navigateur | CH-6, k6 (§10.2) |
| Relever les failles de sécurité de façon exhaustive | **Hors périmètre** — pas de garantie de couverture (R9) | CH-2 pour l'exhaustif, CH-6 pour le DAST |
| Relever les obstacles au passage à des millions d'utilisateurs | **Hors périmètre** — les bloqueurs sont architecturaux et invisibles depuis un navigateur | CH-7 (§11) |

L'agent conserve un rôle **opportuniste** sur la sécurité : ce qu'il trouve (jeton exposé,
route non protégée atteinte par manipulation d'URL) est un bonus, consigné comme tel, jamais
présenté comme une mesure de couverture.

### 9.4 Les douze améliorations qui rendent l'agent viable

Les quatre premières sont des **conditions de viabilité**, pas des raffinements. Un agent
livré sans elles sera abandonné en un mois.

| # | Amélioration | Détail d'implémentation |
|---|---|---|
| **1** | **Le seed avant l'agent** | Condition d'existence. Sans jeu figé, « 0 étudiant affiché » est indécidable. L'agent démarre par une vérification de la fixture et **refuse de s'exécuter** si `verify.js` échoue. |
| **2** | **L'agent écrit des tests, il ne les exécute pas** | Sa sortie principale est du **code Playwright** déposé dans `qa-agent/proposals/`. Vous validez, la spec rejoint CH-4 et tourne déterministe pour toujours. Résout d'un coup le non-déterminisme **et** le coût : chaque bug n'est payé au LLM qu'une seule fois. |
| **3** | **Séparer strictement exploration et régression** | Régression : déterministe, en CI, bloquante. Exploration : IA, nocturne, **jamais bloquante**. Les mélanger rend la CI ininterprétable et entraîne l'équipe à ignorer les échecs — la pire issue possible. |
| **4** | **Donner l'oracle métier à l'agent** | Un fichier d'invariants vérifiables issus de la fixture : moyenne pondérée attendue pour l'étudiant `STU-A-001`, nombre de cours du campus A, quota du plan, nombre d'étudiants éligibles à la session d'examen. Sans oracle explicite, l'agent ne détecte que les plantages — la moitié la moins intéressante des bugs. |
| **5** | **Lire le canal machine, pas seulement les pixels** | Erreurs console, requêtes 4xx/5xx, *error boundaries* React, avertissements React, temps de réponse. C'est là que se trouve l'essentiel de ce qu'un agent peut réellement trouver — et c'est **déterministe**, donc sans faux positif. À collecter systématiquement, indépendamment du jugement du modèle. |
| **6** | **Instrumenter le frontend pour lui** | `data-testid` sur les éléments critiques (contrat partagé avec CH-4) et un endpoint de version. Sans identifiants stables, l'agent s'accroche au texte visible et se casse à chaque changement de locale — précisément la dimension qu'il doit couvrir. |
| **7** | **Rejouer avant de déclarer** | Deux rejeux automatiques de tout échec. Non reproductible = instable, classé à part, jamais présenté comme un bug (R10). |
| **8** | **Un rapport diffable, pas joli** | JSON structuré, empreinte stable par constat, affichage de ce qui a **changé depuis la veille** (R11). Spécifié en §9.6. |
| **9** | **Mémoire des bugs déjà trouvés** | Tout bug confirmé devient une spec permanente en CH-4 (R5). Un registre `known-issues.json` empêche l'agent de re-signaler un problème ouvert et connu. |
| **10** | **Budget, minuterie, coupe-circuit** | Plafond de jetons par exécution, délai maximal par scénario, arrêt d'urgence, environnement dédié. **Jamais la production, jamais de vraies données personnelles** (R3). |
| **11** | **Sortir la charge du périmètre** | 3 à 5 navigateurs simultanés au maximum, uniquement pour mesurer le coût de rendu. Jamais pour simuler une foule (R8). |
| **12** | **Sortir la sécurité systématique du périmètre** | CH-2 et le DAST de CH-6 couvrent l'exhaustif. L'agent fait de la reconnaissance opportuniste (R9). |

### 9.5 Pile technique

| Option | Nature | Recommandation |
|---|---|---|
| **Stagehand** (Browserbase) | Open source TS — Playwright déterministe + `act()` / `extract()` / `observe()` en langage naturel | **Recommandé.** Le meilleur compromis : le squelette du parcours reste du Playwright lisible et débogable, seules les étapes de jugement passent par le modèle. Facilite directement l'amélioration n° 2. |
| **Playwright MCP** (Microsoft) | Open source — expose un navigateur à un LLM via MCP | Fondation la plus directe si l'on veut tout contrôler. Ne fournit ni fixtures, ni rapport, ni parc, ni répétabilité : c'est un pilote, pas une solution de QA. |
| **Browser Use** | Open source Python | Écosystème mature, mais conçu pour l'automatisation de tâches web, pas la QA de régression. Instable en usage répété. |
| **Claude / computer use** | API Anthropic | Excellent en jugement d'ergonomie et de rendu. Coût par jeton élevé sur des captures. À réserver à la passe de jugement, jamais au parcours. |

**Architecture recommandée — modèle « squelette déterministe, jugement IA ».**
Le parcours (connexion, navigation, changement de locale et de thème) est du **Playwright pur** :
il est reproductible, débogable et gratuit. Seule l'étape « regarde cet écran et dis ce qui ne
va pas » appelle le modèle. On obtient ainsi la couverture des 180 contextes avec un coût de
jetons proportionnel au nombre d'**écrans jugés**, et non au nombre d'**actions**.

### 9.6 Spécification du rapport

**Format machine** — `qa-agent/reports/<run-id>/findings.json`, un objet par constat :

```
{
  fingerprint,        // stable hash: route + context + finding type + normalized message
  severity,           // blocker | major | minor | cosmetic | advisory
  category,           // crash | console-error | http-error | i18n | layout | contrast
                      // | a11y | ergonomics | security-recon | oracle-mismatch
  context: { role, locale, theme, route, viewport },
  evidence: { screenshot, consoleLog, network, domSnippet },
  reproduced,         // replay count that confirmed it (improvement 7)
  proposedSpec,       // path to the generated Playwright spec, when applicable
  firstSeenRun, lastSeenRun
}
```

**Écran de restitution** — le tableau de bord demandé initialement. Exigences :

- **En tête : le diff.** `Nouveaux` / `Résolus` / `Persistants` par rapport à la veille.
  C'est la seule partie que quelqu'un lira tous les jours.
- Filtres par rôle, locale, thème, sévérité, catégorie.
- Une **matrice 9 × 10 × 2** en vue d'ensemble, colorée par sévérité maximale — c'est la
  représentation naturelle du problème du §1.2, et elle rend visible d'un coup d'œil qu'une
  locale ou un rôle entier est cassé.
- Preuve attachée à chaque constat : capture, journal console, trace réseau.
- **Constats instables présentés dans une section séparée**, jamais mélangés aux bugs.
- Export du lot de specs Playwright proposées.

> **Le rapport n'est pas le livrable de valeur : le diff l'est.** Un rapport qui repart de zéro
> chaque nuit produit 200 constats identiques et cesse d'être lu en deux semaines.

### 9.7 Budget et garde-fous

| Garde-fou | Valeur initiale | Motif |
|---|---|---|
| Plafond de jetons par exécution | à fixer au premier passage réel | Une exécution nocturne sur 180 contextes se chiffre en dizaines à centaines de dollars |
| Délai maximal par contexte | 5 min | Empêche une boucle d'exploration de consommer la nuit |
| Navigateurs simultanés | 3–5 | R8 |
| Environnement | dédié, jamais la production | R3 |
| Coupe-circuit | variable d'environnement + arrêt manuel | Un agent autonome doit pouvoir être stoppé sans redéploiement |
| Données | synthétiques uniquement | R3 — un agent parcourant de vrais dossiers étudiants est un incident RGPD |

**Coût de possession à ne pas sous-estimer.** L'agent n'est pas un projet livrable une fois.
Il faut le budget de jetons, l'environnement dédié, le parc de navigateurs, et surtout
**quelqu'un qui lit le diff chaque matin**. Comptez cette charge humaine récurrente dans la
décision d'exploitation ; un rapport que personne ne lit est un coût pur.

### 9.8 Arborescence

```
qa-agent/
  package.json
  config/
    contexts.js          # the 9 x 10 x 2 matrix, with an optional subset for quick runs
    oracle.js            # business invariants derived from the fixture (improvement 4)
    budget.js            # token cap, timeouts, concurrency, kill switch
  runner/
    journey.js           # deterministic Playwright skeleton: login, navigate, switch locale/theme
    judge.js             # the single LLM call per screen
    machine-channel.js   # console, network, error boundaries (improvement 5) — no LLM
    replay.js            # two automatic replays (improvement 7)
    spec-writer.js       # emits Playwright candidates (improvement 2)
  known-issues.json      # open and acknowledged issues (improvement 9)
  reports/<run-id>/
  proposals/             # generated Playwright specs awaiting human review
  dashboard/             # the reporting screen
```

### 9.9 Définition de terminé

- [ ] L'agent refuse de démarrer si `verify.js` de CH-0 échoue.
- [ ] Les 180 contextes sont parcourus en une exécution nocturne, dans le budget fixé.
- [ ] Le canal machine (§9.4, n° 5) est collecté **indépendamment** du modèle.
- [ ] Tout échec est rejoué deux fois avant d'être déclaré.
- [ ] Le rapport affiche le diff par rapport à l'exécution précédente en première position.
- [ ] Au moins une spec Playwright générée a été validée et intégrée à CH-4.
- [ ] `known-issues.json` supprime effectivement les re-signalements.
- [ ] L'agent **n'est pas** dans le *gate* CI.
- [ ] Le coût réel d'une exécution complète est mesuré et consigné en §16 (**D-10**).
- [ ] Le taux de faux positifs est mesuré sur la première semaine et consigné. **S'il dépasse
      30 % après réglage, le chantier est réévalué** — c'est le seuil au-delà duquel le triage
      coûte plus cher que le test manuel qu'il remplace.

### 9.10 Reste à faire

*Chantier non démarré. À renseigner par le premier intervenant.*

---

## §10 — CH-6 · Charge, performance, sécurité, accessibilité

| | |
|---|---|
| **Couche** | 6 |
| **État** | `À FAIRE` |
| **Dépend de** | CH-0 (et, pour ZAP et k6, la table `routes.json` de CH-2) |
| **Effort** | 2 semaines-développeur |
| **Brique** | transverse |

### 10.1 Quatre disciplines, quatre outils

Ces quatre besoins figuraient dans la demande initiale adressée à l'agent. Ils en sortent tous,
pour la même raison : chacun a un outil dédié qui fait le travail infiniment mieux, moins cher
et de façon déterministe.

| Discipline | Outil | Ce qu'il produit |
|---|---|---|
| **Charge** | **k6** (Grafana) | Scénarios en JavaScript, seuils, métriques Prometheus — s'aligne sur l'observabilité déjà en place côté `ai-service` |
| **Performance client** | **Lighthouse CI** | Poids du bundle, LCP, INP, budgets de performance bloquants en CI |
| **Sécurité dynamique** | **OWASP ZAP** | DAST automatisable, rejoue une spec d'API authentifiée |
| **Sécurité statique** | **Semgrep** + **Snyk** | Classes entières de failles qu'aucun navigateur ne verra, et les dépendances |
| **Accessibilité** | **axe-core** / **Pa11y** | Contraste, libellés, focus, ARIA — objectif, déterministe, gratuit, exécutable sur les 180 contextes |

> **`axe-core` mérite une mention particulière.** Une grande partie de ce que la demande
> initiale confiait au jugement du modèle — « noter l'ergonomie », « le contraste est-il
> lisible » — est **mesurable objectivement et gratuitement**. Faites passer axe-core sur les
> 180 contextes : ce qui reste après est le vrai périmètre de jugement de CH-5, et il est bien
> plus petit qu'il n'y paraît.

### 10.2 Pourquoi la simulation de milliers d'utilisateurs sort du navigateur

Chiffrage à conserver dans le document, parce que la question reviendra :

| Approche | RAM | CPU | Coût LLM par exécution | Verdict |
|---|---|---|---|---|
| 1 000 Chromium pilotés par LLM | 150–400 Go | 200–1 000 vCPU | ~2 000–20 000 $ | **Exclu** |
| 1 000 Chromium scriptés, sans LLM | 150–400 Go | 200–1 000 vCPU | 0 $ | Ruineux |
| **k6 au niveau protocolaire** | **< 4 Go** | **2–4 vCPU** | **0 $** | **La réponse** |

Un seul nœud k6 tient **10 000 à 40 000 utilisateurs virtuels** contre les 546 routes HTTP.
Le navigateur sert à mesurer le coût de rendu client sur **1 à 5 sessions**, jamais mille.

> Confondre test fonctionnel et test de charge dans un seul outil était le défaut de conception
> principal de la proposition initiale. C'est corrigé par la séparation CH-5 / CH-6.

### 10.3 Spécification du plan de charge

- **Scénarios** dérivés de `routes.json` (CH-2), pondérés par le trafic attendu : lecture de
  tableaux de bord et de listes en volume, écritures en minorité.
- **Profils** : montée en charge, palier soutenu, pic, et **test d'endurance** (plusieurs heures)
  — ce dernier est le seul qui révèle les fuites mémoire et la saturation du pool Puppeteer.
- **Seuils** déclarés dans le script, avec échec de l'exécution en cas de dépassement.
- **Volumétrie réaliste** : la fixture de CH-0 est faite pour la lisibilité, pas pour la charge.
  Prévoir un **second jeu de données volumineux** (des dizaines de milliers d'étudiants sur un
  campus) : c'est le seul moyen de révéler les requêtes non couvertes par un index.
- **Mesure obligatoire** : la charge doit être exécutée **sur au moins deux instances** de
  l'API derrière un répartiteur. C'est la configuration qui révèle les défauts de CH-7.

### 10.4 Spécification du volet sécurité

- **ZAP en CI**, alimenté par `routes.json` et par un jeton de chaque rôle.
- **Semgrep** sur le dépôt, avec un jeu de règles adapté à Express et Mongoose.
- **Snyk** ou `npm audit` sur les dépendances, en échec bloquant à partir d'une sévérité définie.
- **Rappel** : l'exhaustivité sur l'isolation campus vient de **CH-2**, pas de ZAP. ZAP ne
  comprend pas la logique de tenant de cette plateforme et ne la comprendra jamais.

### 10.5 Définition de terminé

- [ ] Un plan k6 couvrant les 10 routes les plus sollicitées, avec seuils.
- [ ] Un test d'endurance de plusieurs heures exécuté au moins une fois, résultats consignés.
- [ ] Charge exécutée sur ≥ 2 instances derrière un répartiteur.
- [ ] Lighthouse CI avec budgets bloquants sur les 5 écrans denses de CH-4.
- [ ] axe-core exécuté sur les 180 contextes ; violations classées et priorisées.
- [ ] ZAP intégré à la CI, alimenté par `routes.json`.
- [ ] Semgrep et l'audit de dépendances intégrés, seuil de blocage défini et consigné.

### 10.6 Reste à faire

*Chantier non démarré. À renseigner par le premier intervenant.*

---

## §11 — CH-7 · Revue d'architecture pour le passage à l'échelle

| | |
|---|---|
| **Couche** | transverse |
| **État** | `À FAIRE` |
| **Dépend de** | — (parallélisable dès aujourd'hui) |
| **Effort** | 1 semaine |
| **Brique** | `backend/` principalement |

### 11.1 Pourquoi ce chantier existe

La demande initiale confiait à l'agent la mission de « relever les obstacles à une production
de masse ». **Aucun agent navigateur ne peut le faire.** Ces obstacles sont architecturaux,
silencieux, et n'ont aucune manifestation visible dans une page.

Démonstration, trouvée en trois minutes de lecture de code.

### 11.2 Constat n° 1 — les crons ne survivent pas à la mise à l'échelle horizontale

`server.js` enregistre les sept tâches planifiées **directement dans le processus applicatif**,
via `registerJobs(cron, projectJobs(), { timezone: CRON_TIMEZONE })`, **sans élection de leader
ni garde d'instance** — aucune trace de `LEADER`, `INSTANCE`, `CRON_ENABLED` ou de verrou
distribué dans le fichier.

Sur une instance unique, tout va bien. Le jour où l'on passe à trois répliques derrière un
répartiteur — c'est-à-dire **le jour même du passage à l'échelle** — chaque cron se déclenche
trois fois :

| Cron | Conséquence à 3 répliques |
|---|---|
| Nightly 06:00 — frais impayés + relances | **Trois relances envoyées aux mêmes familles** |
| 1er du mois 00:05 — clôture des concours | Triple clôture |
| Sun 02:00 — rétention documentaire | Triple passe de suppression |
| Nightly 01:00 — expiration des annonces | Triple écriture |
| Nightly 03:00 — anti-triche examens | Triple analyse |
| Toutes les 10 min — relance des notifications | Triple envoi externe |
| Toutes les 2 min — balayage de la file d'impression | Concurrence sur la revendication de tâches |

La demi-bonne nouvelle : le limiteur de débit **sait** utiliser un store Redis partagé
(`rate-limit-redis` + `ioredis`, `shared/middleware/rate-limiter.js:32`) — mais **seulement si
`REDIS_URL` est défini**. Le code dit exactement ceci :
`let makeStore = () => undefined; if (process.env.REDIS_URL) { … }`. Sans la variable, chaque
réplique retombe silencieusement sur sa `MemoryStore` locale.

La brique de coordination distribuée existe donc dans le projet, et le correctif des crons peut
s'appuyer dessus — mais son activation n'est pas garantie, et c'est un **second** défaut de mise
à l'échelle, pas seulement la solution du premier. Il est instruit au point 9 du §11.3.

> **Le triple envoi de relances de paiement à de vraies familles est un incident de réputation,
> pas un bug technique.** Sur un marché international, c'est le genre de défaut qui coûte un
> client institutionnel entier. Ce constat justifie à lui seul CH-7.

### 11.3 Points à instruire

Ce chantier n'est pas limité au constat ci-dessus. À instruire, chacun méritant sa propre
conclusion écrite :

| # | Point | Question à trancher |
|---|---|---|
| 1 | **Crons multi-instance** | Élection de leader, verrou Redis, ou ordonnanceur externe ? |
| 2 | **Pool Puppeteer sur le processus API** | La génération PDF est CPU-intensive et cohabite avec l'API : quel effet sur le p99 sous charge ? Faut-il l'isoler ? |
| 3 | **Worker CPU de GAET** | Thread isolé aujourd'hui ; tient-il à N répliques, et la reprise des zombies au démarrage se comporte-t-elle correctement à plusieurs instances ? |
| 4 | **Couverture d'index sous `campusId`** | Chaque requête scopée porte `campusId` : les index composés couvrent-ils les schémas de requête réels ? À vérifier avec le jeu volumineux de §10.3. |
| 5 | **Stockage des fichiers GED** | Disque local ou objet ? Un stockage local est incompatible avec plusieurs répliques, et la suppression de fichiers du système de `hard delete` ne trouverait pas les fichiers écrits par les autres instances. |
| 6 | **Cache mémoire de branding** | `academic-pdf.service.js:148` maintient un `Map` par campus dans le processus, avec un TTL de 10 min. Le TTL borne la divergence au lieu de la rendre permanente, mais à N répliques un changement de logo reste visible sur l'une et pas sur l'autre pendant ce délai — et un PDF officiel est un document daté. Invalidation explicite à instruire, ou acceptation motivée du délai. |
| 7 | **Files d'attente** | `bullmq` est **déjà utilisé** par `modules/gaet/gaet.queue.js` et `modules/public-portal/public-portal.queue.js`, donc une infrastructure Redis de file existe déjà dans le projet. Pourquoi les sept tâches planifiées restent-elles sur `node-cron` en processus ? Le correctif du point 1 peut réutiliser cette infrastructure plutôt qu'en introduire une nouvelle. |
| 8 | **Transactions et cascade de *hard delete*** | Le plafond `MAX_CASCADE_DOCUMENTS` (5 000) et la durée de vie de 60 s d'une transaction tiennent-ils sur un tenant de très grande taille ? |
| 9 | **Limiteurs de débit non partagés par défaut** | `shared/middleware/rate-limiter.js` ne bascule sur Redis que si `REDIS_URL` est défini ; sinon chaque réplique compte pour elle seule. À 3 répliques, `deletionLimiter` passe de 10/h à 30/h **sur la *danger zone***, `loginLimiter` triple d'autant, et le budget 3/h de `strictLimiter` — partagé par GAET, admin et partner — devient 9/h. Faut-il refuser le démarrage en production sans `REDIS_URL`, plutôt que de dégrader en silence ? |

### 11.4 Définition de terminé

- [ ] Chacun des 9 points a une conclusion écrite : « conforme », « à corriger — ticket X »
      ou « accepté comme limite connue — motif ».
- [ ] Le point 1 (crons) a un correctif spécifié, même s'il n'est pas encore implémenté.
- [ ] Les conclusions sont consignées ici et résumées en §16.

### 11.5 Reste à faire

*Chantier non démarré. À renseigner par le premier intervenant.*

---

## §12 — Gouvernance : intégration continue, cadence, propriété

### 12.1 Ce qui bloque et ce qui ne bloque pas

| Suite | Déclenchement | Bloquant | Durée cible |
|---|---|---|---|
| Lint (4 briques) | chaque *push* | **oui** | < 1 min |
| CH-1 — unitaire backend | chaque *push* | **oui** | < 2 min |
| CH-3 — composant frontend | chaque *push* | **oui** | < 2 min |
| CH-2 — matrice API | chaque *pull request* | **oui** | < 5 min |
| CH-4 — E2E déterministe | chaque *pull request* vers `main` | **oui** | < 15 min |
| CH-6 — Lighthouse, axe, ZAP, Semgrep | nocturne + avant livraison | **non** — alerte | — |
| CH-6 — k6 charge | avant livraison + hebdomadaire | **non** — alerte | — |
| **CH-5 — agent IA** | **nocturne** | **non — jamais** | budget de la nuit |

> **La ligne la plus importante du tableau est la dernière.** L'agent IA ne bloque jamais.
> C'est la règle R4, et c'est ce qui distingue ce dispositif d'un projet qui échouera.

### 12.2 Cadence humaine

| Rythme | Action | Qui |
|---|---|---|
| Quotidien | Lire **le diff** du rapport de l'agent — pas le rapport entier | Le développeur d'astreinte |
| Hebdomadaire | Trier les specs proposées par l'agent ; intégrer les retenues à CH-4 | Le responsable QA |
| Par livraison | Exécuter k6 et Lighthouse ; comparer aux seuils | Le responsable technique |
| Mensuel | Revoir le taux de faux positifs de l'agent et son coût réel | Le responsable technique |
| Trimestriel | Relire §1 avec des chiffres re-mesurés ; mettre à jour §0 | Le responsable technique |

### 12.3 Propriété

Chaque chantier a **un** intervenant à la fois, nommé au §0. Deux personnes sur le même chantier
sans se coordonner produisent deux socles concurrents — c'est le mode d'échec typique d'un
dispositif de test bâti par relais.

**Qui prononce qu'un chantier est terminé.** Ce n'est **jamais** l'intervenant lui-même. La
définition de terminé de chaque chantier est vérifiée par une **seconde personne**, qui coche
les cases au §0 et signe la ligne. Motif : toutes ces définitions contiennent des critères
qu'on ne peut pas s'auto-appliquer honnêtement — « zéro `waitForTimeout` », « un intervenant
qui n'a jamais vu le projet obtient une base peuplée en une commande », « le taux d'instabilité
est inférieur à 1 % ». Une auto-validation sur ces critères est une auto-évaluation, pas une
recette.

À défaut d'une seconde personne disponible, le chantier reste `EN COURS` avec la mention
`en attente de recette` — jamais `EN PLACE`. Un chantier déclaré terminé et qui ne l'est pas
est pire qu'un chantier ouvert : les couches supérieures s'appuient dessus.

---

## §13 — Ce que ce dispositif ne couvrira jamais

Déclaré explicitement, pour que personne ne s'appuie sur une garantie qui n'existe pas.

1. **La justesse métier non spécifiée.** Un calcul faux dont personne n'a écrit le résultat
   attendu passera toutes les couches. La seule parade est l'oracle explicite (§9.4, n° 4) et
   la revue humaine des règles de gestion.
2. **L'ergonomie réelle.** Le jugement de CH-5 est une opinion de modèle : directionnelle,
   non reproductible, **non opposable** à un vrai test utilisateur. Un test avec cinq vrais
   utilisateurs novices reste irremplaçable avant un lancement international.
3. **La sécurité offensive avancée.** Chaînage d'exploits, logique métier détournée,
   escalade multi-étapes : cela demande un audit humain (Burp Suite, pentest externe).
   ZAP et CH-2 couvrent le systématique, pas le créatif.
4. **Le comportement sous panne partielle.** Redis indisponible, Mongo en bascule, Cloudinary
   en erreur, `ai-service` muet : c'est de l'ingénierie du chaos, hors périmètre ici, et
   à ouvrir comme chantier distinct avant un déploiement à grande échelle.
5. **La conformité réglementaire.** RGPD, hébergement, rétention, portabilité, droit à
   l'effacement : juridique et architectural, pas testable automatiquement.
6. **La compatibilité navigateurs anciens et les vrais appareils mobiles.** Playwright couvre
   Chromium, Firefox et WebKit récents. Un parc de vrais appareils est un service séparé.

---

## §14 — Annexe A · Panorama du marché

> Tarifs et fonctionnalités évoluent vite. **Ce relevé date d'août 2026 et doit être revérifié
> avant tout engagement commercial.**

**Lecture d'ensemble** : aucun produit ne couvre à lui seul le besoin exprimé, parce que le
besoin exprimé mélange cinq disciplines. Plusieurs produits en retirent en revanche des
morceaux entiers — la charge, la sécurité systématique, l'accessibilité. Ce qui reste après
ces soustractions est exactement le périmètre de CH-5.

### A.1 — Agents IA navigateur, briques à assembler

| Outil | Modèle | Ce qu'il résout | Sa limite ici |
|---|---|---|---|
| **Playwright MCP** | OSS, Microsoft | Expose un navigateur à n'importe quel LLM via MCP | Ni fixtures, ni rapport, ni parc, ni répétabilité. Un pilote, pas une solution de QA |
| **Stagehand** | OSS, Browserbase | Playwright déterministe + langage naturel. **Recommandé pour CH-5** | Exige quand même la fixture et l'oracle |
| **Browser Use** | OSS Python | Agent autonome mature | Pensé pour l'automatisation de tâches, pas la QA de régression |
| **Claude / computer use** | API Anthropic | Pilotage visuel, très bon en jugement de rendu | Coût par jeton élevé sur les captures |
| **Browserbase** | SaaS | Parc de navigateurs headless managé | Résout le scaling des sessions, pas le coût LLM ni l'oracle |

### A.2 — QA autonome commerciale, clé en main

| Outil | Modèle | Ce qu'il résout | Sa limite ici |
|---|---|---|---|
| **Mabl** | SaaS | Création low-code, auto-réparation des sélecteurs, exécution cloud | Tarif par test et par siège ; pensé pour une équipe QA. Format propriétaire |
| **Testim** (Tricentis) | SaaS | Sélecteurs assistés par IA, robustes aux refontes d'UI | Même modèle économique, même enfermement |
| **Functionize** | SaaS | Automatisation assistée par ML | Idem |
| **testRigor** | SaaS | Tests écrits en anglais courant — le plus proche de l'intuition initiale | La spécification en langue naturelle devient elle-même une dette quand la logique métier est fine |
| **QA Wolf** | Service managé | Humains + IA écrivent et **maintiennent** vos Playwright, avec engagement de couverture | Le plus cher. Pertinent quand le produit est stabilisé, pas en pleine construction |
| **Meticulous** | SaaS | Enregistre le trafic réel, génère la régression visuelle sans écrire de test | Exige du trafic réel — **inapplicable avant la mise en production** |

### A.3 — Régression visuelle : la matrice 10 locales × 2 thèmes

| Outil | Modèle | Ce qu'il résout | Sa limite ici |
|---|---|---|---|
| **Applitools Eyes** | SaaS | IA visuelle : troncatures, débordements, casse RTL. Le plus pertinent pour les 180 contextes | Payant à l'image ; exige un rendu stabilisé |
| **Percy** (BrowserStack), **Chromatic** | SaaS | Diff visuel intégré à la CI | Signale les différences, ne les qualifie pas |
| **`toHaveScreenshot()`** | Inclus dans Playwright | Gratuit, suffisant si données, polices et animations sont figées. **Retenu pour CH-4** | Aucune intelligence : tout diff est à trier à la main |

### A.4 — Charge

| Outil | Modèle | Note |
|---|---|---|
| **k6** (Grafana) | OSS + cloud | **Retenu pour CH-6.** Scénarios JS, seuils, métriques Prometheus alignées sur l'observabilité existante |
| **Gatling · Locust · Artillery · JMeter** | OSS | Alternatives équivalentes selon la langue de l'équipe |
| **Lighthouse CI** | OSS, Google | Le versant client : bundle, LCP, INP, budgets en CI. **Retenu** |

### A.5 — Sécurité

| Outil | Modèle | Note |
|---|---|---|
| **OWASP ZAP** | OSS | **Retenu pour CH-6.** Ne comprend pas la logique d'isolation campus — à compléter par CH-2 |
| **Burp Suite Pro** | Commercial | Référence du test offensif manuel. Outil d'expert, pas d'automate nocturne |
| **StackHawk · Escape** | SaaS | DAST orienté API ; couverture dépendante de la qualité de la spec fournie |
| **Semgrep · Snyk** | OSS + SaaS | **Retenus.** SAST et dépendances : classes de failles qu'aucun navigateur ne verra |
| **Nuclei** | OSS | Détection par signatures ; complément utile en infrastructure |

### A.6 — Accessibilité et surveillance de production

| Outil | Modèle | Note |
|---|---|---|
| **axe-core · Pa11y** | OSS | **Retenus.** Contraste, libellés, focus, ARIA : objectif, déterministe, gratuit |
| **Checkly · Datadog Synthetics** | SaaS | Rejouent des scénarios Playwright depuis plusieurs régions, en continu, sur la production. **À ouvrir après CH-4** — les specs sont réutilisables telles quelles |

---

## §15 — Annexe B · Checklist de reprise pour un nouvel intervenant

À dérouler par toute personne qui prend un chantier, dans l'ordre. Compter une demi-journée.

- [ ] Lire `CLAUDE.md` **en entier** — en particulier §0 (langue), §0.1 (DRY), §2 (isolation
      campus), §5.1 (soft delete), §5.2 (hard delete).
- [ ] Lire §0, §2 et §3 du présent document.
- [ ] Lire la section du chantier repris, **et celles des chantiers dont il dépend**.
- [ ] Lire §16, le journal des décisions, de bas en haut.
- [ ] Cloner les quatre briques aux chemins attendus ; noter que le portail est à
      `/home/adminsecu/Projects/partner`, **pas** sous `university/`.
- [ ] Faire tourner `npm test` sur le backend : la ligne de base doit être verte avant tout ajout.
- [ ] Faire tourner `npm run lint` sur les briques concernées.
- [ ] Vérifier que `docs/cours/` n'est **jamais** touché : c'est un dépôt git distinct imbriqué,
      avec sa propre histoire (`CLAUDE.md` §11bis).
- [ ] Inscrire son nom et la date sur la ligne du chantier au §0, avec l'état `EN COURS`.
- [ ] À l'interruption ou à l'achèvement : mettre à jour §0 et le bloc « Reste à faire ».

---

## §16 — Annexe C · Journal des décisions

> Une entrée par décision. **On n'écrase jamais une entrée** ; on en ajoute une nouvelle, datée,
> qui référence celle qu'elle révise.

| ID | Date | Décision | Motif | Statut |
|---|---|---|---|---|
| **D-01** | 2026-08-20 | L'agent IA de test **est adopté**, mais recadré à ~21 % de l'effort et placé en couche 5 | Posé au-dessus d'un frontend sans aucun test, il aurait noyé ses vraies trouvailles sous les faux positifs et cessé d'être lu en un mois | Tranché |
| **D-02** | 2026-08-20 | La simulation de milliers d'utilisateurs **sort du périmètre de l'agent** | Arithmétique du §10.2 : impossible physiquement et économiquement par le navigateur | Tranché |
| **D-03** | 2026-08-20 | La sécurité **systématique** sort du périmètre de l'agent, au profit d'une matrice générée (CH-2) | Exhaustivité, déterminisme, zéro faux positif, exécution en secondes | Tranché |
| **D-04** | 2026-08-20 | La sortie de valeur de l'agent est **du code Playwright**, pas un rapport | Résout simultanément le non-déterminisme et le coût : un bug n'est payé au LLM qu'une fois | Tranché |
| **D-05** | — | Emplacement de la suite E2E : dépôt dédié ou `frontend/e2e/` ? | Les tests traversent le portail **et** l'ERP | **À trancher avant CH-4** |
| **D-06** | — | Base de données de CH-2 : `mongodb-memory-server` en jeu de répliques, ou conteneur avec `--replSet` ? | Les transactions du *hard delete* exigent un jeu de répliques dans les deux cas | **À trancher avant CH-2** |
| **D-07** | 2026-08-20 | La convergence des **sept `getCampusFilter` divergents** vers `buildCampusFilter` est un chantier distinct, à mener **après** CH-2 | Refactoriser la frontière de sécurité sans filet est inacceptable ; la matrice est ce filet | Tranché — **révisé par D-16** (le décompte et la prémisse étaient faux) |
| **D-08** | — | Les énumérations partagées front/back : import depuis un module partagé, ou ressource générée par le backend ? | Interdiction de dupliquer un littéral (`CLAUDE.md` §0.1) | **À trancher pendant CH-3** |
| **D-09** | — | Seuil de blocage de l'audit de dépendances | — | **À trancher pendant CH-6** |
| **D-10** | — | Coût réel d'une exécution nocturne complète de l'agent | À mesurer au premier passage | **À mesurer pendant CH-5** |
| **D-11** | — | Nombre d'échecs au premier passage de la matrice CH-2 | Mesure documentaire de la dette de sécurité au démarrage | **À mesurer pendant CH-2** |
| **D-12** | 2026-08-20 | `PARTNER` est reconnu comme **9ᵉ rôle connecté** ; la matrice passe à 180 contextes et gagne une famille C′ d'isolation intra-campus | Rôle omis de la table d'isolation de `CLAUDE.md` §2 alors qu'il possède auth, jeton scopé campus et interface ERP complète. Révise la première rédaction de ce document, qui comptait 8 rôles | Tranché — **`CLAUDE.md` §2 corrigé le 2026-08-20** (rôle ajouté au tableau, avec sa règle d'isolation intra-campus) |
| **D-13** | 2026-08-20 | `ai-service` conserve sa suite Python propre ; aucun chantier d'ici ne la reprend. Seul le contrat `/api/ai` + `/internal/ai` est testé, depuis CH-2 | Éviter une double couverture non maintenue et une fausse impression de périmètre | Tranché — voir §5.3 |
| **D-14** | 2026-08-20 | La recette d'un chantier est prononcée par une **seconde personne**, jamais par son intervenant | Les définitions de terminé contiennent des critères non auto-applicables honnêtement | Tranché — voir §12.3 |
| **D-15** | 2026-08-20 | `Partner` et `GradingScale` sont **scopés campus**, sous le nom de champ `schoolCampus` ; seul `Course` est réellement global | Vérifié dans les schémas : `partner.model.js:84` déclare `schoolCampus` *required* sous un invariant d'isolation explicite et l'indexe quatre fois ; `grading-scale.model.js` impose l'unicité par campus et `getDefault(campusId)` filtre dessus ; le `campusId` du jeton `PARTNER` en est dérivé (`partner.auth.controller.js:49`). §4.3 et §4.8 disaient l'inverse et auraient fait échouer le seed sur un `required` | Tranché — **`CLAUDE.md` §5 corrigé le 2026-08-20** |
| **D-16** | 2026-08-20 | **Révise D-07.** Les huit `getCampusFilter` locaux **délèguent tous** à `buildCampusFilter` : leur harmonisation, et la déduplication des douze `isGlobalRole`, **n'ont pas à attendre CH-2** | D-07 supposait sept implémentations concurrentes de la frontière. Le relevé fichier par fichier montre huit adaptateurs de signature au-dessus d'un noyau unique : le risque du refactor est celui d'un renommage, pas d'une réécriture de la frontière de sécurité | Tranché — voir §1.3 |
| **D-17** | — | Rendre la famille B générable : instrumenter `shared/middleware/role.js` (`fn.allowedRoles = allowedRoles`), ou analyser la source des `*.routes.js` ? | Les rôles autorisés sont capturés dans une closure et invisibles depuis la pile Express : sans l'un des deux, la famille B n'existe pas. L'instrumentation est recommandée — l'analyse de source institue un second point de vérité sur les autorisations | **À trancher avant CH-2** |
| **D-18** | 2026-08-20 | La matrice CH-2 gagne une famille **C″** : routes de liste, jeton scopé, aucun identifiant d'un autre campus dans le corps | La fuite la plus probable n'est pas un accès à une ressource nommée mais un `GET` de collection au filtre oublié, qui répond `200` — vert dans les familles A/B/C, et sans signal visuel (§9.2). Sans C″, « la frontière est couverte » était un abus | Tranché — voir §6.4 |
| **D-19** | 2026-08-20 | Les cas **d'écriture** de la famille C s'exécutent dans un fichier dédié qui re-seede, jamais contre la base partagée | La famille C porte un rôle autorisé et atteint le code métier : sur un `POST`/`PUT`/`DELETE`, une isolation trouée **modifie la fixture** et rend les cas suivants dépendants de l'ordre. La suite deviendrait instable le jour où elle trouve un vrai bug — l'inverse de R1 | Tranché — voir §6.5 |
| **D-20** | 2026-08-20 | Les captures de référence de CH-4 sont produites sur **Chromium seul** — 100 références | Une référence visuelle est propre à son moteur de rendu ; les trois moteurs triplent la ligne de base sans rien apprendre de plus. Ils restent utilisés pour les parcours fonctionnels | Tranché — voir §8.4 |
| **D-21** | 2026-08-21 | `Level` est seedé **globalement** (5 niveaux), et non 3 + 2 comme l'annonce le tableau du §4.3 | `level.model.js` ne déclare aucun champ de campus, et `hard-delete.registry.js` déclare `campusPath: null` pour cette entité. Lui inventer un campus ferait passer un test d'isolation qui doit échouer — l'erreur exacte que D-15 corrige pour `Partner` et `GradingScale`, dans l'autre sens | Tranché — §4.3 à lire avec cette réserve |
| **D-22** | 2026-08-21 | Une classe de fixture n'a un gestionnaire que s'il reste un enseignant **vivant** non déjà gestionnaire ; au-delà, `classManager` reste `null` | `class.model.js` porte un index unique partiel sur `classManager` : un enseignant gère au plus une classe, à l'échelle de la plateforme. Campus A a 4 classes pour 2 enseignants vivants. Relevé au premier seed, par un `E11000` à la construction des index — pas par lecture du schéma | Tranché |
| **D-23** | 2026-08-21 | « dont 2 `isDeleted` » (ligne finance du §4.3) est lu comme **2 par collection** du campus A : 2 revenus, 2 dépenses, 2 frais de scolarité | La formulation est ambiguë et la lecture haute est la seule qui donne à chacune des trois collections une ligne supprimée à filtrer. Les volumes vivent dans `COUNTS` (`seed.config.js`), donc l'autre lecture est un changement d'une ligne | Tranché |
| **D-24** | 2026-08-21 | Le mot de passe de fixture est haché avec un **sel dérivé de la graine**, non tiré au hasard | bcrypt tire un sel par appel : le même mot de passe produit une empreinte différente à chaque exécution, et deux seeds consécutifs divergeaient alors sur **chaque document de compte**, en violation directe de l'idempotence du §4.4. Acceptable ici et seulement ici : ces identifiants sont publiés en clair dans `.generated/accounts.json`, et le garde-fou interdit au seed d'atteindre autre chose qu'une base de test locale | Tranché |
| **D-25** | 2026-08-21 | La base éphémère de `--ephemeral` (et, plus tard, du `globalSetup` de CH-2) stocke ses données sur **`/dev/shm`**, pas sur le disque | `mongodb-memory-server` écrit sur le système de fichiers ordinaire malgré son nom. Sur cette machine, la construction des index déclarés coûte **250 s depuis le disque et moins de 3 s depuis un tmpfs** : le budget de 60 s du §4.7 est inatteignable sur disque et confortable en mémoire. À reprendre dans **D-06** — un conteneur en CI doit monter son `dbPath` en tmpfs pour la même raison | Tranché — mesuré |
| **D-26** | 2026-08-21 | Le seed pilote lui-même la création des collections et des index (`autoIndex` et `autoCreate` désactivés) | Laissés actifs, Mongoose crée une collection par modèle compilé dès la connexion : la purge court alors contre ce que Mongoose construit, et la base finit un run avec ~25 collections vides qu'un second run ne recrée pas. Deux seeds, deux bases différentes — l'idempotence tombait sur un détail invisible depuis les données | Tranché |

---

## §17 — Annexe D · Glossaire

| Terme | Définition dans ce projet |
|---|---|
| **Brique** | L'un des quatre dépôts git de la plateforme : `backend`, `frontend`, `ai-service`, `partner` |
| **Contexte** | Un triplet rôle × locale × thème. Il en existe 180 |
| **Fixture** | Le jeu de données synthétique déterministe produit par CH-0 |
| **Oracle** | La connaissance de ce qui *devrait* se produire. Sans oracle, un test ne détecte que les plantages |
| **Parcours canonique** | Le chemin le plus fréquent d'un rôle, de la connexion à un résultat vérifiable |
| **Gate CI** | L'ensemble des suites dont l'échec bloque la fusion |
| **Instable (*flaky*)** | Un test dont le résultat varie sans changement de code. Traité à part, jamais comme un bug |
| **Canal machine** | Console, réseau, *error boundaries* — le signal déterministe qu'un agent collecte sans LLM |
| **Danger zone** | Le système unique de suppression permanente, monté sur `/api/danger-zone` |
| **Soft delete** | Suppression logique. **Trois conventions** coexistent — voir `CLAUDE.md` §5.1 |

---

## §18 — Mémoire du raisonnement : les quatre objections à ne pas réapprendre

Conservées ici pour qu'un futur intervenant ne refasse pas le débat depuis le début.

**1. Le problème de l'oracle** — l'objection décisive. Un agent qui navigue détecte ce qui casse,
pas ce qui est faux. Les bugs historiques de ce projet rendent tous impeccablement. Détail et
preuves en §9.2.

**2. Le non-déterminisme** — un LLM qui explore produit un parcours différent à chaque exécution.
Conséquences : impossible de bissecter une régression, impossible de bloquer une CI, et des faux
positifs (« le bouton ne répond pas » alors que l'agent n'avait pas fait défiler la page).
**Le triage de ces faux positifs peut coûter plus cher que le test manuel qu'il remplace** —
c'est le mode d'échec qui tue la majorité de ces projets. Remède : améliorations 2, 3 et 7 du §9.4.

**3. L'arithmétique de la charge** — §10.2. Le navigateur ne simule pas une foule.

**4. Le coût réel de possession** — l'agent n'est pas livrable une fois. Budget de jetons,
environnement dédié, parc de navigateurs, et **quelqu'un qui lit le diff chaque matin**.
Détail en §9.7.

---

## §19 — Ordre d'exécution recommandé et effet attendu

| Étape | Chantier | Effort | Gain immédiat |
|---|---|---|---|
| 1 | **CH-0** — fixture déterministe | 1 sem. | Un environnement de démonstration reproductible, utile bien au-delà des tests |
| 2 | **CH-2** — matrice API | 1–2 sem. | Toute la surface de routes couverte ou explicitement dérogée, la frontière de sécurité vérifiée à chaque commit |
| 3 | **CH-3** — composant frontend | 2–3 sem. | Le plus grand angle mort du projet commence à se fermer |
| 4 | **CH-4** — E2E déterministe | 2–3 sem. | Les régressions visibles ne repassent plus en production |
| 5 | **CH-5** — agent IA exploratoire | 2–3 sem. | Les 180 contextes enfin parcourus ; alimente CH-4 en specs |
| 6 | **CH-6** — charge, sécurité, accessibilité | 2 sem. | Chaque discipline traitée par son outil |
| — | **CH-7** — revue d'architecture | 1 sem. | Parallélisable dès aujourd'hui. Aucun agent ne trouvera ces points |

**Onze à quinze semaines-développeur** selon les bornes des estimations ci-dessus (**treize** au
point médian), dont deux à trois pour l'agent. C'est un **effort**, pas un délai — la confusion
des deux est ce que corrige la v1.2.

Le **délai** est celui du chemin critique déclaré au §0 — `CH-0 → CH-2 → CH-4 → CH-5`, soit
1 + (1–2) + (2–3) + (2–3) = **six à neuf semaines**. CH-3, CH-6 et CH-7 se mènent en parallèle et
n'allongent le délai que s'ils échoient au même intervenant. Autrement dit : à **deux
intervenants**, le dispositif complet tient dans les six à neuf semaines du chemin critique ; à
**un seul**, c'est le total de onze à quinze qu'il faut lire.

> **Si une seule chose peut être financée aujourd'hui, c'est `CH-0 + CH-2`** — deux à trois
> semaines, et les deux sont indissociables : la matrice consomme la fixture, que le §4.1 appelle
> sa condition d'existence. La matrice d'isolation campus offre le meilleur rapport risque évité /
> effort de toute la liste, et un défaut d'isolation entre établissements est le seul bug de ce
> projet capable de coûter le produit entier sur un marché international.

---

*Fin du document. Mise à jour obligatoire du §0 et du bloc « Reste à faire » du chantier
concerné à chaque commit qui touche ce dispositif.*
