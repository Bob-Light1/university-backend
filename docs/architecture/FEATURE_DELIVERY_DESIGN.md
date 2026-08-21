# Livraison de fonctionnalités sous licence — snapshot, paquets, runner client

> Rédigé le 2026-08-20. Document de **conception et de cadrage** : il décrit
> *quoi* construire, *comment*, *dans quel ordre*, et **sous quelle condition
> business**, pour vendre l'ERP sous forme de licence de code source à des
> établissements qui l'hébergent eux-mêmes, puis leur livrer à l'unité les
> fonctionnalités créées après leur achat — sans casser leur installation et
> sans jamais détenir d'accès à leur code ni à leurs données.
>
> **Public visé** : un développeur qui connaît ce backend (ou qui a lu
> `CLAUDE.md`) et reprend le chantier sans contexte de la discussion d'origine.
> Ce document est sa source de vérité.
>
> **Statut** : **conception — aucune phase livrée.** Six décisions porteur sont
> tranchées (§4), huit restent ouvertes (§23). Rien n'a encore été écrit dans le
> code : ce document précède la première ligne, volontairement.
>
> **Prérequis de lecture** : `CAMPUS_ENTITLEMENT_DESIGN.md` (le registre de
> modules dont tout ce chantier dérive) et `CLAUDE.md` §5.2 (le patron de porte
> dangereuse qu'on réutilise ici tel quel).
>
> **Révisions** : **v1.2 (2026-08-21)** — audit contradictoire, toutes les mesures
> re-relevées contre le code. **Un angle mort majeur comblé** : le couplage
> *runtime* entre modules (`mongoose.model()`, `ref:`, `populate()`), invisible au
> grep de §2.3, qui casse le build `free` — d'où la quatrième validation de §7.2 et
> la nouvelle §9.3. **Une sur-affirmation corrigée** (§7.2 : la clôture n'est pinnée
> que sur les arêtes *déclarées*). **Quatre sections manquantes rédigées** (§9.2,
> §9.3, §9.5, §9.6 — les deux tiers du cœur technique n'étaient qu'une ligne de
> tableau). **§9.1 requalifié de « Faible » à « Moyenne »** : le champ `routers` du
> registre n'est pas le chemin de montage, et `UNGATED_MOUNTS` n'y figure pas.
> **Trois contradictions levées** (§7.4×§11.4×§20.1 verrou npm, §6.2×§12.1 zone
> `plugins` non condensée, §13.2×§17.4 modèle de menace). **Cinq erreurs factuelles
> corrigées** (§6.3 liste ABI, §6.3 `getCampusFilter`, §6.3 `isGlobalRole`, §8
> `abiUsed`, `startSession()` 13→11, portails 9→10). Charge **recalibrée de ~54 à
> ~62 jours** (§20). v1.1 (2026-08-20) — audit du document par son auteur : erreur
> factuelle §7.2, trois contradictions (§9.A, §14.5, §17.4), six manques (§7.3,
> §7.4, §11.4, §13.2, §13.3, §16.7), charge 34 → ~54 j, tensions §1.2.
> v1 (2026-08-20) — conception initiale. Toutes les mesures de code citées ont été
> relevées sur `fix/remediation-g3` et sont datées à l'endroit où elles servent
> d'argument.

---

## 0. TL;DR (résumé exécutif)

**Ce chantier ne consiste pas à écrire un agent IA. Il consiste à rendre une
fonctionnalité *emballable*.** Tant qu'une fonctionnalité n'est pas un artefact
autonome, versionné, signé et testable, l'agent le plus compétent n'a rien de
propre à transporter — et « il adaptera le code » n'est pas une conception, c'est
un espoir.

Le socle nécessaire existe déjà, en grande partie, pour une autre raison :

| Acquis mesuré le 2026-08-20 | Pourquoi il compte ici |
|---|---|
| **0** `require` perçant une façade de module (`modules/<a>/` → `modules/<b>/<fichier>`) sur **149** imports de façade | La frontière modulaire est réellement étanche *à la compilation*. Extraire un module est un problème de tuyauterie, pas de refactorisation. **C'est ce qui rend ce chantier faisable** — mais la frontière *runtime* ne l'est pas, voir §2.3 bis |
| `FEATURE_REGISTRY` : 26 clés, 32 montages, 7 crons, graphe `dependsOn` dérivé des modèles | Le catalogue de ce qui est vendable, avec ses dépendances, existe et est testé (`feature-registry.test.js`) |
| `mountEntitlementGates(app)` monte les gates **dérivées du registre** | La preuve qu'un montage piloté par déclaration fonctionne déjà en production |
| `register-jobs.js` charge les crons par **loader différé** | Un module absent coûte un cron, pas sept — exactement la propriété qu'exige un build taillé |
| Frontend : `feature:` déjà porté par chaque entrée de navigation, `useFeature()` comme seul lecteur | L'ancrage frontend d'un module existe ; il ne reste qu'à le rendre contributif |
| Patron de porte dangereuse : ticket HMAC + phrase + mot de passe + motif + registre append-only | Une installation est une opération dangereuse et irréversible. Le patron est écrit, testé, en production |

Et le manque le plus structurant, lui aussi mesuré : **237 commits, zéro tag git,
`package.json` figé à `1.0.0`.** Un modèle de licence avec mises à jour vendues à
l'unité exige un **contrat de plateforme versionné**. Aujourd'hui, rien ne permet
de dire à quelle version un client est, ni ce avec quoi un paquet est compatible.
C'est la première chose à construire, avant tout le reste.

Points structurants, détaillés plus bas :

- **Un seul code, deux modes de livraison** (§3.2). Le mode est une variable
  d'environnement et un build, jamais un fork produit.
- **Un extracteur unique** sert dans les deux sens : tailler un snapshot par
  palier, et empaqueter un module en plugin (§7). Deux mécanismes distincts
  divergeraient ; celui qui diverge est toujours celui qui livre du code faux.
- **La licence s'applique à l'installation, jamais à l'exécution** (§10). Le
  gate d'entitlement reste *fail-open* comme aujourd'hui — il n'a pas à devenir
  une serrure, et une licence illisible ne doit jamais éteindre l'ERP d'une
  université.
- **Le runner s'exécute chez le client** (§11). Vous ne détenez aucun accès à
  son code ni à sa base. C'est la seule forme cohérente avec ce que vous vendez.
- **Le registre doit d'abord être éclaté** en déclarations par module (§9.A).
  Sans cela, toute installation modifie un fichier du tronc et se déclasse
  elle-même — le dispositif s'auto-interdit à la première livraison.
- **Le graphe de dépendances déclaré est incomplet** (§2.3 bis). Mongoose
  résout des modèles *par nom*, à l'exécution : `mongoose.model('X')`, `ref:`,
  `populate()`. Le registre ne connaît pas ces arêtes, aucun test ne les pinne, et
  l'une d'elles casse déjà le palier `free`. **C'est le premier correctif à
  écrire**, avant l'extracteur qui en dépend.
- **Le frontend est un SPA construit** : installer un plugin impose de le
  **reconstruire** chez le client (§11.4). C'est l'étape la plus susceptible
  d'échouer, et celle qu'on oublie.
- **Les bords sont le chantier** : migrations expand-only, i18n × 10 locales,
  crons, navigation, désinstallation, prérequis d'exploitation (§14, §16, §18).

Charge estimée : **~54 jours** répartis en 8 phases (§20), pour un développeur
qui connaît ce dépôt. Les phases 0 à 2 sont livrables seules et ont une valeur
propre, même si le reste est abandonné — et si le budget ne suit pas, le repli
est de s'arrêter là, jamais de rogner sur la porte ou sur la reconstruction.

---

## 1. Le modèle économique, énoncé sans ambiguïté

Le document décrit une machinerie technique ; elle n'a de sens que rapportée à ce
qui est vendu. Énoncé de référence, à corriger ici si le modèle bouge :

1. **L'établissement achète une licence du code source.** Il en devient
   propriétaire, l'héberge lui-même, et peut le modifier.
2. **Il n'achète pas la totalité du produit** mais un **palier** (§4, D-E) : le
   snapshot livré ne contient que les modules de ce palier.
3. **Toute fonctionnalité créée après son achat** — ou tout module d'un palier
   supérieur — **se vend à l'unité**, payante ou offerte, à sa cadence.
4. **Les données ne quittent jamais l'établissement.** C'est l'argument de vente
   n°1 sur le segment visé, et il contraint toute la conception : aucune étape du
   dispositif ne peut exiger que du code métier ou des données transitent chez le
   vendeur.
5. **Les correctifs de sécurité ne sont pas un produit.** Ils sont gratuits,
   prioritaires, et poussés à toute la flotte (§17.4). Un modèle de licence qui
   monnaie ses correctifs de sécurité est indéfendable, et le premier incident
   public le prouve.

### 1.1 Ce que la valeur ajoutée est réellement

L'argument « notre prix est inférieur au coût de production par une IA » est le
plus fragile du modèle et il vieillira mal : le coût de génération de code baisse
vite. **Ce n'est pas l'axe défendable.**

Ce qui ne se réplique pas d'un prompt, et qui est ce que le client paie :

- une fonctionnalité **spécifiée** et cohérente avec le modèle métier de l'ERP
  (58 modèles, des enums qui sont la source de vérité de trois clients) ;
- **testée** contre les schémas réels ;
- **traduite en 10 langues** (10 locales × 18 namespaces = 180 fichiers) ;
- **migrée** proprement, avec un chemin de retour ;
- **garantie** et maintenue sur une plage de versions annoncée.

Le document construit la machinerie qui rend cette promesse *vérifiable*. Une
promesse de fiabilité qu'on ne peut pas prouver n'a pas de prix.

### 1.2 Trois tensions du modèle qu'aucune technique ne résoudra

À dire une fois, clairement, pour qu'elles soient arbitrées plutôt que découvertes.

**T-1 · « Moins de développeurs » contre les prérequis d'exploitation.** La
plus-value n°5 promet au client de se passer d'une équipe interne. Le §18 exige
de lui : MongoDB **en replica set**, un stockage persistant vérifié, des
sauvegardes opérationnelles et testées, Node 20, Chromium, et — depuis §11.4 —
un hôte capable de reconstruire un frontend. **Ce n'est pas un établissement sans
compétence informatique qui tient cela.** Deux sorties honnêtes, à choisir :
un **critère de qualification client** (« vous devez disposer de tel niveau
d'exploitation »), ou une **offre d'infogérance** vendue à côté — qui réintroduit
un accès chez le client, à contractualiser séparément et à ne surtout pas
confondre avec le runner. Faire comme si la question ne se posait pas produira
des installations en échec attribuées au produit.

**T-2 · Le revenu récurrent contre la propriété du code.** Une fois la source
livrée, la fonctionnalité marginale ne se vend que tant que votre prix reste
inférieur au coût interne du client. C'est un vrai commerce, mais c'est un
commerce de **service**, pas une rente logicielle. Ce document ne le corrige pas
— il n'y a rien à corriger, c'est le modèle. Il faut simplement ne pas dépenser
de jours d'ingénierie à essayer de le rendre contraignant (§10.3, I-3).

**T-3 · Les deux modules les plus chers sont les deux moins installables.** `ai`
et `public-portal` sont au palier premium, donc supposés porter la marge — et ce
sont exactement ceux qui exigent des briques supplémentaires chez le client
(§16.4, §16.6). Vendre cher ce qui s'installe mal est la manière la plus rapide
de perdre la confiance du segment visé. D'où D-J : **ne pas les vendre
on-premise en V1**, et assumer que le catalogue premier soit plus modeste.

---

## 2. Contexte — ce que le code offre déjà (mesuré le 2026-08-20)

### 2.1 Le socle exploitable

| Brique | Emplacement | Ce qu'elle apporte à ce chantier |
|---|---|---|
| Registre de modules | `shared/constants/features.constants.js` | 26 clés · 9 `core` · 4 `minState: read_only` · 13 librement activables · 32 montages · 7 crons · `dependsOn` (arêtes dures, dérivées des modèles) · `usesWhenAvailable` (arêtes souples) · `PLAN_PRESETS` = free 15 / standard 22 / premium 26 |
| Gate dérivée | `shared/middleware/entitlement.js` | `mountEntitlementGates(app)` itère le registre et monte une gate par chemin. Aucun contrôleur ne sait que le système existe |
| Résolution + cache | `shared/lib/entitlement/` | `resolveForCampus()`, couches offre/usage, `DEFAULT_QUOTAS`, repli legacy |
| Consommation frontend | `EntitlementContext.jsx` + `useFeature()` | Le frontend ne réimplémente **aucune** règle ; chaque entrée de navigation porte déjà `feature: '<clé>'` |
| Crons isolés | `shared/lib/register-jobs.js` | `projectJobs()` : liste plate, un **loader différé** par job, une garde par enregistrement |
| Porte dangereuse | `shared/lib/hard-delete/` | `preview()` → ticket HMAC (TTL 300 s, lié à un condensé d'impact) → phrase → mot de passe → motif ≥ 10 car. → `DeletionAudit` append-only. Re-comptage **dans** la transaction |
| Suppression douce | `shared/utils/soft-delete.js` | Convention dérivée du modèle, jamais écrite à la main |

### 2.2 Les sept manques, mesurés

1. **Aucun versionnage produit.** 237 commits, **zéro tag**, `package.json` à
   `1.0.0`. Rien ne nomme la version d'une installation cliente.
2. **Aucune notion de « paquet ».** Une fonctionnalité est aujourd'hui un
   ensemble diffus : `modules/<clé>/`, une entrée de registre, 1 à 3 montages
   dans `app.js` (écrits à la main), 0 à 1 cron, une entrée dans le registre de
   suppression définitive, 0 à 1 script de migration, des pages frontend, un
   service, des entrées de navigation, un namespace i18n × 10 locales.
3. **Six listes écrites à la main** qu'un module doit aujourd'hui modifier pour
   exister (§9). C'est le cœur du travail d'ABI.
4. **Aucun harnais capable de valider une transplantation.** 62 tests unitaires
   backend, 3 d'intégration, 1 de contrat — mais `QA_TEST_STRATEGY.md` confirme
   CH-0 à CH-7 non démarrés : pas de fixture déterministe, pas de matrice API,
   pas d'E2E. Rien qui puisse dire « cette installation est saine » chez un
   client.
5. **Toute la cryptographie est symétrique** (`HS256`, `JWT_SECRET`). Une licence
   doit être vérifiable par le client **sans** détenir de quoi la forger : il
   faut une paire asymétrique, qui n'existe nulle part aujourd'hui.
6. **Deux hypothèses d'exploitation implicites** que le mode hébergé masque :
   **11 fichiers de production** utilisent `startSession()` (12 avec
   `tests/unit/document.repository.test.js`) — donc **MongoDB en replica set** est
   obligatoire, pas optionnel — et `assertPersistentStorage()` refuse de démarrer
   sans stockage persistant vérifié. Voir §18.
7. **Le graphe de dépendances du registre est incomplet.** Il ne décrit que les
   arêtes qu'un module *déclare*. Les arêtes que Mongoose résout par nom à
   l'exécution ne sont ni déclarées, ni testées, ni visibles au grep de §2.3 —
   et l'une d'elles rend le palier `free` non fonctionnel. Voir §2.3 bis.

### 2.3 La mesure qui décide de la faisabilité

```
grep -rnoE "require\('\.\./\.\./(<tous les modules>)/[a-zA-Z]" modules/  →  0
```

**Zéro `require` perçant une façade**, sur **149** imports inter-modules
(re-mesuré le 2026-08-21 à *toutes* les profondeurs, chemins résolus, et non par
le grep ci-dessus — qui est spécifique à une profondeur et ne prouve donc pas ce
qu'il annonce ; le conserver comme illustration, pas comme contrôle). Chaque
module ne parle aux autres que par `require('../../<module>')` →
`{ routes, service }`. Les couplages sortants d'un module se comptent : 5 à 7
fichiers `shared/` distincts pour les plus gros (`gaet` 5, `finance` 6,
`result` 6, `partner` 6, `exam` 7, `document` 7).

C'est ce qui autorise ce chantier. Sur une base au couplage habituel, extraire un
module serait un projet de refactorisation de plusieurs mois avant même de parler
de livraison. Ici la frontière est déjà là — elle n'est simplement pas encore
*déclarée* ni *outillée*.

### 2.3 bis La mesure qui ne décide de rien — et l'angle mort qu'elle cache

**Ajouté à l'audit du 2026-08-21. C'est le manque le plus grave du document, et
il invalidait la §7.2.**

Le grep de §2.3 mesure les `require`. Mongoose, lui, résout ses modèles **par
nom, à l'exécution**, par un registre global que le graphe d'imports ne voit pas.
Trois canaux, tous invisibles à §2.3 :

| Canal | Relevé le 2026-08-21 | Ce qui casse si la cible est absente |
|---|---|---|
| `mongoose.model('X')` | **10 appels, 7 fichiers** | `MissingSchemaError` levée à l'appel |
| `ref: 'X'` dans un schéma | **67 arêtes inter-modules** | `MissingSchemaError` au premier `populate()` |
| `.populate('champ')` | suit les `ref` | idem |

Ce sont de véritables arêtes de dépendance. Elles ne sont ni dans `dependsOn`, ni
dans `usesWhenAvailable`, ni pinnées par un test — **et deux d'entre elles
franchissent une frontière de palier** :

**A · `student` → `Mentor` — le palier `free` est cassé aujourd'hui.**

```
modules/student/student.repository.js:248   .populate('mentor', 'firstName lastName email')
modules/student/models/student.model.js:138 ref: 'Mentor'
```

`student` est **core, palier `free`**. Le modèle `Mentor` appartient au module
`mentor`, `minPlan: 'standard'` — **absent des 15 modules du palier `free`**. Et
`FEATURE_REGISTRY.student.usesWhenAvailable` vaut
`['exam','parent','result','settings']` : **`mentor` n'y figure pas**.

Un snapshot `free` taillé exactement comme §7 le décrit lève donc
`MissingSchemaError: Schema hasn't been registered for model "Mentor"` sur la
liste des étudiants — la route la plus utilisée du produit. Aucune des deux
validations que §7.2 annonçait ne l'attrape, parce que l'arête n'est pas déclarée.

**B · `campus` → `Document` — latent, mais dans un module `core`.**

```
modules/campus/campus.model.js:503   const Document = mongoose.model('Document');
```

Dans `canAddDocumentStorage()`, méthode de quota d'un module `core` présent dans
tous les paliers, visant un module `standard`. Aucun appelant aujourd'hui dans le
backend : le défaut est **dormant**, il se réveille au premier branchement du
quota de stockage. Les trois autres méthodes de quota du même fichier
(`canAddStudent`, `canAddTeacher`, `canAddClass`) visent des modules `core` et
sont sûres.

**Conséquences portées par le reste du document :**

1. §7.2 gagne une **quatrième validation obligatoire** — la seule qui attrape
   cette classe.
2. §9.3 (enregistrement des modèles) cesse d'être une ligne de tableau : c'est
   le mécanisme qui rend ces arêtes déclarables et vérifiables.
3. La **phase 0 bis** absorbe le correctif de registre : déclarer
   `mentor` dans `student.usesWhenAvailable`, déclarer `document` dans
   `campus.usesWhenAvailable`, et rendre `.populate('mentor')` conditionnel.
   C'est un travail de quelques heures **aujourd'hui**, et un incident client
   après la première livraison.

⚠️ **À ne pas mal lire.** Ceci ne remet pas en cause la faisabilité : les 149
imports de façade tiennent, la frontière statique est réelle. Ce qui est remis en
cause, c'est l'idée que **le registre décrit déjà le graphe**. Il décrit ce qu'on
a pensé à y écrire.

---

## 3. Décision d'architecture (ADR)

### 3.1 Problème

Vendre une licence de code source, puis continuer à vendre des fonctionnalités à
l'unité, pose trois problèmes simultanés que rien dans le dépôt n'adresse :

- **Le problème d'unité** : « une fonctionnalité » n'est pas un objet livrable.
- **Le problème de divergence** : le client modifie son code (c'est vendu comme
  tel), donc N installations divergent, et une fusion de branche vendeur doit
  réussir N fois sans CI ni tests côté client.
- **Le problème d'accès** : livrer chez le client suppose naïvement d'accéder à
  son code — ce qui contredit frontalement l'argument de souveraineté qui motive
  l'achat.

### 3.2 Décision retenue

> **Une fonctionnalité vendable est un *paquet* : un artefact autonome, signé,
> versionné contre un *contrat de plateforme* explicite, produit par le même
> extracteur qui taille les snapshots. Il est installé par un *runner* qui
> s'exécute exclusivement chez le client, derrière la porte dangereuse déjà en
> production. Le vendeur ne détient jamais d'accès au code ni aux données du
> client ; il publie un catalogue et des paquets signés.**

Trois invariants en découlent, à ne jamais violer :

**I-1 · Un seul code, deux modes de livraison.** Le mode hébergé (SaaS
multi-tenant) reste le modèle principal ; le mode licencié est une seconde offre
servie **par le même dépôt**. Le mode est un build et une variable
d'environnement, jamais un fork. Un fork produit se paie une fois à la création
et tous les jours ensuite.

**I-2 · L'agent n'est pas le système ; il est une couche au-dessus.** Le
dispositif doit fonctionner entièrement **sans agent**, à la main, avant qu'une
seule ligne d'agent soit écrite. Si le paquet, le manifeste, le contrat et le
runner sont corrects, l'agent devient une commodité d'ergonomie — il choisit un
niveau de livraison et rédige un rapport. S'ils sont incorrects, aucun agent ne
les sauve.

**I-3 · La licence ne verrouille pas, elle atteste.** Voir §10.3. Toute
conception qui repose sur l'idée qu'un client propriétaire du code ne peut pas
retirer un contrôle est fausse par construction. Le seul mécanisme qui tient est
que **le code non acheté n'est pas dans son arbre**.

### 3.3 Alternatives écartées

| Alternative | Verdict | Motif |
|---|---|---|
| **Agent côté vendeur avec accès en écriture au dépôt client** (le schéma d'origine) | Écarté (D-B) | Vous devenez dépositaire d'accès en écriture sur N codebases d'établissements : vecteur de chaîne d'approvisionnement dans les deux sens, contamination de propriété intellectuelle, et contradiction frontale avec l'argument de vente n°3 |
| **Dépôt miroir intermédiaire** | Écarté (D-B) | Vous voyez leur code (donc confidentialité et PI à contractualiser) et vous imposez une connectivité que le marché visé n'a pas toujours |
| **Snapshot complet + licence déclarative** | Écarté (D-E) | Livrer chez le client le code qu'il n'a pas acheté, derrière un drapeau qu'il peut retourner, ne laisse subsister l'upsell que par le contrat |
| **Snapshot sur mesure par client** | Écarté (D-E) | 13 modules optionnels = 8192 combinaisons ; aucune suite de tests ne couvre cela, chaque livraison devient un build unique validé à la main |
| **Distribuer par `git merge` d'une branche vendeur** | Écarté | C'est exactement le problème de fusion de branche vendeur N fois, sans aucune des garanties qu'un paquet apporte (compatibilité déclarée, migration réversible, portée bornée, signature) |
| **Micro-services / extraction réelle des modules** | Écarté | Change la nature du produit, impose du réseau et de l'exploitation chez un client qui achète précisément pour ne pas en avoir. La migration Postgres a déjà tranché contre (`POSTGRES_MIGRATION_ASSESSMENT.md`) |
| **Obfuscation / compilation du tronc** | Écarté | Contredit ce qui est vendu (« il peut le modifier à sa guise ») et ne résiste pas à un adversaire motivé |
| **Ne rien faire — tout livrer, facturer au forfait** | Retenu comme *repli* | Si les phases 0-2 dérapent, vendre un snapshot annuel forfaitaire reste un modèle viable. Il faut le savoir : ce chantier n'est pas un passage obligé, c'est une optimisation de marge |

---

## 4. Les six décisions porteur tranchées

| # | Décision | Choix retenu | Conséquence directe |
|---|---|---|---|
| **D-A** | Positionnement du modèle licence | **Seconde offre, même code** | Invariant I-1. Le SaaS reste principal ; interdiction de forker le produit ; tout ce document doit rester neutre pour le mode hébergé |
| **D-B** | Sens de l'accès au code | **Runner local chez le client** | Le vendeur ne détient aucun credential. Le catalogue est en lecture seule. Tout doit fonctionner hors-ligne (§11) |
| **D-C** | Ambition de la V1 | **Niveaux 1+2 : licence + plugins** | L'**ABI de plugin est le cœur de la V1** (§9). Le patch du tronc (N3) est explicitement hors périmètre |
| **D-D** | Périmètre de personnalisation client | **Zones d'extension + garantie conditionnée** | Il faut un `platform.contract.json` déclarant zones libres et tronc (§6.2), et un diagnostic de fork qui constate (§12) |
| **D-E** | Composition du snapshot vendu | **Par palier, dérivé de `PLAN_PRESETS`** | Trois builds officiels (free 15 / standard 22 / premium 26). Un **tailleur de build** devient un livrable (§7). Un client CUSTOM reçoit le palier le plus proche |
| **D-F** | Exécution des migrations | **Par le runner, sauvegarde vérifiée, `down` obligatoire** | Le composant le plus délicat du chantier (§14). Impose `startSession()` donc **replica set** chez le client (§18) |

### 4.1 La conséquence de D-E qu'il ne faut pas manquer

D-E **supprime le « niveau 1 » naïf**. Si le snapshot est taillé au palier, un
module d'un palier supérieur n'est **pas** présent chez le client, endormi : il
est absent. Il n'y a donc rien à « activer » — il faut le livrer.

Ce que la licence peut encore activer sans code se réduit à ce qui est *déjà
dans le snapshot mais borné* : quotas, sous-fonctionnalités (grille `AI_FEATURES`
existante), budget de jetons, durée. C'est réel, mais mince.

**Conséquence pratique : N1 et N2 utilisent la même machinerie.** Livrer `gaet`
(module du tronc, palier supérieur) et livrer une fonctionnalité inventée l'an
prochain sont la *même opération*. C'est ce qui rend le choix D-C cohérent :
l'ABI de plugin ne sert pas un cas sur deux, elle sert **tout** le modèle de
revenu. Elle mérite donc l'investissement.

---

## 5. L'échelle de livraison

L'agent — quand il existera — ne « décide pas comment adapter » : il **constate
le niveau applicable** et refuse de descendre plus bas que ce que le diagnostic
autorise. Le niveau est une conclusion, pas une intention.

| Niveau | Nature | Ce qui circule | Risque | Dans la V1 ? |
|---|---|---|---|---|
| **N0 · Licence** | Quotas, sous-fonctionnalités, budget IA, durée | Un fichier signé, quelques kilo-octets | Nul | **Oui** |
| **N1 · Module de palier** | Un des 26 modules du tronc, absent du snapshot du client | Un paquet plugin | Faible | **Oui** |
| **N2 · Fonctionnalité nouvelle** | Créée après l'achat, conçue d'emblée comme plugin | Un paquet plugin | Faible | **Oui** |
| **N3 · Patch du tronc** | La fonctionnalité modifie des fichiers du tronc | Un diff, en branche chez le client | Élevé | **Non** — conditionné à CH-0/CH-1/CH-2 |
| **N4 · Revue assistée** | Fork trop divergent, ou zone tronc modifiée par le client | Un rapport et une proposition ; un humain finit | — | **Non** — prestation |

**La promesse commerciale « sans arrêt et sans risque » n'est tenable qu'à N0,
N1 et N2.** Il faut le dire au client dans ces termes, et le badge de
compatibilité du catalogue (§15) doit l'afficher avant l'achat, pas après.

### 5.1 La règle de conception qui en découle

> **Toute fonctionnalité nouvelle est conçue comme plugin, à partir de la phase 3.**

Ce n'est pas une contrainte de ce chantier, c'est une discipline de produit : une
fonctionnalité qui ne peut être livrée qu'en N3 est une fonctionnalité qu'on ne
peut pas vendre à l'unité. Si le tronc doit changer pour l'accueillir, ce
changement appartient au **contrat de plateforme** et se livre avec une nouvelle
version majeure du contrat (§6.1), pas avec la fonctionnalité.

---

## 6. Le contrat de plateforme

C'est le manque n°1 (§2.2) et la première chose à écrire. Sans lui, aucun paquet
ne peut déclarer contre quoi il est compatible, et « ça devrait marcher » devient
la seule réponse possible à la question du client.

### 6.1 Versionnage — deux numéros, pas un

| Numéro | Ce qu'il désigne | Change quand |
|---|---|---|
| **Version produit** (`package.json`, tag git) | L'état du dépôt vendeur | À chaque livraison |
| **Version de contrat** (`platform.contract.json` → `contractVersion`) | Ce sur quoi un plugin a le droit de s'appuyer | Rarement, et **jamais** en même temps qu'une fonctionnalité |

Un paquet déclare une **plage** : `"requiresContract": ">=2.0.0 <3.0.0"`. C'est
cette plage, et elle seule, qui décide si un paquet est installable — jamais la
version produit du client.

Règles de compatibilité, sémantique stricte :

- **majeure** : un symbole de l'ABI disparaît ou change de signature ; une
  convention de données change (une valeur d'enum retirée, un marqueur de
  suppression douce déplacé). Casse tous les plugins.
- **mineure** : un symbole est ajouté. Un plugin existant continue de marcher.
- **corrective** : correction sans changement de surface.

**Décision de conception** : un changement majeur de contrat n'est pas livrable
par plugin. Il se livre comme un **nouveau snapshot de palier**, avec une
prestation de montée de version. C'est la soupape qui empêche le contrat de
devenir un musée qu'on n'ose plus toucher.

Action immédiate, indépendante du reste : **poser des tags git** et faire porter
à `package.json` une version réelle. 237 commits sans un seul tag signifie
qu'aujourd'hui, la question « le client X est à quelle version ? » n'a pas de
réponse.

### 6.2 Les zones (décision D-D)

`platform.contract.json`, à la racine du dépôt, déclare quatre zones :

| Zone | Contenu | Le client peut modifier ? | Effet sur la garantie |
|---|---|---|---|
| **`trunk`** | `app.js`, `server.js`, `shared/**`, `modules/<core>/**` | Techniquement oui (il a la source) | **Déclasse en N4** — mise à jour automatique perdue sur les paquets qui touchent la même zone |
| **`extension`** | `config/**`, thème, surcharges i18n locales, points de branchement déclarés | Oui | **Aucun** — garantie pleine |
| **`plugins`** | `modules/<clé non core>/**` livrés en paquet | Non (remplacés à chaque mise à jour) | Modifier = déclasse **ce module** en N4 |
| **`client`** | `modules/local-*/**`, réservé à ses propres modules | Oui, sans limite | Aucun — le vendeur ne les touche jamais |

Deux points à ne pas se tromper :

1. **Ces zones ne sont pas une protection.** Rien n'empêche techniquement un
   client d'éditer le tronc. Elles servent à *constater* (§12) et à *tarifer*.
   La divergence devient un problème commercial — là où il est soluble — au lieu
   d'un problème technique où il ne l'est pas.
2. **Le préfixe `local-` est un investissement dans le futur.** Il garantit
   qu'un module maison du client n'entrera jamais en collision de nom avec un
   module du catalogue. Sans lui, le jour où vous sortez un module `library`
   et qu'un client en a déjà écrit un, sa mise à jour écrase son travail.

### 6.3 L'ABI — ce qu'un plugin a le droit d'appeler

L'ABI est la liste **fermée** des symboles importables depuis un plugin. Elle est
déclarée dans `platform.contract.json` et **vérifiée mécaniquement**, sinon elle
dérive en trois mois.

Candidats naturels, relevés dans le code (`shared/` mesuré à 5-7 fichiers
distincts par gros module — la surface réelle est déjà petite) :

Liste **énumérée depuis les exports réels** le 2026-08-21 (`Object.keys()` sur
chaque module, pas une recopie de `CLAUDE.md`). Les chemins sont ceux qui
**résolvent** : le dépôt n'a ni `imports` ni alias de module dans `package.json`,
donc un plugin écrit des chemins relatifs, jamais des spécificateurs nus.

```
shared/utils/response-helpers.js       sendSuccess · sendCreated · sendError · sendPaginated
                                       sendNotFound · sendUnauthorized · sendForbidden
                                       sendConflict · sendValidationError · sendNoContent
                                       sendRateLimitError · handleDuplicateKeyError
                                       asyncHandler · formatValidationErrors
shared/utils/validation-helpers.js     isValidObjectId · areValidObjectIds
                                       canAccessCampus · buildCampusFilter · isResourceOwner
                                       isValidEmail · isValidPhone · validatePasswordStrength
                                       sanitizeInput · isDateNotFuture · escapeRegex
                                       firstLengthViolation
shared/utils/soft-delete.js            notDeletedFilter · deletedOnlyFilter
                                       softDeletePatch · restorePatch
                                       isSoftDeletable · ARCHIVED_STATUS
shared/utils/entitlement.js            getFeatureState · isFeatureActive · resolveEntitlement
                                       resolveQuota · planBaseState · isOverrideActive
                                       OVERRIDE_LAYERS · ALL_ENABLED
shared/constants/features.constants.js FEATURE_STATES · FEATURE_PLANS · FEATURE_ERROR_CODES
                                       DEFAULT_QUOTAS · CRON_NATURE   (lecture seule)
shared/middleware/auth.js              authenticate · authorize · optionalAuth
                                       requireCampusAccess · requirePermission
                                       isOwner · isOwnerOrRole
shared/middleware/entitlement.js       requireFeature · GLOBAL_ROLES · READ_METHODS
shared/middleware/role.js              (contrôle de rôle — surface à arrêter en phase 0)
shared/middleware/rate-limiter.js      apiLimiter · uploadLimiter · loginLimiter
                                       strictLimiter · createCustomLimiter
shared/middleware/upload.js            uploadProfileImage · uploadDocument · uploadImportFile
                                       uploadBufferToCloudinary · handleMulterError
                                       cleanupUploadedFile · getFileUrl
                                       MAX_FILE_SIZE · MAX_PROFILE_SIZE · UPLOAD_DIR
shared/middleware/locale.middleware.js appliqué globalement — lecture de req.locale
shared/lib/hard-delete/index.js        routes · service · constants · respondToError
                                       deletionLimiter · hardDeleteFlagLimiter
modules/<clé>/index.js (façade)        { routes, service } — jamais un interne
```

**Hors ABI, délibérément** — exportés par `shared/` mais réservés au socle :
`authMiddleware` et `skipRateLimitForAdmin` (`auth.js`, formes héritées),
`shutdownRateLimiter` (arrêt gracieux, appartient à `server.js`),
`mountEntitlementGates` (le socle monte, le plugin déclare),
`shared/lib/generic-entity.controller.js` et `shared/lib/generic-bulk.controller.js`
(ils résolvent des conventions par modèle — les exposer, c'est exposer Mongoose,
ce que §21 interdit pour la migration Postgres), et l'ensemble
`shared/utils/storage-*.js`.

⚠️ **Cette énumération est datée, donc déjà périmée en puissance.** Elle est ici
pour dimensionner le travail (≈ 75 symboles, 13 fichiers), **pas** pour servir de
contrat. Le contrat est le fichier généré en phase 0.

⚠️ **Cette liste doit être générée depuis le code, jamais recopiée.** Deux preuves
par l'exemple, et la seconde est ce document lui-même.

**a · Un symbole prescrit qui n'existe pas.** `CLAUDE.md` §2 prescrit
« *Use helper `getCampusFilter(req, res)`* », or **aucun `getCampusFilter` n'est
exporté par `shared/`**. Le dépôt en contient **deux, locaux et distincts** —
`modules/gaet/controllers/gaet.controller.js:81` (5 usages, et
`gaet.routes.js:20` documente le wrapper) et
`modules/parent/controllers/parent.crud.controller.js:79`. Le symbole partagé
réel est `buildCampusFilter(user, requestedCampusId)`, dans
`shared/utils/validation-helpers.js:133`.

**b · Un symbole canonique existant, mais ignoré.** `isGlobalRole` n'est pas un
helper exporté : c'est une fonction réécrite à l'identique dans plusieurs
contrôleurs (`class.controller.js:22`, `partner.crud.controller.js:44`,
`partner.lead.controller.js:50`…), plus un booléen `req.isGlobalRole` posé par le
middleware GED. Mais la constante canonique **existe déjà** :
`GLOBAL_ROLES = ['ADMIN','DIRECTOR']`, exportée par
`shared/middleware/entitlement.js`. Ce n'est donc pas un symbole à créer, c'est un
symbole à **imposer** — ce que l'ABI fait mécaniquement.

**c · La v1.1 de ce document a commis l'erreur qu'elle dénonçait.** Sa liste ABI
se présentait comme « noms vérifiés, pas supposés » ; elle recopiait en réalité
`CLAUDE.md` §4. Résultat mesuré à l'audit du 2026-08-21 : `FEATURE_STATES` placé
sous `shared/utils/entitlement` où il n'est pas exporté, `shared/middleware/locale`
au lieu de `locale.middleware.js`, une quinzaine de symboles omis et deux fichiers
entiers absents. **Trois pages après avoir écrit « jamais recopiée ».** C'est la
démonstration la plus économique qui soit que cette liste doit être un artefact
généré.

Une ABI écrite à la main hérite de ces écarts et les fige dans un contrat
opposable au client. Elle est donc **extraite du code et vérifiée par un test**,
au même titre que `feature-registry.test.js` vérifie déjà que `app.js` ne monte
pas un routeur inconnu du registre.

**Deux interdictions absolues, testables :**

- **aucun `require` relatif remontant hors du dossier du plugin**, sauf vers un
  symbole listé dans l'ABI ;
- **aucun `require` d'un interne d'un autre module** — la mesure de §2.3 montre
  que cette règle est aujourd'hui respectée à 100 % ; l'ABI la fige au lieu de
  la laisser reposer sur la discipline.

Mise en œuvre : une règle ESLint `no-restricted-imports` générée depuis
`platform.contract.json` + un test qui parcourt les `require` d'un paquet. Les
deux dérivent du même fichier — jamais deux listes (CLAUDE.md §0.1).

---

## 7. L'extracteur unique — tailleur de snapshot et empaqueteur

C'est l'idée centrale du dispositif, et celle qui économise le plus de code.

> **Retirer un module d'un build et empaqueter ce module en plugin sont la même
> opération, dans deux directions.** Un seul extracteur, deux sorties.

```
                         ┌──────────────────────────────┐
                         │  Tronc vendeur (26 modules)  │
                         └───────────────┬──────────────┘
                                         │
                         ┌───────────────▼──────────────┐
                         │   extract(<clé>)             │
                         │   « la tranche du module k » │
                         └───────┬──────────────┬───────┘
                                 │              │
              build --tier=std   │              │  package <clé>
              = tronc MOINS les  │              │  = la tranche, signée
              tranches premium   │              │
                                 ▼              ▼
                       ┌─────────────────┐  ┌──────────────────┐
                       │ Snapshot palier │  │  Paquet plugin   │
                       │ (livré à l'achat)│  │ (vendu à l'unité)│
                       └─────────────────┘  └──────────────────┘
```

Si l'on écrivait deux mécanismes, ils divergeraient — et celui qui diverge est
toujours celui qui livre du code faux, avec un fichier manquant qu'aucun test ne
voit parce que les deux chemins ne sont pas exercés également.

### 7.1 Ce qu'est « la tranche » d'un module

Établie par extraction depuis le registre et l'arborescence, jamais énumérée à la
main dans le manifeste :

**Backend**
- `modules/<clé>/**` — le dossier entier
- l'entrée `FEATURE_REGISTRY[<clé>]` (label, core, minState, records, dependsOn, usesWhenAvailable, routers, minPlan, crons)
- ses montages (`entry.routers`, déjà déclarés — 32 au total)
- ses crons (`entry.crons`, déjà déclarés — 7 au total) + le loader différé correspondant
- son entrée dans `hard-delete.registry.js`, **et** les modèles qu'il ajoute à l'entrée `campus` (§9.4 — c'est le piège)
- ses migrations (`up` + `down` + `verify`)
- ses tests

**Frontend**
- ses pages, son `src/services/<clé>Service.js`, ses schémas Yup
- ses entrées de route dans `*Routes.jsx` (10 fichiers)
- ses entrées de navigation, qui portent **déjà** `feature: '<clé>'`
- son namespace i18n `<clé>.json` × **10 locales**

### 7.2 Les quatre validations obligatoires de l'extracteur

Un extracteur qui produit un artefact plausible mais faux est pire que pas
d'extracteur : le défaut apparaît chez le client, pas chez vous.

1. **Clôture des dépendances déclarées** — toute clé de `dependsOn` doit être
   présente dans le palier cible. Un palier `free` qui contient `class` (lequel
   `dependsOn: ['campus', 'level']`) doit contenir `level`, sinon le snapshot ne
   démarre pas.

   **Vérifié le 2026-08-21 : les trois paliers sont clos sur les arêtes
   déclarées** (free 15, standard 22, premium 26), **et cette clôture est déjà
   pinnée** par `feature-registry.test.js:306` → *« no module structurally depends
   on a higher tier than its own »*, qui la vérifie par les rangs de `minPlan` —
   donc plus fortement qu'un instantané de `PLAN_PRESETS`.

   ⚠️ **Correction de la v1.1, qui sur-affirmait ici.** Elle concluait « rien à
   écrire, la propriété dont dépend le tailleur de build est déjà garantie ».
   C'est faux, et de la manière la plus coûteuse : la boucle du test ne parcourt
   que `FEATURE_REGISTRY[key].dependsOn`, c'est-à-dire les arêtes **qu'on a pensé
   à déclarer**. Elle ne prouve strictement rien sur les autres — et les autres
   sont exactement là où l'extracteur casse (§2.3 bis). Ce que cette validation
   garantit : *le graphe déclaré est clos*. Ce qu'elle ne garantit pas : *le
   graphe déclaré est le graphe*. D'où la validation n°4.
2. **Dégradation des arêtes souples** — chaque `usesWhenAvailable` pointant hors
   du palier doit dégrader sans erreur. C'est déjà la sémantique déclarée ; le
   build taillé est le premier endroit où elle est réellement *exercée*.
3. **Le build taillé démarre et passe sa suite.** Trois paliers = trois builds à
   valider en intégration continue, à chaque livraison. C'est le prix de D-E, et
   il est fixe (3), pas combinatoire (8192).
4. **Clôture des dépendances *runtime*** — la validation ajoutée le 2026-08-21,
   et la seule qui attrape la classe de défauts de §2.3 bis.

   Toute arête que Mongoose résout par nom doit être **déclarée** dans le
   registre (`dependsOn` si le module ne fonctionne pas sans, `usesWhenAvailable`
   s'il dégrade), et **close** dans le palier cible selon la même règle que
   l'arête dure. Trois sources à balayer, sur les fichiers réels et non sur
   `mongoose.modelNames()` — un modèle que personne n'importe doit être vu :

   | Source | Extraction |
   |---|---|
   | `mongoose.model('X')` à un seul argument | lecture de l'AST, propriétaire = module déclarant `mongoose.model('X', schema)` |
   | `ref: 'X'` dans un schéma | idem |
   | `.populate('champ')` | résolu via le `ref` du chemin |

   Le test échoue de deux façons, et les deux comptent : une arête **non
   déclarée** (le cas `student → Mentor`), et une arête déclarée en
   `usesWhenAvailable` mais dont le code **lève** au lieu de dégrader. La seconde
   est la plus sournoise : `mongoose.model('X')` sur un modèle absent ne rend pas
   `null`, il jette. Une arête souple n'est donc *souple* que si le code la
   protège explicitement — le déclarer ne suffit pas, et c'est ce que la
   validation n°2 supposait à tort.

   Ce test appartient au **socle**, pas à l'extracteur : il vaut aussi pour le
   mode hébergé, où un campus sans droit sur `mentor` traverse le même code. Il
   est écrit en phase 0 bis, avant l'extracteur qui en dépend, et il fait partie
   de la suite d'invariants livrée au client (§9.4).

### 7.3 Ce n'est pas un dépôt qu'on taille, c'en est deux — parfois trois

**Manque relevé à l'audit du 2026-08-20 : le §7 supposait un arbre unique.** Il
n'y en a pas. Un snapshot est une livraison **multi-briques** :

| Palier | Briques livrées | Conséquence |
|---|---|---|
| `free` · `standard` | Backend (brique 1) + Frontend ERP (brique 2) | L'extracteur opère sur **deux** dépôts, et un paquet livre des fichiers dans les deux |
| `premium` | + Portail Next.js (brique 4, dépôt `partner`) | Trois dépôts, trois chaînes de construction, trois jeux de variables d'environnement |
| `premium` avec `ai` | + ai-service Python + PostgreSQL/pgvector (brique 3) | Voir §16.4 et D-J : **hors V1** |

Trois conséquences que le reste du document doit porter :

1. **Le manifeste est multi-briques par nature** — c'est déjà le cas dans sa
   forme (§8 : clés `backend` et `frontend`), mais les *versions de contrat* le
   sont aussi : une brique peut évoluer sans l'autre. Un paquet déclare donc
   `requiresContract` **par brique**, pas une valeur unique.
2. **Le câblage entre briques est de l'environnement, pas du code**
   (`VITE_API_BASE_URL`, `PORTAL_API_KEY`, `AI_SERVICE_URL`…). Le snapshot doit
   livrer un `.env.example` par brique, et le diagnostic (§12) doit vérifier le
   câblage, pas seulement les fichiers.
3. **L'égalité au bit près (§20.1) se vérifie brique par brique.**

### 7.4 L'élagage des dépendances — la partie qu'on oublie

Retirer un module d'un build ne retire pas ses dépendances npm. Un snapshot
`free` qui embarque encore `puppeteer-core` + `@sparticuz/chromium` + `pdf-lib` +
`qrcode` pour une GED absente traîne des centaines de mégaoctets, une surface
d'attaque qu'il n'utilise pas, et **fait échouer le test d'égalité au bit près
sur `package.json` / `package-lock.json`**.

L'extracteur doit donc calculer les dépendances par module, ce qui exige de les
**déclarer** : un champ `dependencies` dans la déclaration de module (§9.A),
vérifié par un test qui compare les `require` non relatifs d'un module à ce
qu'il déclare. Le même test rend visible une dépendance utilisée par un module
et déclarée par personne — cas qui existe aujourd'hui sans que rien ne le dise.

⚠️ **Attention au piège inverse** : une dépendance partagée par deux modules ne
se retire que si les *deux* sont absents. Un élagage naïf par soustraction
produit un build qui ne démarre pas — panne franche au moins, ce qui est le bon
mode de défaillance, mais chez le client.

#### 7.4.1 Qui écrit `package-lock.json` — la contradiction à trancher

**Relevée à l'audit du 2026-08-21.** Trois exigences du document étaient
mutuellement incompatibles :

- §7.4 élague `package.json` **et** `package-lock.json` par palier ;
- §11.4 fait reconstruire le frontend par le runner avec **`npm ci`** ;
- §20.1 exige l'égalité **au bit près** après retrait puis réinstallation.

Or `npm ci` **refuse de s'exécuter** si le verrou n'est pas synchrone avec le
`package.json` — et installer un plugin qui apporte une dépendance désynchronise
précisément les deux. L'échappatoire naturelle, `npm install`, régénère un verrou
dont ni l'ordre ni les métadonnées ne sont reproductibles d'une machine à
l'autre : l'égalité au bit près devient inatteignable, et le test d'acceptation
de la phase 3 échouerait sur un fichier qui n'a rien de fonctionnellement faux.

**Décision : le verrou est un artefact du vendeur, jamais du runner.**

| Qui | Fait | Ne fait pas |
|---|---|---|
| **Extracteur** (vendeur, CI) | Calcule `package.json` **et** `package-lock.json` pour chacun des 3 paliers, et pour **chaque paquet** le verrou du palier + ce paquet. Les deux sont signés et voyagent dans le paquet | — |
| **Runner** (client) | Remplace les deux fichiers par la paire pré-calculée, puis `npm ci` — qui redevient valide puisque la paire est synchrone par construction | **Jamais** `npm install`. Jamais de résolution de version chez le client |

Deux conséquences :

1. **Le paquet embarque une paire de verrous par palier qu'il supporte**, pas un
   verrou unique. C'est du volume, pas de la complexité — et c'est ce qui rend la
   reconstruction hors ligne (§11.2) réellement déterministe.
2. **§20.1 exclut explicitement le verrou de l'égalité au bit près** et le
   remplace par une égalité *sémantique* : arbre de dépendances résolu identique,
   comparé après normalisation. Voir §20.1.

Corollaire, à ne pas contourner : une collision de version entre deux paquets
(§16.8) est détectée **chez le vendeur**, au calcul du verrou combiné, et non
chez le client au milieu d'une installation.

---

## 8. Le manifeste de paquet

Un fichier `feature.manifest.json` par paquet, **généré par l'extracteur**,
jamais rédigé à la main. Il est la seule chose que le runner lit pour décider.

```jsonc
{
  "schema": "1.0",
  "id": "gaet",                          // = clé FEATURE_REGISTRY, jamais un nom libre
  "version": "1.4.0",                    // version DU PAQUET
  "requiresContract": ">=2.0.0 <3.0.0",  // la seule contrainte de compatibilité qui vaut
  "minTier": "premium",
  "dependsOn": ["campus", "class", "subject", "teacher"],   // dérivé du registre
  "usesWhenAvailable": ["student"],                          // dérivé du registre
  "registry": { /* l'entrée FEATURE_REGISTRY, verbatim */ },
  "backend": {
    "files": ["modules/gaet/**"],
    "mount": "/api",                     // argument d'app.use — §9.1 a
    "mountOrder": 210,                   // ordre total, espacé — §9.1 c
    "routers": [                         // préfixes EXPOSÉS, ≠ mount
      { "path": "/api/gaet", "export": "routes", "gated": true }
    ],
    "crons": [],
    "models":     ["GaetConstraint"],    // enregistrés par ce paquet — §9.3
    "usesModels": ["Class", "Subject", "Teacher"],  // arêtes runtime — §7.2 n°4
    "hardDelete": { "entries": [], "campusRelations": [] },
    "abiUsed": ["shared/middleware/auth", "shared/utils/validation-helpers", "..."]
  },
  "frontend": {
    "files": ["src/campus/gaet/**", "src/services/gaetService.js"],
    "routes": [{ "portal": "campus", "path": "schedule-gaet" }],
    "nav":    [{ "portal": "campus", "section": "academic", "feature": "gaet" }],
    "i18n":   { "namespace": "gaet", "locales": 10 }
  },
  "migrations": [
    { "id": "2026-09-add-gaet-constraint", "up": "…", "down": "…", "verify": "…" }
  ],
  "tests": ["tests/unit/gaet.repository.test.js"],
  "files": { "modules/gaet/gaet.service.js": "sha256-…" },   // condensé par fichier
  "signature": "…"                                            // §10.2
}
```

Trois règles :

- **Rien n'est saisi deux fois.** `dependsOn`, `mount`, `routers`, `crons`,
  `models`, `registry` viennent de la déclaration de module (§9.A). Le manifeste
  est une *projection*, pas une déclaration concurrente (CLAUDE.md §0.1).
- **`routers` est une liste d'objets, pas de chemins.** Corrigé le 2026-08-21 :
  un module peut exposer plusieurs routeurs, depuis **plusieurs exports de
  façade**, dont certains hors gate. `ai` est le cas réel — `routes` sur
  `/api/ai` et `internalRoutes` sur `/internal/ai`, ce dernier étant dans
  `UNGATED_MOUNTS`. Une liste plate de chemins ne peut pas le décrire (§9.1 b).
- **`usesModels` est vérifié comme `abiUsed`** : calculé depuis le code, comparé
  à la déclaration, et refusé s'il désigne un modèle d'un module qui n'est ni en
  `dependsOn` ni en `usesWhenAvailable` (§7.2, validation n°4).
- **`abiUsed` est vérifié**, pas déclaratif : l'extracteur le calcule en lisant
  les `require`, et échoue si un symbole hors ABI apparaît.
- **Le condensé est par fichier**, pas global : après une installation partielle
  interrompue, le runner doit pouvoir dire *quel* fichier manque, pas seulement
  que « quelque chose ne colle pas ».

---

## 9. L'ABI de plugin — les six listes à rendre contributives

C'est le cœur technique de la V1 (D-C). Aujourd'hui, six listes écrites à la main
doivent être modifiées pour qu'un module existe. Un plugin ne peut modifier
aucune d'elles : elles doivent devenir **découvertes**.

Bonne nouvelle mesurée : cinq des six sont déjà déclaratives quelque part.

| # | Liste | État aujourd'hui | Cible | Difficulté |
|---|---|---|---|---|
| **9.1** | Montage des routers (`app.js`) | 28 `app.use` écrits à la main pour 32 préfixes déclarés + 4 `UNGATED_MOUNTS` | Boucle sur le registre — mais `routers` **n'est pas** le chemin de montage, et l'ordre est significatif | **Moyenne** — requalifiée le 2026-08-21, voir ci-dessous |
| **9.2** | Crons (`register-jobs.js`) | `projectJobs()` liste plate de 7 loaders | Dérivée de `FEATURE_CRONS` (qui porte déjà `name`, `nature`, `feature`) + un loader exposé par la façade du module | **Faible** |
| **9.3** | Enregistrement des modèles Mongoose | Implicite par `require` en cascade | Explicite : la façade du module enregistre ses modèles au chargement | **Moyenne** |
| **9.4** | Registre de suppression définitive | Entrées + relations sur l'entrée `campus` | Contribution par le paquet, **et l'entrée `campus` doit s'agréger** | **Élevée** — voir ci-dessous |
| **9.5** | Navigation + routes frontend | **10** fichiers `*Routes.jsx`, `feature:` déjà porté | Registre de contributions alimenté par les paquets installés | **Moyenne** |
| **9.6** | Namespaces i18n × 10 locales | Liste statique de 18 namespaces | Fusion au chargement des namespaces présents | **Moyenne** |

### 9.A · Le préalable structurel — éclater le registre

**C'est la contradiction la plus grave relevée à l'audit du présent document, et
elle invalidait silencieusement tout le §9.**

Installer un plugin, aujourd'hui, exige de modifier :

- `shared/constants/features.constants.js` — pour ajouter l'entrée de registre ;
- `shared/lib/hard-delete/hard-delete.registry.js` — pour l'entité et surtout
  pour les relations à ajouter sur l'entrée `campus` (§9.4).

Or **ces deux fichiers sont en zone `trunk`** (§6.2). Par ma propre règle, toute
installation de paquet serait donc une modification du tronc, et se
**déclasserait elle-même en N4** — le dispositif s'auto-interdirait à la première
installation. Pire : le test d'acceptation de la phase 3 (§20.1, égalité au bit
près) serait impossible, puisque l'installation devrait ré-insérer du texte dans
un littéral d'objet en préservant l'ordre des clés et le formatage.

**Correction : la déclaration d'un module doit vivre avec le module.**

```
modules/<clé>/<clé>.feature.js     ← entrée FEATURE_REGISTRY du module
                                     + ses entrées hard-delete
                                     + ses relations sur l'entrée `campus`
                                     + ses dépendances npm (§7.4)
                                     + son loader de cron (§9.2)
```

`shared/constants/features.constants.js` devient un **agrégateur** : il conserve
les états, les paliers, les codes d'erreur, les limites et les vues dérivées —
tout ce qui appartient au socle — et compose le registre à partir des
déclarations présentes. `Object.freeze` s'applique après composition : la
propriété « le registre et ses vues dérivées sont gelés », déjà testée, est
préservée.

Alors, et alors seulement :

- installer = **déposer un dossier**, jamais éditer un fichier du tronc ;
- désinstaller = retirer un dossier ;
- l'égalité au bit près devient atteignable ;
- la zone `plugins` a un sens réel.

**Cette refonte est un préalable des six listes qui suivent, pas une des six.**

Elle est peu risquée **quant au contenu** — c'est un déplacement de déclarations,
sans changement de sémantique. Elle ne l'est pas quant au **graphe de
chargement**, et la v1.1 s'arrêtait à la première moitié. Quatre points à traiter
explicitement, parce qu'ils portent sur le **mode hébergé**, c'est-à-dire l'offre
principale (D-A, I-1) :

1. **Le fichier est lu par quatre suites de tests** (`feature-registry`,
   `entitlement-deps`, `entitlement-resolve`, `entitlement.service`), qui
   l'importent comme une constante figée. Elles se réalignent sur l'agrégateur ;
   c'est du travail mécanique, mais c'est ce qui pinne le résultat.
2. **`Object.freeze` s'applique après composition**, et la composition devient un
   effet de bord au premier `require`. Il faut donc garantir qu'**aucun module ne
   lit le registre pendant qu'il se compose** — sinon un import précoce observe un
   registre partiel, et le défaut dépend de l'ordre de chargement, donc n'est pas
   reproductible. Contrôle : la composition est **synchrone et complète** au
   premier accès, et le registre n'expose aucun accesseur avant de l'être.
3. **Une déclaration illisible ou en double doit faire échouer le démarrage,
   bruyamment**, avec le nom du fichier fautif. C'est le seul point du dispositif
   où *fail-closed* est le bon choix alors que l'entitlement lui-même est
   *fail-open* (§10.3) : un registre partiel n'est pas une fonctionnalité
   manquante, c'est un produit dans un état que personne n'a décidé. La
   distinction est à écrire dans le code, pas à déduire.
4. **Le coût de démarrage** passe d'un `require` à 26. Négligeable en absolu,
   mais à mesurer une fois plutôt qu'à supposer, parce que `server.js` porte déjà
   un préflight de stockage et une reprise de zombies GAET.

À faire en une fois, tôt, et à ne pas mélanger avec autre chose. **Et à valider
d'abord sur le mode hébergé**, qui est en production : le mode licencié n'a
encore aucun client, l'autre en a.

### 9.1 Le montage des routers — l'acquis à exploiter

`mountEntitlementGates(app)` itère déjà `FEATURE_REGISTRY` et monte une gate par
chemin déclaré. Le montage des routers eux-mêmes peut suivre exactement la même
boucle, avec le même loader différé que les crons. Le commentaire du fichier dit
déjà pourquoi : répéter la liste dans `app.js` donnerait *« a second, unpinned
source of truth »*.

Mais **trois subtilités, et non une**, dont deux étaient absentes de la v1.1.
C'est ce qui fait passer cette ligne de « Faible » à « Moyenne ».

**a · `routers` n'est pas le chemin de montage.** C'est le piège central, et une
boucle naïve `app.use(entry.routers[i], router)` produit des URLs fausses. Pour
**4 modules sur 26**, le registre déclare les préfixes *effectivement exposés*,
tandis que `app.js` monte sur un préfixe plus court et laisse le routeur interne
compléter :

| Module | `routers` déclarés | `app.use` réel | Complété par |
|---|---|---|---|
| `student` | `/api/students` · `/api/schedules/student` · `/api/attendance/student` | `app.use('/api', studentRoutes)` | le routeur du module |
| `teacher` | `/api/teachers` · `/api/schedules/teacher` · `/api/attendance/teacher` | `app.use('/api', teacherRoutes)` | idem |
| `staff` | `/api/staff` · `/api/staff-roles` | `app.use('/api', staffRoutes)` | idem |
| **`public-portal`** | `/api/public` · `/api/portal-admin` | `app.use('/api', publicPortalRoutes)` | `public-portal.routes.js:17-18` |

La v1.1 n'en nommait que trois — elle ratait `public-portal`, qui est en outre le
seul des quatre au palier `premium`, donc le seul que l'extracteur **retire**
réellement d'un build. Le bug se serait manifesté exactement là où l'extracteur
est exercé.

**Résolution : deux champs, pas un.** La déclaration de module (§9.A) porte
`mount` (l'argument de `app.use`, valeur unique) **et** `routers` (les préfixes
exposés, liste — utilisés par les gates, le manifeste et le catalogue). Les
quatre modules ci-dessus déclarent `mount: '/api'`. Les 22 autres déclarent un
`mount` égal à leur unique `routers[0]`, et un test le vérifie plutôt que de le
supposer.

**b · `UNGATED_MOUNTS` n'est dans aucun `routers`.** La constante existe déjà
dans `features.constants.js` et vaut
`['/internal/ai', '/api/ping', '/api/health', '/health']`. Ces montages sont
**hors registre par construction** — c'est leur raison d'être : ils ne sont pas
gatés. Une boucle qui ne monte que le registre les perd, et perdrait notamment
`/internal/ai`, l'API S2S que l'ai-service appelle et que `CLAUDE.md` §9 interdit
de publier par le proxy. Deux conséquences :

- la boucle de montage traite `UNGATED_MOUNTS` comme une **seconde passe
  explicite**, pas comme un oubli ;
- `/internal/ai` est monté depuis `aiModule.internalRoutes`, un **second export
  de façade**. La forme du manifeste de §8 (`"routers": ["/api/gaet"]`, liste
  plate de chemins) ne sait pas l'exprimer. Elle devient donc une liste d'objets
  `{ mount, export, gated }` — voir §8. Le module `ai` est hors V1 (D-J), mais la
  *forme du manifeste* est un livrable de la phase 2 : la corriger coûte une
  ligne maintenant et une migration de manifestes plus tard.

**c · L'ordre de montage est significatif et n'a aucune clé.** `app.js` annonce
que l'ordre est sensible, et il l'est : `app.use('/api/', apiLimiter)` précède
tout, puis `publicPortalRoutes` est monté sur `/api` **avant** les trois autres
montages `/api` nus. Retirer `public-portal` d'un build `free` ou `standard`
change donc l'ordre relatif de ce qui reste. Une boucle sur `Object.keys()` d'un
registre **agrégé depuis 26 fichiers** (§9.A) n'a, elle, aucun ordre garanti.

**Résolution : un champ `mountOrder` entier dans la déclaration de module**, et
un tri explicite avant la boucle. Les valeurs sont espacées (10, 20, 30…) pour
qu'un plugin s'intercale sans renuméroter, et deux modules ne peuvent pas
partager la même valeur — un test le refuse. À égalité impossible par
construction, l'ordre est donc total et reproductible d'une installation à
l'autre, ce qui est la condition de §20.1.

⚠️ **Ce changement casse deux tests existants**, et il faut le prévoir plutôt que
le découvrir : `feature-registry.test.js` construit `MOUNTED` en **analysant le
texte de `app.js`**, puis vérifie *« every registry entry is actually mounted »*
et *« an explicit mount path is declared by its own entry »*. Une boucle ne
laisse plus rien à analyser : les deux tests passeraient à vide, ce qui est le
mode de défaillance le plus dangereux — un test vert qui ne vérifie plus rien.

Remplacement, strictement meilleur : **assertion sur la pile de routeurs de
l'application assemblée** (`app._router.stack`) plutôt que sur le source. Elle
vérifie ce qui est réellement monté, elle fonctionne identiquement pour un
plugin, et elle attrape un montage que l'analyse textuelle ne voyait pas.

### 9.2 Les crons — l'acquis le plus proche

`register-jobs.js` est déjà à mi-chemin : `projectJobs()` renvoie une liste plate
où **chaque job porte son loader différé** (`() => require(...)`), et
`FEATURE_CRONS` porte déjà `name`, `nature` et `feature`. Un module absent coûte
donc déjà un cron et non sept — la propriété exacte qu'exige un build taillé.

Ce qui manque est seulement la **contribution** : `projectJobs()` énumère
aujourd'hui les 7 jobs en dur. Cible :

```js
// modules/<clé>/<clé>.feature.js
crons: [{
  name:     'exam-anticheat',
  nature:   CRON_NATURE.EMISSION,   // valeur réelle de ce cron
  schedule: '0 3 * * *',          // UTC, toujours — voir §16.2
  load:     () => require('./exam-anticheat.cron').run,
}]
```

`projectJobs()` devient l'agrégation des `crons` des déclarations présentes,
triée par `name` pour être déterministe. Trois règles qui ne sont pas
négociables, toutes déjà justifiées ailleurs dans le produit :

1. **Le loader reste différé.** C'est lui qui fait qu'une déclaration présente
   mais un module en erreur ne tue pas les six autres crons. Un `require` direct
   dans la déclaration annule le bénéfice.
2. **L'horaire est en UTC**, jamais en heure locale — `CRON_TIMEZONE = 'UTC'` est
   fixé dans `register-jobs.js:33` pour une raison consignée (§16.2).
3. **`nature` décide de ce qu'une désinstallation éteint** (§16.2, §16.7) : un
   job `HYGIENE` du socle survit au retrait d'un paquet ; seul un job `EMISSION`
   apporté par le paquet part avec lui.

Difficulté réelle : **faible**. C'est la seule des six listes où la cible est
atteignable par un déplacement, sans nouveau mécanisme.

### 9.3 L'enregistrement des modèles — la liste qui portait l'angle mort

**Rédigée le 2026-08-21. C'était une ligne de tableau ; c'est le mécanisme dont
dépend la validation n°4 de §7.2.**

Aujourd'hui l'enregistrement Mongoose est **implicite** : un modèle existe parce
qu'un `require` en cascade a fini par charger son fichier. Trois défauts, et le
troisième est celui de §2.3 bis :

1. **L'ordre de chargement décide de ce qui existe.** Un modèle référencé avant
   d'être chargé lève `MissingSchemaError` — un défaut d'ordonnancement qui se
   présente comme un défaut de données.
2. **Un plugin n'a aucun point d'accroche** : il n'est dans la cascade de
   personne.
3. **Rien ne relie un modèle à son module propriétaire.** C'est ce qui rend les
   arêtes runtime indéclarables : sans propriétaire, on ne peut ni les rattacher
   au registre, ni les vérifier.

**Cible — la façade déclare, le socle enregistre :**

```js
// modules/<clé>/<clé>.feature.js
models: [
  { name: 'GaetConstraint', load: () => require('./models/gaet-constraint.model') },
],
// arêtes runtime vers des modèles d'autres modules (§7.2, validation 4)
usesModels: ['Class', 'Subject', 'Teacher'],
```

Le socle enregistre en deux temps, et l'ordre cesse d'être un hasard :
**passe 1** — tous les `models` de toutes les déclarations présentes sont
chargés ; **passe 2** — les `ref` sont résolus. Un `ref` vers un modèle absent
n'est plus une exception au premier `populate()` en production, mais une erreur
au démarrage, nommée, avec le module qui la cause.

Trois propriétés que cela donne, et qu'aucune autre des six listes ne donne :

- **`usesModels` rend les arêtes runtime déclarables**, donc vérifiables par la
  validation n°4 de §7.2 : chaque nom doit appartenir à un module déclaré en
  `dependsOn` ou en `usesWhenAvailable`. Le test le dérive du code (AST) et le
  compare à la déclaration — ni l'un ni l'autre n'est cru sur parole.
- **La dégradation devient explicite.** Une arête `usesWhenAvailable` n'est
  souple que si le code la protège : `mongoose.model('X')` sur un modèle absent
  **jette**, il ne rend pas `null`. Le socle expose donc
  `optionalModel('Mentor')` → `Model | null`, et l'ABI l'impose : appeler
  `mongoose.model()` directement sur une arête souple est refusé par le test.
  C'est le correctif de `student.repository.js:248`.
- **Le mode hébergé y gagne aussi** (I-1) : un campus sans droit sur `mentor`
  traverse exactement le même code. Ce n'est pas une dépense pour le mode
  licencié seul.

Difficulté réelle : **moyenne**, mais c'est le préalable des paliers, pas un
raffinement — d'où son passage en phase 0 bis (§20).

### 9.4 Le piège de la suppression définitive

C'est le point où une conception naïve casse une garantie existante, en silence.

`tests/unit/hard-delete.test.js` impose deux invariants (CLAUDE.md §5.2) :

- **toute `ref` de schéma pointant vers une entité supprimable doit être déclarée
  par une relation** ;
- **tout modèle scopé par campus doit être déclaré sur l'entrée `campus`** —
  sinon la suppression d'un campus laisse les lignes d'un locataire orphelines.

Un plugin qui ajoute des modèles scopés par campus **doit donc contribuer à
l'entrée `campus`**, qui n'est pas la sienne. Deux conséquences :

1. L'entrée `campus` du registre doit devenir **agrégée** : le socle déclare ses
   relations, chaque plugin installé ajoute les siennes.
2. **La suite d'invariants doit être livrée avec le build et exécutable chez le
   client**, sur l'arbre *assemblé*. C'est l'arbre assemblé qui doit être
   correct, pas le tronc du vendeur. Le runner l'exécute après installation
   (§13, étape 7) — c'est le seul critère de succès mécanique dont on dispose
   tant que CH-0/CH-2 ne sont pas là.

Corollaire : `tests/unit/hard-delete.test.js`, `feature-registry.test.js` et
`soft-delete.test.js` **font partie du produit livré**, au même titre que le
code. Ce sont eux qui rendent l'installation vérifiable.

### 9.5 La navigation et les routes frontend

**Rédigée le 2026-08-21.** Le côté lecture existe déjà : chaque entrée de
navigation porte `feature: '<clé>'` et `useFeature()` en est le seul lecteur. Ce
qui manque est le sens inverse — **contribuer** une entrée sans éditer un fichier
de portail.

Le décompte exact, re-relevé : **10 fichiers `src/routes/*Routes.jsx`** —
`Admin` · `Campus` · **`Client`** · `Director` · `Mentor` · `Parent` · `Partner` ·
`Staff` · `Student` · `Teacher`. La v1.1 en annonçait 9 ici et 10 en §7.1 :
c'était `ClientRoutes.jsx` qui manquait à l'énumération. Un registre de
contributions couvrant 9 portails sur 10 laisse un portail non servi, et c'est le
genre d'écart qui se découvre en clientèle.

**Cible — un registre de contributions, chargé au démarrage de l'application :**

```js
// frontend : contribution portée par le paquet
{ portal: 'campus', section: 'academic', feature: 'gaet',
  path: 'schedule-gaet', component: () => import('./gaet/GaetPage.jsx'),
  anchor: 'after:schedules' }
```

Quatre règles :

1. **La position est déclarée par ancre, jamais par indice** (`portal` +
   `section` + `anchor`). Un indice numérique se décale dès qu'un autre paquet
   s'installe — §16.8 le dit déjà pour les collisions, c'est la même règle vue de
   l'autre bord.
2. **À égalité d'ancre, ordre alphabétique de la clé** : arbitraire mais
   déterministe, donc reproductible d'une installation à l'autre.
3. **`feature:` reste la seule autorité d'affichage.** La contribution ajoute une
   entrée ; c'est `useFeature()` qui décide si elle se voit. Un paquet installé
   mais désactivé (§16.7, `read_only`) ne doit pas disparaître de la navigation
   par un second mécanisme — ce serait la duplication que `CLAUDE.md` §0.1
   interdit, dans sa forme la plus difficile à déboguer.
4. **Le composant est un `import()` paresseux**, ce qui laisse Vite découper le
   bundle par paquet — et rend la reconstruction de §11.4 proportionnelle au
   changement, pas au produit entier.

Difficulté réelle : **moyenne**. Le risque n'est pas le registre, c'est que
`ClientRoutes.jsx` et les portails à structure particulière (`Partner`, qui a son
propre modèle d'authentification — `CLAUDE.md` §2) ne se plient pas au même
gabarit. À vérifier portail par portail en phase 5, pas à supposer.

### 9.6 Les namespaces i18n

**Rédigée le 2026-08-21.** État mesuré : **10 locales × 18 namespaces = 180
fichiers**, et la liste des namespaces est **en dur** dans
`src/i18n/i18n.js:13`.

Le fait qui change la conception, et que la v1.1 ne relevait pas : **les
traductions vivent dans `public/locales/`, pas dans `src/`.** Vite copie
`public/` verbatim vers `dist/` sans les traiter. Trois conséquences :

1. **Une traduction n'est pas du code compilé.** Contrairement à ce que §11.4
   laisse croire pour l'ensemble du frontend, déposer 10 fichiers de traduction
   n'exige pas de recompiler quoi que ce soit — il faut seulement qu'ils
   atterrissent **à la fois** dans `public/locales/<locale>/<ns>.json` (la
   source, qui survit aux reconstructions futures) **et** dans
   `dist/locales/…` (ce que le navigateur sert réellement). N'écrire que le
   premier, c'est une installation qui ne se voit qu'à la prochaine
   reconstruction ; n'écrire que le second, c'est une traduction que la
   prochaine reconstruction efface. **Le runner écrit les deux, et la
   vérification de l'étape 8 (§13) contrôle les deux.**
2. **La liste en dur doit devenir une fusion.** `src/i18n/i18n.js` énumère les 18
   namespaces ; un 19ᵉ apporté par un paquet doit s'y ajouter sans édition. La
   liste est dérivée du registre de contributions (§9.5), qui connaît déjà le
   namespace de chaque paquet. Les namespaces chargés à chaud (`ns: ['common',
   'errors']` reste la liste *eager*) ne changent pas.
3. **Les surcharges du client sont en zone `extension`** (§16.1) et vivent dans
   le même arbre `public/locales/`. La fusion doit donc être **surcharge par
   clé**, pas remplacement de fichier : un client qui a renommé « Étudiant » en
   « Auditeur » garde sa clé et reçoit les nouvelles.

**Complétude, à la génération et non à l'installation** : `tests/unit/i18n.test.js`
existe déjà côté backend ; l'extracteur applique la même règle au paquet — 10
fichiers ou aucun (§16.1, R-5). Un paquet incomplet est refusé chez le vendeur,
là où la correction coûte une minute.

Difficulté réelle : **moyenne**, essentiellement à cause du point 1 — c'est un
piège de déploiement, pas un problème d'ingénierie.

### 9.7 Ce qu'on ne rend PAS contributif

- **Les modules `core` (9)** ne sont jamais des plugins. Ils sont dans tous les
  paliers, y compris `free` (15 modules). Le socle est le socle.
- **`shared/**` n'est jamais étendu par un plugin.** Un plugin qui a besoin d'un
  helper partagé demande un changement de contrat, il ne dépose pas un fichier
  dans `shared/`. Sinon, deux plugins déposent deux versions du même helper.

---

## 10. La licence

### 10.1 Ce qu'elle contient

```jsonc
{
  "licensee":   { "name": "…", "id": "…" },
  "tier":       "standard",
  "snapshotId": "erp-standard-2.1.0-…",
  "contract":   "2.1.0",
  "features":   ["…"],           // clés du registre effectivement acquises
  "quotas":     { "maxStudents": 5000, "…": "…" },
  "ai":         { "plan": "standard", "monthlyTokenBudget": 0 },
  "issuedAt":   "2026-09-01T00:00:00Z",
  "expiresAt":  null,            // null = perpétuel (licence de code source)
  "support":    { "until": "2027-09-01T00:00:00Z" }   // le support, lui, expire
}
```

Distinction à ne jamais confondre : **la licence de code est perpétuelle, le
droit aux mises à jour ne l'est pas.** `expiresAt: null` + `support.until` est ce
qui exprime exactement le modèle vendu.

### 10.2 Comment elle est signée

Manque n°5 de §2.2 : **toute la cryptographie du dépôt est symétrique** (`HS256`
sur `JWT_SECRET`). Une licence signée en HS256 serait forgeable par le client,
qui détient le secret — le mécanisme serait décoratif.

- Signature **asymétrique** (EdDSA ou RS256 ; `jsonwebtoken` gère les deux).
- **Clé privée hors ligne**, jamais dans le dépôt, jamais dans une CI.
- **Clé publique embarquée dans le build**, avec un identifiant de clé (`kid`)
  pour permettre une rotation sans invalider les licences émises.
- Le vérificateur épingle l'algorithme (`algorithms: ['EdDSA']`) — la même
  discipline que le code existant applique déjà pour HS256.

### 10.3 Ce qu'elle vérifie, et surtout QUAND

> **La licence est vérifiée à l'installation, pas à l'exécution.**

C'est la décision la plus importante de cette section, et elle évite un mode de
défaillance grave.

| Moment | Rôle de la licence | Comportement si elle est absente / illisible / expirée |
|---|---|---|
| **Installation d'un paquet** (runner) | **Autorisante** — le runner refuse d'installer un paquet non couvert | Refus net, message explicite. Aucun risque : rien n'est installé |
| **Exécution** (serveur du client) | **Attestante** — journalisée au démarrage, affichée dans l'écran d'administration | **Aucun changement de comportement.** L'ERP tourne |

Pourquoi l'exécution ne doit pas être gatée :

- Le gate d'entitlement est **fail-open par conception** (`features.constants.js`,
  en tête de fichier : *« it fails OPEN … this is NOT a security boundary »*).
  En faire une serrure inverserait sa sémantique dans un seul des deux modes de
  livraison — ce qui viole l'invariant I-1 et introduit deux comportements pour
  un même code.
- Une licence illisible qui éteindrait des modules **effacerait la navigation
  d'une université un lundi matin**, pour une raison sans rapport avec l'usage.
  `CAMPUS_ENTITLEMENT_DESIGN.md` §4.1.2 pose déjà les garanties intangibles face
  à `hidden` ; les respecter ici n'est pas une faveur.
- Et surtout : **c'est inutile.** Le client a le code. Le seul mécanisme qui
  tient est que le code non acheté **n'est pas dans son arbre** (D-E). La
  serrure d'exécution ne gênerait que les honnêtes gens, et seulement le jour où
  elle tombe en panne.

**Ce que la licence apporte réellement**, et qui suffit : un refus net à
l'installation, une traçabilité opposable (empreinte de licence dans chaque
ligne d'audit), et l'impossibilité d'un usage non acheté **de bonne foi**.

### 10.4 Le cas des quotas (N0)

Seule exception au principe ci-dessus, et elle est bornée : les quotas et
sous-fonctionnalités sont lus à l'exécution depuis la licence. En cas de licence
illisible, ils **retombent sur `DEFAULT_QUOTAS`** — jamais à zéro. Le fichier le
dit déjà explicitement : *« `0` is NOT unlimited here … an accidental zero would
lock a campus out of creating anything »*.

---

## 11. Le runner client

L'exécutable que le client lance chez lui (D-B). Distribué comme conteneur et
comme binaire autonome — le marché visé ne peut pas dépendre d'une chaîne
d'outils Node installée sur un serveur de production.

### 11.1 Ce qu'il fait — et ce qu'il ne fait pas

| Il fait | Il ne fait pas |
|---|---|
| Lire le catalogue (HTTP, **lecture seule**) ou un export hors-ligne signé | Envoyer du code source au vendeur |
| Calculer le diagnostic de fork (§12) | Envoyer des données métier, jamais |
| Vérifier signature, contrat, dépendances, licence | Installer sans la porte (§13) |
| Faire un essai à blanc chiffré | Toucher la base sans sauvegarde vérifiée |
| Installer sur une **branche git dédiée** | Pousser sur `main` du client |
| Appliquer les migrations (D-F) | Décider seul d'un `down` |
| Exécuter la suite d'invariants livrée | Rapporter un succès non vérifié |
| Écrire la ligne d'audit locale | Effacer une ligne d'audit |

### 11.2 Le mode hors-ligne est le mode nominal, pas une dégradation

C'est une contrainte de marché, pas une élégance. Le catalogue s'exporte en
**bundle signé** (`catalogue.sig` + paquets), transportable sur clé USB. Le
runner doit fonctionner **sans aucune connectivité** : vérification de signature
locale, licence locale, essai à blanc local, audit local.

Corollaire à ne pas rater : **aucune étape du dispositif ne peut exiger un appel
réseau vers le vendeur pour réussir.** Un contrôle en ligne est un point de
défaillance sur un continent où la connectivité est la variable la moins fiable —
et il transformerait votre serveur en dépendance d'exploitation de leur ERP.

### 11.3 Idempotence et reprise

Une installation interrompue (coupure de courant — hypothèse *nominale* sur ce
marché, pas exceptionnelle) doit être **reprenable ou annulable**, jamais laissée
à mi-chemin. D'où :

- l'installation du code se fait sur une **branche git**, donc atomique au
  commit ;
- la migration est **séparée** du code et porte son propre état ;
- le condensé par fichier (§8) permet de dire exactement où l'on s'est arrêté ;
- rejouer la même installation sur un arbre déjà à jour est un **no-op**, pas un
  doublon.

### 11.4 La reconstruction du frontend — le manque le plus coûteux de la v1

**Angle mort complet de la première rédaction.** Le frontend ERP est une
application **React/Vite construite** : `npm run build` → `dist/`, mesuré à
**18 Mo** le 2026-08-20. Déposer les fichiers source d'un plugin dans `src/` ne
change **rien** à ce que le navigateur sert. Tant que `dist/` n'est pas
reconstruit, l'installation n'a produit aucun effet visible — et le runner
rapporterait un succès parfaitement faux.

Trois options, tranchées ici :

| Option | Verdict | Motif |
|---|---|---|
| **Le runner reconstruit le frontend, dans son conteneur** | **Retenue** | La chaîne d'outils voyage avec le runner (image versionnée, `npm ci` sur un cache embarqué **et sur la paire `package.json`/`package-lock.json` pré-calculée par l'extracteur** — §7.4.1). Le client n'installe rien, ne résout aucune version. Fonctionne hors ligne. Reproductible |
| Le paquet livre un bundle frontend pré-construit | Écartée | Un bundle pré-construit est lié au *hash de build* du reste de l'application : il casse dès que le client a un autre plugin, ou un thème modifié (zone `extension`) |
| Chargement dynamique de modules à l'exécution | Écartée pour la V1 | Fédération de modules : c'est une réarchitecture du frontend, pas une fonctionnalité de livraison. À rouvrir seulement si la reconstruction s'avère impraticable en clientèle |

Conséquences à porter dans tout le dispositif :

- **Le runner embarque Node et la chaîne Vite** — il n'est donc pas un petit
  binaire ; c'est une image de conteneur de plusieurs centaines de mégaoctets, à
  transporter par clé USB comme les paquets (§11.2).
- **La reconstruction est une étape de la séquence** (§13, entre 7 et 8) et elle
  peut échouer pour des raisons propres au client : thème modifié, surcharge i18n
  invalide, dépendance verrouillée. Elle doit donc s'exécuter **avant** le
  basculement, sur une copie, et le basculement de `dist/` doit être atomique
  (construction dans `dist.new/`, échange de répertoire).
- **L'essai à blanc doit inclure une reconstruction à blanc**, sinon « simuler
  l'installation » ne simule pas l'étape la plus susceptible d'échouer.
- **Le portail Next.js (palier premium) a exactement le même problème**, avec sa
  propre chaîne de construction.
- **La charge de la phase 5 est sous-estimée dans la version initiale de ce
  document** (§20).

---

## 12. Le diagnostic de fork

Ce qui rend le catalogue **honnête** : sans lui, chaque carte promet la même
chose à tout le monde, alors que le niveau applicable dépend de l'état du fork.

### 12.1 Ce qu'il calcule, localement

1. **Divergence du tronc** — condensé SHA-256 de chaque fichier de zone `trunk`,
   comparé au manifeste du snapshot. Sortie : la liste des chemins divergents.
2. **Divergence de la zone `plugins`** — condensé SHA-256 de chaque fichier de
   `modules/<clé non core>/**`, comparé au manifeste du paquet qui l'a livré.

   **Ajouté le 2026-08-21 : §6.2 déclarait une conséquence que §12.1 ne pouvait
   pas constater.** La zone `plugins` est annoncée « remplacée à chaque mise à
   jour », et la modifier « déclasse ce module en N4 » — mais le diagnostic ne
   condensait que le tronc. Le déclassement était donc indétectable, et la mise
   à jour écrasait le travail du client **en silence**, exactement ce que le
   préfixe `local-` sert à éviter un paragraphe plus haut.

   Le paquet portant déjà un condensé **par fichier** (§8), le contrôle ne coûte
   rien de plus. Ce qu'il change est le comportement : une mise à jour visant un
   module divergent **s'arrête et nomme les fichiers**, laissant à l'opérateur le
   choix entre écraser (avec sauvegarde du fichier, en connaissance de cause) et
   commander une prestation N4. Écraser reste possible ; l'ignorer, non.
3. **Usage des zones d'extension** — quels points de branchement sont utilisés.
4. **Empreinte de schéma** — collections présentes, index, et **l'état des
   migrations déjà appliquées**.
5. **Version de contrat** et paliers/paquets installés.
6. **Prérequis d'exploitation** (§18) : replica set ? stockage persistant ?
   version de Node ? version de MongoDB ?

### 12.2 Ce qui remonte au vendeur

**Des condensés et des versions. Jamais une ligne de code, jamais une donnée.**

Le rapport transmis est une liste de chemins et de hachages. Il permet de dire
« ce fichier a été modifié » sans jamais révéler *comment*. C'est ce qui rend le
diagnostic compatible avec l'argument de souveraineté — et il faut résister à la
tentation d'y ajouter « juste le diff, pour aider au support » : ce jour-là, vous
détenez le code de vos clients et toute la §17 s'effondre.

Un client qui refuse même cela reste servi : le diagnostic tourne en local et le
runner décide seul, sans rien transmettre. Le catalogue affiche alors des badges
génériques au lieu de badges calculés.

---

## 13. La porte d'installation

**Réutilisation stricte du patron `shared/lib/hard-delete/`**, qui est en
production, testé, et qui répond exactement au même problème : une opération
dangereuse, difficilement réversible, déclenchée par un opérateur qui doit
comprendre ce qu'il fait avant de le faire.

| Contrôle hard-delete | Transposition à l'installation |
|---|---|
| **Ticket** HMAC, TTL 300 s, lié à *(acteur, entité, condensé d'impact)*, émis par le seul `preview()` | Ticket lié à *(acteur, paquet@version, condensé de l'état du fork + du plan de migration)*. **Une installation ne peut jamais être déclenchée à l'aveugle**, et si l'arbre a bougé entre l'essai à blanc et l'exécution, le condensé ne correspond plus → 409, nouvel essai obligatoire |
| **Phrase de confirmation** — l'opérateur retape `DELETE <identifiant>` | `INSTALL <id>@<version>` — défend contre le mauvais paquet, comme la phrase défend contre la mauvaise ligne |
| **Mot de passe** — réauthentification contre le magasin de l'acteur | Idem, rôles `ADMIN` / `DIRECTOR` du client |
| **Motif** ≥ 10 caractères, conservé | Idem — c'est l'entrée du journal de bord de leur ERP |
| **Registre append-only** `DeletionAudit`, y compris pour les refus | `InstallAudit` — `completed` / `blocked` / `failed`, **refus compris**. Une signature invalide, un contrat incompatible, une sauvegarde non vérifiée : tout s'écrit |
| **Re-comptage dans la transaction** | Re-vérification du condensé de l'arbre **au moment du commit** |
| **Troncature des champs libres** aux limites du schéma | Idem — le fichier `hard-delete.constants.js` explique pourquoi : *« The audit write is never allowed to be what fails »* |

### 13.1 La séquence complète

```
1. Diagnostic de fork          → niveau applicable, prérequis vérifiés
2. Vérifications du paquet     → signature · contrat · dépendances · licence
3. Sauvegarde                  → prise ET RELUE (compte de documents vérifié)
4. Essai à blanc               → fichiers touchés, documents migrés, conflits — AUCUNE écriture
5. Rapport d'impact + TICKET   → l'opérateur lit ce qui va se passer
6. Porte                       → phrase · mot de passe · motif
7. Application                 → branche git, puis migration en transaction
8. Vérification                → suite d'invariants livrée (§9.4) + `verify` de migration
9. Audit                       → InstallAudit, quel que soit le résultat
10. Point de retour            → commit + horodatage de sauvegarde inscrits dans l'audit
```

**Aucune étape n'est optionnelle, et l'étape 3 ne se signale pas « faite » sans
avoir été relue.** Une sauvegarde non vérifiée est le mode de défaillance
classique : elle est annoncée, elle n'existe pas, et on ne s'en aperçoit qu'au
moment où l'on en a besoin.

### 13.2 Qui est l'acteur, et où le mot de passe est réellement vérifié

Question laissée ouverte par la première rédaction, et qui rendait la porte
inapplicable : le runner est un **processus local**, potentiellement lancé depuis
un shell par un administrateur système qui n'est pas un utilisateur de l'ERP. On
ne peut ni lui demander un mot de passe ERP qu'il n'a pas, ni se contenter de
n'en demander aucun.

**Résolution : le ticket est émis par le backend de l'ERP du client ; le runner
ne fait que le vérifier.**

```
Opérateur (session ERP authentifiée)
      │  ouvre le marketplace, lance l'essai à blanc
      ▼
Backend ERP du client  ── possède l'acteur, son magasin de mots de passe,
      │                   et son propre JWT_SECRET
      │  applique les 3 contrôles humains (phrase · mot de passe · motif)
      │  émet le 4e — un TICKET HMAC (TTL 300 s) lié à
      │  (acteur, paquet@version, condensé d'arbre)
      ▼
Runner  ── vérifie le ticket avec le MÊME JWT_SECRET (il est local, c'est
           le secret de leur installation), puis installe
```

Trois propriétés que cela donne gratuitement :

- **la machinerie d'authentification n'est pas réécrite** : le backend du client
  possède déjà `Admin` / `Campus` et la vérification de mot de passe utilisée par
  la suppression définitive ;
- **le HMAC utilise le `JWT_SECRET` du client**, jamais un secret du vendeur — le
  ticket n'est valable que sur son installation ;
- **le runner ne peut rien faire sans un acte humain tracé dans leur ERP.** C'est
  ce qui établit, dans l'audit, que **l'acte est le leur** — point qui compte
  autant juridiquement que techniquement (§19, R-3).

**Mode « bris de glace ».** Un ERP en panne ne peut pas émettre de ticket, et
c'est précisément quand on a besoin d'installer un correctif. Le runner accepte
alors un mode dégradé : pas de ticket, mais un motif obligatoire, une double
confirmation, un marquage `breakGlass: true` dans l'audit, et **aucune migration
autorisée**. Le tracer sans l'interdire vaut mieux que l'interdire et voir
quelqu'un contourner le runner à la main.

### 13.3 Un audit qui survit à ce qui l'a fait échouer

`InstallAudit` en base de données a un défaut que `DeletionAudit` n'a pas : dans
la suppression définitive, une base injoignable signifie que **rien ne s'est
produit**. Ici, le code peut déjà être commité, le frontend reconstruit, et la
base tomber au moment de la migration. La ligne d'audit qui expliquerait ce qui
s'est passé est alors précisément celle qu'on ne peut pas écrire.

**D'où deux journaux, avec des rôles distincts :**

| Journal | Où | Autorité |
|---|---|---|
| **`install.log.jsonl`** — append-only, sur disque, écrit par le runner à chaque étape | Chez le client, hors base | **Source de vérité.** Écrit avant, pendant et après ; il seul permet la reprise (§11.3) |
| **`InstallAudit`** — document Mongo | Base du client | **Projection** pour l'écran d'historique (§15.2). Réconcilié depuis le fichier au démarrage suivant |

La discipline de `hard-delete` s'applique au fichier comme à la ligne : champs
libres **tronqués** aux limites, charge utile construite par une seule fonction
pour que le succès et le refus ne puissent pas porter des champs différents.

---

### 13.4 Le modèle de menace, énoncé une fois

**Manque relevé le 2026-08-21.** Le document décrit une porte à quatre contrôles,
puis ouvre **deux chemins qui n'en franchissent aucun de complet** — le bris de
glace ci-dessus (sans ticket, sans mot de passe) et le delta de sécurité (§17.4,
*« jamais de mot de passe »*). Les deux choix sont défendables, mais un document
opposable au contrat de vente (§18) ne peut pas les laisser implicites.

**Contre quoi la porte défend, et contre quoi elle ne défend pas :**

| Menace | Traitée ? | Par quoi |
|---|---|---|
| Mauvais paquet, mauvaise version | **Oui** | Phrase de confirmation |
| Installation à l'aveugle, sans lecture d'impact | **Oui** | Ticket émis par le seul essai à blanc |
| Arbre modifié entre l'essai et l'exécution | **Oui** | Condensé lié au ticket → 409 |
| Opérateur ERP agissant hors de son rôle | **Oui** | Mot de passe + rôles ADMIN/DIRECTOR |
| Paquet falsifié ou non signé | **Oui** | Signature, sans option d'outrepassement (§17.2) |
| Contestation *a posteriori* de qui a agi | **Oui** | Ticket lié à l'acteur, double journal (§13.3) |
| **Accès shell au serveur du client** | **Non, et c'est assumé** | voir ci-dessous |

**Quiconque a un shell sur le serveur applicatif du client peut modifier l'arbre
sans passer par le runner** — c'est vrai de tout produit livré en source, et le
client est propriétaire de son code (§1, point 1). La porte n'est donc pas un
contrôle d'accès : c'est un **contrôle de procédure**, qui protège un opérateur
autorisé contre l'erreur et fournit une trace opposable. Elle a exactement la
même nature que la porte de suppression définitive dont elle est reprise, et que
`CLAUDE.md` n'a jamais présentée comme une frontière de sécurité.

**Ce que cela implique concrètement**, et qui est le seul point d'action :

- le `JWT_SECRET` qui signe le ticket appartient au client (§13.2). Il peut donc
  forger un ticket sur sa propre installation. Ce n'est **pas** une fuite de
  revenu : le paquet, lui, est signé par une clé **asymétrique** dont il n'a que
  la partie publique (§10.2), et le code non acheté n'est pas dans son arbre
  (D-E, I-3). Ce qu'il contourne est sa propre gouvernance interne ;
- les deux chemins allégés sont donc bornés par ce qu'ils **ne peuvent pas**
  faire, non par qui les déclenche : le bris de glace **n'exécute aucune
  migration**, le delta de sécurité **ne migre rien et ne fusionne rien**. Ce
  sont ces deux interdits qui portent la sûreté, pas l'authentification absente ;
- les deux écrivent une ligne d'audit marquée. Un chemin allégé **non tracé**
  serait, lui, une vraie faille — de gouvernance.

---

## 14. Les migrations (le point le plus dangereux du chantier)

Décision D-F : le runner exécute. C'est ce qui rend l'installation atomique — et
c'est le composant à écrire avec le plus de soin de tout le document.

### 14.1 Contrat d'une migration de paquet

Toute migration livrée expose **trois** fonctions, pas une :

| Fonction | Rôle | Contrainte |
|---|---|---|
| `up(session)` | Applique | **Idempotente** — rejouable sans dommage |
| `down(session)` | Annule | Testée en intégration continue, sur la fixture, **à chaque livraison** |
| `verify()` | Constate | Retourne un compte ou un booléen vérifiable, jamais « ok » |

`down` non testé = `down` inexistant. C'est la règle qui décide si « sans risque »
est une promesse ou un argument de vente.

### 14.2 Ce que les 10 scripts existants enseignent

`scripts/migrate-*.js` (10 scripts) est le corpus de référence de ce à quoi
ressemblent réellement les migrations de ce produit — et deux d'entre eux ont
récemment échoué pour des raisons instructives, consignées dans l'historique
(`RES-①` : une migration qui ne pouvait pas se connecter ; `RES-②` : une
migration visant une collection inexistante). **Les deux auraient été attrapées
par une étape `verify` et par un essai à blanc comptant les documents touchés.**
C'est la meilleure justification empirique du contrat en trois fonctions, et elle
vient de votre propre dépôt.

### 14.3 La contrainte d'exploitation qui en découle

`up`/`down` s'exécutent dans une transaction (`startSession()`), comme les 13
fichiers du dépôt qui le font déjà. **Les transactions MongoDB exigent un replica
set.** Un client qui installe un `mongod` autonome n'a pas seulement un problème
de migration : la suppression définitive, les workflows de résultats et
d'examens, la GED et les contrôleurs génériques échouent déjà chez lui.

C'est un **prérequis d'installation à vérifier au démarrage**, pas une note de
bas de page (§18).

### 14.4 Ce qu'on refuse

- **Aucune migration destructive dans un paquet.** Une suppression de champ se
  fait en deux versions : la version *n* cesse d'écrire, la version *n+1* purge —
  et la purge est un paquet distinct, avec sa propre porte.
- **Aucune migration de plus de N documents sans confirmation renforcée**, sur le
  modèle de `MAX_CASCADE_DOCUMENTS` (5000) déjà en vigueur pour les cascades.
- **Aucune migration qui suppose une fenêtre de maintenance non annoncée.** Voir
  §14.5 : la contrainte est levée par la règle *expand-only*, pas par un arrêt
  du serveur.

### 14.5 Expand-only — la règle qui lève la contradiction

La première rédaction exigeait que le runner refuse de démarrer si l'application
tournait. **C'était contradictoire** : l'interface qui déclenche l'installation
vit *dans* l'ERP du client (§15.3). Exiger l'arrêt de l'application, c'est
éteindre l'écran depuis lequel on clique.

**Résolution : toute migration de paquet est *expand-only*** — rétro-compatible
avec le code en cours d'exécution.

| Étape | Ce qui est permis | Quand |
|---|---|---|
| **Expand** | Ajouter un champ, un index, une collection ; remplir. **Le code en cours d'exécution continue de fonctionner sans rien savoir** | Dans le paquet |
| **Migrate** | Le nouveau code lit et écrit le nouveau schéma | Au redémarrage qui suit |
| **Contract** | Retirer l'ancien champ, purger | **Paquet ultérieur, jamais le même** |

Ce que cela achète : aucune fenêtre de maintenance pour la migration ; un
redémarrage applicatif court pour le code ; et la garantie qu'un retour arrière
immédiat ne laisse pas un schéma en avance sur son code. Ce que cela coûte : deux
livraisons pour toute suppression — ce que §14.4 exigeait déjà pour une autre
raison. Les deux règles se renforcent au lieu de se contredire.

### 14.6 La fenêtre de retour arrière est bornée — et il faut le dire au client

`down` n'est **pas** un bouton d'annulation permanent. Il est fiable tant que la
fonctionnalité n'a produit aucune donnée ; passé ce point, l'annuler détruit du
travail réel des utilisateurs.

| Moment | Retour arrière |
|---|---|
| Immédiatement après l'installation, avant remise en service | **`down` + retour git** — sûr, mécanique, c'est le cas nominal |
| Après remise en service, avant la première écriture | `down` encore sûr — le runner **compte** avant d'agir |
| Après des écritures | **Roll-forward uniquement.** Le runner refuse `down` et propose un correctif ou une désinstallation avec conservation des données (§16.7) |

Le rapport d'impact annonce cette fenêtre **avant** l'installation. Un client qui
croit disposer d'une annulation permanente prend des risques qu'il n'aurait pas
pris.

---

## 15. Le catalogue et l'interface

Le principe posé par le porteur — **l'utilisateur sélectionne, il ne rédige
jamais de prompt** — est retenu tel quel. C'est le bon choix : il supprime toute
une classe de risques (injection, dérive de portée, attente irréaliste) et il
rend l'offre lisible.

Le seul ajustement porte sur une confusion à éviter : **sélection seulement ≠
installation sans décision.**

### 15.1 Anatomie d'une carte

```
┌──────────────────────────────────────────────────────────┐
│  [ vidéo de démonstration ]                              │
│                                                          │
│  Génération automatique d'emplois du temps        (gaet) │
│  ────────────────────────────────────────────────────────│
│  ● Installable automatiquement          ← badge CALCULÉ  │
│    pour votre installation                 (§12)         │
│                                                          │
│  Portée : 10 fichiers · 1 route · 0 migration            │
│  Requiert : campus, class, subject, teacher  ✓ présents  │
│  Contrat : 2.0–2.x    ✓ vous êtes en 2.1.0               │
│  Durée estimée : 3 min · redémarrage requis              │
│                                                          │
│  Prix : …                                                │
│                                                          │
│  [ En savoir plus ]  [ Simuler l'installation ]  [ Installer ] │
└──────────────────────────────────────────────────────────┘
```

Les trois éléments qui manquaient à la conception d'origine :

- **Le badge de compatibilité est calculé pour CE client** (§12), pas générique.
  Une carte qui affiche « installable » à quelqu'un dont le fork ne le permet pas
  est un remboursement, puis une réputation.
- **La portée est annoncée avant l'achat** — combien de fichiers, combien de
  migrations, redémarrage ou non. C'est ce qui distingue un fournisseur d'un
  vendeur.
- **« Simuler l'installation »** (essai à blanc, §13 étape 4) est un bouton de
  premier plan, pas une option cachée. Il ne coûte rien et il désamorce la
  totalité de l'angoisse d'un directeur informatique.

### 15.2 Les deux écrans qui manquaient

- **Historique des mises à jour** — alimenté par `InstallAudit`, refus compris.
  C'est le premier écran qu'un auditeur ou un successeur ouvrira ; sans lui,
  personne chez le client ne sait ce qui a été installé, par qui, ni pourquoi.
- **État de l'installation** — palier, version de contrat, paquets et versions,
  divergence du tronc, prérequis d'exploitation. C'est le pendant client du
  diagnostic, et c'est ce qu'on demande de joindre à toute demande de support.

### 15.3 Où cette interface vit

Dans **leur** ERP, pas chez vous (D-B) : un module `marketplace` du frontend,
appelant le runner local. Le catalogue distant n'est qu'une source de données en
lecture seule, remplaçable par un bundle hors-ligne.

---

## 16. Les bords

Section volontairement séparée : ce sont les points qu'on est tenté de reporter
et qui produisent les incidents visibles. La leçon est déjà écrite dans
`CAMPUS_ENTITLEMENT_DESIGN.md` §9 — elle s'applique ici mot pour mot.

### 16.1 i18n — 10 locales × 18 namespaces

Un paquet livre **10 fichiers de traduction ou aucun**. Une fonctionnalité
livrée en anglais seul sur un ERP qui promet 10 langues est une régression
visible pour tous les utilisateurs non anglophones du client.

- Le manifeste déclare le namespace ; le runner fusionne les 10 fichiers **dans
  `public/locales/` et dans `dist/locales/`** — les deux, sinon l'installation
  n'est visible qu'à la prochaine reconstruction, ou disparaît à celle-ci. Le
  détail et la raison : §9.6, point 1.
- **Les surcharges locales du client sont en zone `extension`** : elles survivent
  à la mise à jour. Un client qui a renommé « Étudiant » en « Auditeur » ne doit
  pas retrouver son vocabulaire écrasé. La fusion est donc **par clé**, jamais
  par remplacement de fichier.
- `tests/unit/i18n.test.js` existe déjà côté backend : le contrôle de complétude
  doit s'étendre au paquet, **à la génération** — un paquet incomplet est refusé
  chez le vendeur, pas chez le client.

### 16.2 Crons — émission contre hygiène

La distinction `CRON_NATURE` (`EMISSION` / `HYGIENE`) est déjà posée et son
raisonnement est déjà écrit : *« Stopping the document retention sweep keeps
personal data beyond its lawful period: a silent compliance breach, not a UX
detail »*. Elle se transpose sans changement : un paquet désinstallé ou absent
ne fait pas taire un job d'hygiène qui appartient au socle.

Un paquet qui apporte un cron d'émission doit déclarer son horaire **en UTC** —
`register-jobs.js` fixe déjà `CRON_TIMEZONE = 'UTC'` pour une raison consignée
(une fermeture mensuelle qui se déclenchait un mois trop tard à l'ouest de
Greenwich). Chez un client à Douala, Abidjan ou Dakar, cette question se repose
telle quelle.

### 16.3 Frontend — la navigation et les routes

Les entrées portent déjà `feature: '<clé>'`. Ce qui manque est le sens inverse :
un paquet doit pouvoir **ajouter** une entrée sans éditer un des **10** fichiers
`src/routes/*Routes.jsx` (`Admin` · `Campus` · **`Client`** · `Director` ·
`Mentor` · `Parent` · `Partner` · `Staff` · `Student` · `Teacher`). Registre de
contributions, chargé au démarrage de l'application, avec une position déclarée
(`portal` + `section` + ancre) plutôt qu'un indice numérique — un indice se
décale dès qu'un autre paquet s'installe. Mécanique complète en §9.5.

### 16.4 L'ai-service, cas particulier assumé

Le module `ai` (palier premium) n'est **pas** auto-portant : il suppose un
service Python, un PostgreSQL avec pgvector, et une clé de fournisseur de
modèles. Pour un client auto-hébergé, c'est une charge d'exploitation qui
contredit frontalement l'argument « moins de développeurs ».

Trois options, à trancher (§23, D-J) — mais **le module `ai` ne doit pas être
traité comme un plugin ordinaire dans la V1**. Le vendre comme tel produirait une
installation en échec, à répétition, sur le module le plus cher du catalogue.

### 16.5 Le stockage documentaire

`assertPersistentStorage()` refuse déjà le démarrage si le stockage sélectionné
ne survit pas à un redéploiement — un incident réel du dépôt (« B8-① »). En mode
licencié, le fournisseur Cloudinary est en général **exclu** (souveraineté) : le
client sera sur disque monté. Le préflight existe et fait le travail ; le
diagnostic de fork doit simplement le remonter avant la vente plutôt qu'au
premier démarrage raté.

### 16.6 Le portail public

`public-portal` (palier premium) est fonctionnellement lié à la brique 4
(Next.js, dépôt séparé, `/home/adminsecu/Projects/partner`). Le vendre à un
client auto-hébergé implique de livrer **deux** dépôts et de câbler
`ERP_API_URL` / `PORTAL_API_KEY` / `NEXT_PUBLIC_PORTAL_URL`. À traiter comme
l'IA : un paquet « à deux briques », pas un plugin ordinaire.

### 16.7 La désinstallation — absente de la première rédaction

Le document ne traitait que l'installation. Or trois cas surviendront, et deux
sont certains : un client cesse de payer un module ; un client veut retirer une
fonctionnalité qu'il n'utilise pas ; un paquet doit être retiré parce qu'il est
défectueux.

**Règle : désinstaller retire du code, jamais des données.**

| Ce que la désinstallation fait | Ce qu'elle ne fait **jamais** |
|---|---|
| Retire `modules/<clé>/` et la déclaration (§9.A) | Supprimer une collection |
| Retire les pages, le service, les entrées de navigation | Supprimer un document |
| Reconstruit le frontend (§11.4) | Exécuter le `down` d'une migration ancienne |
| Bascule l'entitlement du module en **`read_only`** | Le basculer en `hidden` |
| Écrit la ligne d'audit | — |

Le choix de `read_only` plutôt que `hidden` n'est pas cosmétique : il est déjà
la doctrine du produit. `CAMPUS_ENTITLEMENT_DESIGN.md` §4.1 le dit —
*« `read_only` … is the correct answer to "this campus must stop using X", never
`hidden` »* — et quatre modules (`result`, `finance`, `exam`, `document`) portent
déjà un plancher `minState: read_only` avec les modèles qui le justifient. Un
établissement qui cesse de payer le module Finance doit continuer à **lire** ses
écritures : ce sont ses pièces comptables, pas les vôtres.

⚠️ **Conséquence non évidente** : si le code du module est retiré, ses routes
n'existent plus, et `read_only` n'a plus rien à servir — l'historique devient
illisible. Deux sorties, à trancher (§23, D-N) : soit la désinstallation
**conserve la surface de lecture** du module (retirer les écritures, garder les
`GET`), soit elle est refusée pour les quatre modules à plancher, qui ne peuvent
alors qu'être gelés. **Recommandation : conserver la lecture** — c'est le seul
comportement qui ne transforme pas une fin de contrat en perte d'accès aux
archives d'un établissement.

### 16.8 Deux paquets qui se marchent dessus

Trois collisions sont prévisibles dès le troisième paquet installé :

| Collision | Règle |
|---|---|
| Deux paquets contribuant des relations à l'entrée `campus` agrégée | **Union**, dédupliquée par *(modèle, chemin)*. Un doublon exact est ignoré ; un désaccord de mode (`CASCADE` contre `BLOCK`) est une **erreur d'installation**, jamais une résolution silencieuse |
| Deux entrées de navigation à la même place | Position déclarée par *(portail, section, clé d'ancrage)* et **jamais par indice numérique** — un indice se décale dès qu'un autre paquet s'installe. À égalité, ordre alphabétique de la clé : arbitraire mais **déterministe**, donc reproductible d'une installation à l'autre |
| Deux paquets déclarant la même dépendance npm en versions incompatibles | Refus à l'installation, avec les deux plages affichées. Jamais de résolution automatique : c'est la porte d'entrée classique d'une casse silencieuse |

Principe commun : **une collision se refuse bruyamment.** Toute résolution
automatique produit un arbre que personne n'a décidé et que le vendeur ne peut
pas reproduire pour diagnostiquer.

---

## 17. Sécurité, propriété intellectuelle, chaîne d'approvisionnement

### 17.1 Ce que D-B élimine d'emblée

En n'ayant **aucun** accès au code ni à la base du client, vous supprimez :
le vol de credentials clients par compromission de votre infrastructure ; le
risque d'être le vecteur d'une compromission d'établissement ; l'essentiel de
l'exposition de propriété intellectuelle croisée ; et la question, autrement
inextricable, de la responsabilité en cas d'incident sur leur production.

C'est la décision la plus rentable du document. Elle ne coûte qu'une chose : vous
ne pouvez pas « aller voir » quand un client a un problème. C'est le prix, et il
faut le payer — le diagnostic de fork (§12) et l'écran d'état (§15.2) sont
conçus pour rendre le support possible sans accès.

### 17.2 Signature et provenance

- Tout paquet est signé ; le runner **refuse** un paquet non signé, sans option
  pour outrepasser. Une option d'outrepassement est celle qu'on utilise un
  mardi soir sous pression.
- Les condensés sont **par fichier** (§8).
- La ligne d'audit porte l'empreinte de licence : chaque installation est
  attribuable.

**Amorçage de la confiance.** La clé publique voyage dans le build ; le build
lui-même doit donc être vérifiable autrement. Son empreinte est publiée **hors
bande** (site, contrat papier, courriel signé) et vérifiée par le client à la
réception. Sans cette étape, toute la chaîne de signature vérifie un artefact
contre une clé livrée par le même canal que l'artefact — ce qui ne vérifie rien.

**Rotation — à prévoir dès la V1, pas quand elle sera nécessaire.** Si la clé
privée est compromise, tous les builds déjà déployés embarquent la clé publique
compromise, et les mettre à jour suppose un canal de confiance… qu'on vient
précisément de perdre. La parade est triviale à la conception et impossible
après : **embarquer deux clés dès le premier build** — la courante et la
suivante — chacune avec son `kid`. Une rotation devient alors la promotion de la
seconde, sans nouveau canal de confiance. C'est dix lignes en phase 1 ; c'est un
rappel de tous les clients autrement.

### 17.3 Isolation entre clients

Si un agent lit un jour du code client (niveaux 3-4, hors V1) : **sandbox par
client, aucun contexte partagé, aucun index vectoriel commun, aucune
réutilisation d'un client à l'autre.** C'est exactement la discipline d'isolation
campus du produit, transposée aux clients — et il vaut mieux l'écrire maintenant,
tant qu'il n'y a aucun code à corriger.

### 17.4 Le canal de sécurité — et la contradiction qu'il faut lever

Le principe ne bouge pas : **gratuit, prioritaire, poussé à tous**, quelle que
soit l'échéance de support. C'est ce qui rend le modèle de licence défendable,
ce qui vous garde une raison légitime de contacter chaque client, et ce qui vous
évite d'être le fournisseur dont la faille est restée ouverte chez douze
universités parce que le support avait expiré.

**Mais la première rédaction le rendait inapplicable, et il faut le voir.** Une
faille se corrige presque toujours dans `shared/`, dans un middleware ou dans un
module `core` — c'est-à-dire **dans le tronc**. Un correctif de sécurité est donc
un N3, et le N3 est explicitement hors V1 (§5). Le canal promis n'aurait eu
aucune machinerie pour livrer quoi que ce soit.

**Résolution : le correctif de sécurité est un troisième objet, ni paquet ni
patch de fusion.** C'est un **delta de tronc signé**, avec des propriétés
volontairement plus pauvres que celles d'un paquet — et c'est ce qui le rend
livrable tout de suite :

| Propriété | Paquet (N1/N2) | Delta de sécurité |
|---|---|---|
| Portée | Un module | Quelques fichiers du tronc, nommés |
| Fusion avec les modifications du client | Garantie sur les zones | **Aucune** — voir ci-dessous |
| Migration | Possible | **Interdite** |
| Fichier divergent chez le client | Sans objet | **Refus**, avec le chemin exact et la procédure manuelle |
| Porte | Complète (§13) | Allégée : motif + confirmation, **jamais** de mot de passe (un correctif ne doit pas attendre qu'un titulaire de compte soit joignable). Ce que cette dispense coûte, et pourquoi elle est bornée : §13.4 |

Un delta de sécurité **ne tente jamais de fusionner**. Il applique un contenu
exact sur un fichier dont il a vérifié le condensé au préalable, ou il refuse. Un
refus n'est pas un échec du dispositif : c'est le cas prévu, et il ouvre une
prestation courte (N4) sur un périmètre de quelques fichiers, pas sur un module.

C'est une machinerie **beaucoup** plus simple que N3 précisément parce qu'elle ne
cherche pas à préserver le travail du client : elle le constate et s'arrête.
Elle est donc réalisable en V1, contrairement à N3, et elle tient la promesse.

Conséquence : la **liste des installations** (qui a quoi, en quelle version) est
un actif d'exploitation, pas un confort. Elle est le minimum de télémétrie
défendable (§23, D-H) — sans elle, vous ne savez pas qui prévenir.

---

## 18. Prérequis d'exploitation on-premise

À vérifier par le diagnostic (§12) **avant la vente**, et par le runner avant
toute installation. Ils sont invisibles en mode hébergé parce que vous contrôlez
l'environnement ; en mode licencié, chacun est un échec d'installation.

| Prérequis | Pourquoi | Vérifié où |
|---|---|---|
| **MongoDB en replica set** (même mono-nœud) | **11 fichiers de production** utilisent `startSession()` (relevé le 2026-08-21). Sans replica set : suppression définitive, workflows résultats/examens, GED, contrôleurs génériques **et toutes les migrations** échouent | Démarrage + runner |
| **Stockage persistant vérifié** | `assertPersistentStorage()` refuse déjà le démarrage. Sans lui : perte silencieuse de tous les documents au redéploiement | Démarrage (existe) |
| **Node 20.x** | `engines` déclaré dans `package.json` | Runner |
| **`JWT_SECRET` propre au client** | Un secret partagé entre installations serait une catastrophe transversale | Démarrage |
| **Chromium disponible** | Puppeteer : GED et impression académique | Runner |
| **Redis (optionnel)** | Limitation de débit distribuée et cache IA ; dégradation propre sans | Runner (avertissement) |
| **Sauvegardes opérationnelles** | D-F l'exige avant toute migration | Runner (bloquant) |

Cette table est aussi, telle quelle, l'annexe technique du contrat de vente.

---

## 19. Registre des risques

| # | Risque | Gravité | Traitement retenu |
|---|---|---|---|
| **R-1** | Le client cesse d'acheter une fois la source en main | **Élevée** | Non traité techniquement — c'est le modèle. Atténué par le prix relatif, la garantie et le support (§1.1). À accepter consciemment, pas à contourner |
| **R-2** | Divergence du fork rendant les mises à jour inapplicables | Élevée | Zones (D-D) + diagnostic (§12) + déclassement tarifé en N4 |
| **R-3** | Migration cassant la production d'un établissement | **Critique** | `up`/`down`/`verify` + sauvegarde relue + essai à blanc + transaction + porte (§13, §14) |
| **R-4** | Installation partielle après coupure | Élevée | Branche git + état de migration séparé + idempotence + condensé par fichier (§11.3) |
| **R-5** | Paquet livré sans ses 10 traductions | Moyenne | Contrôle de complétude à la génération (§16.1) |
| **R-6** | Modèle scopé campus non déclaré au registre de suppression | Élevée | Entrée `campus` agrégée + suite d'invariants exécutée chez le client (§9.4) |
| **R-7** | Prérequis d'exploitation absent découvert tardivement | Moyenne | Diagnostic avant vente (§18) |
| **R-8** | Faille de sécurité non diffusable à la flotte | **Critique** | Canal séparé gratuit + liste d'installations (§17.4) |
| **R-9** | Dérive entre le tronc et l'extracteur (fichier oublié dans un paquet) | Élevée | Extracteur **unique** dans les deux sens (§7) + 3 builds de palier validés en CI |
| **R-10** | Combinatoire de tests ingérable | Moyenne | **Écarté par D-E** : 3 paliers, pas 8192 combinaisons |
| **R-11** | Économie unitaire négative sur un paquet bon marché | Moyenne | Le niveau est constaté avant la vente ; N3/N4 sont facturés en prestation |
| **R-12** | Le produit se dédouble (ERP + outil de distribution) | Élevée | I-1 + I-2 : un seul dépôt, et le dispositif doit marcher **sans** agent |
| **R-13** | Le contrat de plateforme se fige et bloque le produit | Moyenne | Un changement majeur se livre par snapshot de palier, pas par paquet (§6.1) |
| **R-14** | Clé privée de signature compromise | **Critique** | Hors ligne, **deux clés embarquées dès le premier build** + `kid` (§17.2) |
| **R-15** | Frontend non reconstruit : installation « réussie » sans effet visible | **Critique** | Reconstruction dans le runner + basculement atomique de `dist/` + reconstruction à blanc dans la simulation (§11.4) |
| **R-16** | Installation modifiant un fichier du tronc, donc s'auto-déclassant en N4 | **Critique** | Registre éclaté en déclarations par module (§9.A) — **préalable, pas option** |
| **R-17** | Test vert qui ne vérifie plus rien après le passage au montage dérivé | Élevée | Assertion sur la pile de routeurs de l'app assemblée, pas sur le texte de `app.js` (§9.1) |
| **R-18** | Panne pendant la migration : la ligne d'audit est celle qu'on ne peut pas écrire | Élevée | Journal `install.log.jsonl` local comme source de vérité ; la ligne en base est une projection (§13.3) |
| **R-19** | Client croyant disposer d'une annulation permanente | Moyenne | Fenêtre de retour arrière bornée, annoncée **avant** l'installation (§14.6) |
| **R-20** | Fin de contrat transformée en perte d'accès aux archives | Élevée | Désinstallation = `read_only` avec surface de lecture conservée, jamais suppression de données (§16.7) |
| **R-21** | Correctif de sécurité non livrable faute de machinerie N3 | **Critique** | Delta de tronc signé, sans fusion, sans migration, porte allégée (§17.4) |
| **R-22** | Dépendances npm non élaguées : `free` embarque Puppeteer | Moyenne | Dépendances déclarées par module, élaguées par soustraction **prudente** (§7.4) |
| **R-23** | **Arête runtime non déclarée : un palier livré ne démarre pas, ou lève sur sa route la plus utilisée** | **Critique** | Quatrième validation de l'extracteur, dérivée du code et non de la déclaration (§7.2 n°4) + `usesModels` + `optionalModel()` (§9.3). **Un cas est actif aujourd'hui** : `student → Mentor` casse le palier `free` (§2.3 bis) |
| **R-24** | Verrou npm irréconciliable : `npm ci` refuse, `npm install` casse l'égalité au bit près | Élevée | Le verrou est calculé par l'extracteur et voyage dans le paquet ; le runner ne résout jamais une version (§7.4.1). §20.1 exclut le verrou du bit près et lui substitue une égalité sémantique |
| **R-25** | Montage dérivé produisant de mauvaises URLs (`/api/public/public/…`) ou perdant `/internal/ai` | Élevée | `mount` distinct de `routers`, `routers` en objets porteurs de leur export, `UNGATED_MOUNTS` monté en seconde passe, `mountOrder` total (§9.1) |
| **R-26** | Mise à jour écrasant en silence un fichier que le client a modifié en zone `plugins` | Élevée | Le diagnostic condense la zone `plugins` comme le tronc et **s'arrête en nommant les fichiers** (§12.1 n°2) |
| **R-27** | Traduction installée invisible, ou effacée à la reconstruction suivante | Moyenne | Écriture dans `public/locales/` **et** `dist/locales/`, vérifiée à l'étape 8 (§9.6, §16.1) |
| **R-28** | Éclatement du registre observé à mi-composition, ou déclaration en double | Élevée | Composition synchrone et complète au premier accès, échec **bruyant** au démarrage, validé d'abord sur le mode hébergé qui est en production (§9.A) |

---

## 20. Phases et charge

Estimations pour **un développeur connaissant ce dépôt**. Les phases 0 à 2 ont
une valeur propre même si la suite est abandonnée.

> **Révision v1.2 (2026-08-21) : ~54 → ~62 j.** La v1.1 chiffrait du
> non-spécifié : la phase 3 valait 10 j pour six listes dont **quatre n'avaient
> aucun corps** (§9.2, §9.3, §9.5, §9.6). Les avoir rédigées fait apparaître le
> travail réel — et §9.3 déplace en amont, vers la phase 0 bis, le correctif des
> arêtes runtime (§2.3 bis) dont l'extracteur dépend. §9.1, requalifiée de
> « Faible » à « Moyenne », y ajoute `mount`/`mountOrder`/`UNGATED_MOUNTS`.
>
> **Révision v1.1.** L'estimation initiale (34 j) était **fausse par omission** :
> elle ignorait la reconstruction du frontend (§11.4), la livraison multi-briques
> (§7.3), l'élagage des dépendances (§7.4), la désinstallation (§16.7), l'éclatement
> du registre (§9.A) et le canal de sécurité (§17.4).
>
> Le chiffre ci-dessous est du même ordre que ce que coûtent réellement les
> chantiers comparables de ce dépôt, et il reste une estimation — pas un
> engagement. **Deux révisions successives à la hausse, toutes deux par
> omission de bords, doivent être lues comme une propriété du chantier** : ce qui
> reste sous-spécifié dans ce document coûte plus que ce qui y est écrit.

| Phase | Contenu | Livrable vérifiable | Charge |
|---|---|---|---|
| **0 · Contrat** | Tags git · version produit réelle · `platform.contract.json` (zones + ABI **extraite du code**) · règle ESLint + test d'ABI | `npm run lint` refuse un import hors ABI ; `git describe` répond | **4 j** |
| **0 bis · Éclatement du registre + graphe runtime** | `modules/<clé>/<clé>.feature.js` (registre · `mount`/`mountOrder` · crons · modèles · deps npm) · agrégateur avec échec bruyant · 4 suites de tests réalignées (§9.A) · **`usesModels` + `optionalModel()` + 4ᵉ validation (§7.2, §9.3)** · **correctif `student → Mentor` et `campus → Document`** (§2.3 bis) | Le registre composé est identique à l'actuel, tests verts, **et un build `free` simulé ne lève plus** | **7 j** |
| **1 · Licence** | Paire de clés (×2, §17.2) · émetteur hors ligne · vérificateur embarqué · lecture des quotas · écran d'état | Une licence falsifiée est refusée ; une licence absente ne change rien à l'exécution | **4 j** |
| **2 · Extracteur** | `extract(<clé>)` · `build --tier` (3 paliers) **× 2 briques** · élagage npm **et paires de verrous pré-calculées** (§7.4.1) · manifeste · signature · CI sur les 3 builds | Les 3 snapshots démarrent, se construisent et passent leur suite | **10 j** |
| **3 · ABI de plugin** | Les 6 listes contributives (§9.1 à §9.6) · montage dérivé avec `mount`/`mountOrder`/`UNGATED_MOUNTS` · assertion sur la pile de routeurs (§9.1) · entrée `campus` agrégée · règles de collision (§16.8) | Un module retiré puis réinstallé donne un arbre **identique** au tronc, brique par brique (§20.1) | **13 j** |
| **4 · Runner + porte** | Diagnostic · essai à blanc · **reconstruction frontend** · ticket émis par l'ERP (§13.2) · double journal (§13.3) · migrations expand-only `up`/`down`/`verify` | Installation, annulation, et audit des deux | **12 j** |
| **5 · Catalogue + bords** | Module `marketplace` · badges calculés · historique · désinstallation · i18n **double écriture `public/` + `dist/`** · crons · navigation contributive **sur les 10 portails** | Un client installe puis désinstalle `gaet` de bout en bout, hors ligne | **8 j** |
| **6 · Canal de sécurité** | Delta de tronc signé · vérification de condensé · porte allégée · diffusion | Un correctif atteint un fork divergent, ou refuse en le nommant | **4 j** |
| | | | **≈ 62 j** |

**Hors V1**, explicitement : N3 (patch du tronc avec fusion), l'agent lui-même, le
module `ai` on-premise (D-J), le portail public on-premise, et tout ce qui suppose
CH-0/CH-1/CH-2 de `QA_TEST_STRATEGY.md`.

**Si 62 jours est hors budget**, le repli n'est pas de rogner sur les phases : il
est de s'arrêter après la phase 2 et de vendre des **snapshots de palier
annuels** sans livraison à l'unité (l'alternative « ne rien faire » du §3.3). Un
dispositif à moitié construit — des paquets sans porte, ou une porte sans
reconstruction frontend — est plus dangereux que pas de dispositif.

### 20.1 Le test d'acceptation de la phase 3

Le seul qui compte, et il est mécanique :

> Retirer un module d'un build par l'extracteur, puis le réinstaller par le
> runner, doit produire un arbre **identique au bit près** au tronc de départ —
> **sur tous les fichiers versionnés sauf les verrous de dépendances**, et
> **brique par brique** (§7.3).

Si cette égalité n'est pas atteinte, l'extracteur et l'installateur ne parlent
pas de la même chose — et tout le reste du dispositif repose sur du sable. Ce test
est peu coûteux à écrire et il attrape la quasi-totalité des erreurs de tranche.

**Les deux exclusions sont bornées et justifiées, pas des échappatoires :**

| Fichier | Critère substitué | Pourquoi pas le bit près |
|---|---|---|
| `package-lock.json` (× brique) | **Égalité sémantique** : arbre résolu `nom@version` identique après normalisation | Le verrou n'est pas reproductible au bit près entre machines. Il est de toute façon fourni pré-calculé par l'extracteur (§7.4.1), donc l'écart ne peut venir que d'une résolution chez le client — que ce même critère détecte |
| `dist/` (× brique) | **Aucun** — hors périmètre | Sortie de build, non versionnée. La vérification correspondante est fonctionnelle : la reconstruction aboutit, et la route du module répond (§13, étape 8) |

Tout le reste — code, manifeste, déclarations de module, traductions, tests,
`package.json` — est au bit près, sans exception. En particulier, **le
`package.json` y est** : c'est lui que §9.A rend atteignable, et c'est là que se
verrait un élagage npm asymétrique (§7.4).

### 20.2 Ordre imposé

**0 → 0 bis → 1 → 2 → 3 → 4 → 5**, la phase 6 pouvant être avancée dès que la
phase 2 est acquise (elle ne dépend que de la signature et du condensé de
fichiers, pas de l'ABI). Aucune autre permutation n'est sûre :

- la phase 0 bis avant tout le reste du §9 : sans registre éclaté, chaque
  installation modifie le tronc et s'auto-déclasse (§9.A) ;
- **la phase 0 bis avant la phase 2**, et pas seulement avant le §9 : l'extracteur
  taille selon le graphe du registre. Tant que ce graphe est incomplet (§2.3 bis),
  il produit des paliers qui lèvent à l'exécution — et il les produit *en
  silence*, puisque les validations 1 et 2 passent. Bâtir l'extracteur d'abord,
  c'est industrialiser un défaut ;
- la phase 2 sans la phase 0 produit des paquets qui ne savent pas contre quoi
  ils sont compatibles ;
- la phase 4 sans la phase 3 installe des paquets qui ne peuvent pas se monter ;
- **la phase 4 sans la reconstruction frontend** (§11.4) livre un dispositif qui
  rapporte des succès faux — pire que pas de dispositif ;
- **commencer par l'agent** — la tentation naturelle — revient à écrire un
  transporteur avant qu'existe la chose à transporter.

---

## 21. Articulation avec les chantiers existants

| Chantier | Relation | Conséquence |
|---|---|---|
| **Entitlement par campus** (phases 0-3 livrées ; **4-5 en cours dans l'arbre de travail** au 2026-08-20 : `entitlement.jobs.js`, `portal-campus.js`, crons et portail public) | **Fondation.** Le registre est le catalogue ; les gates sont dérivées ; `useFeature()` est l'ancrage frontend | Aucun retour en arrière. La seule évolution demandée : rendre l'entrée `campus` du registre de suppression agrégée (§9.4). **Ne pas transformer le gate en serrure** (§10.3) |
| **Stratégie de test** (CH-0..CH-7, non démarrés) | **Prérequis de N3, pas de la V1** | La V1 se contente de la suite d'invariants existante livrée avec le build (§9.4). CH-0 (fixture déterministe) devient le premier prérequis dès qu'on vise N3 |
| **Migration PostgreSQL** (évaluée, non engagée) | **Interaction forte** | Un changement de moteur est un changement **majeur** de contrat, donc un nouveau snapshot de palier. Trois garde-fous : ne pas exposer Mongoose dans l'ABI, garder les migrations dans le contrat en trois fonctions, ne pas laisser fuiter d'ObjectId dans le manifeste |
| **Phase 3 IA** (M0-M6 livrés) | **Cas particulier** | Le module `ai` n'est pas un plugin ordinaire (§16.4, D-J) |
| **Cours `docs/cours/`** | **Angle mort à surveiller** | 12 fichiers de solution résolvent ce backend depuis leur position sur le disque, et les pistes 08-10 comptent des figures réelles (modules, routes, modèles). Un extracteur qui déplace ou retire des modules **fait mentir des leçons**. Lancer `docs/cours/check-solutions.sh` après la phase 2 et après la phase 3 — **mais réétalonner la ligne de base d'abord** : `CLAUDE.md` §11bis annonce « 34 solutions, toutes vertes », un chiffre que le dépôt de cours a dépassé et qui n'est plus vérifié. Hériter de rouges préexistants ferait porter à la phase 2 des défauts qu'elle n'a pas produits, et l'inverse — les noyer — est pire |

---

## 22. Ce que ce dispositif ne fera jamais

À dire au client, et à se redire en interne quand la tentation reviendra :

- **Empêcher la copie ou la revente du code.** Le client a la source. La licence
  atteste, elle ne verrouille pas (I-3).
- **Garantir l'absence de bug chez le client.** Elle garantit que le paquet est
  intègre, compatible, testé contre le tronc et réversible. Pas que le fork du
  client est sain.
- **Remplacer une revue humaine sur une modification du tronc.** N3 et N4 sont
  des prestations, pas des boutons.
- **Appliquer une migration sans sauvegarde vérifiée.** Le runner refuse, et
  ce n'est pas négociable. (Un delta de sécurité, §17.4, ne migre rien : son
  retour arrière est un retour git, et il n'exige donc pas de sauvegarde de
  base — c'est la seule exception, et elle est bornée par construction.)
- **Gérer les données du client.** C'est le sens de l'offre, pas une limite.
- **Livrer l'IA ou le portail public en un clic.** Deux briques
  supplémentaires, une charge d'exploitation réelle (§16.4, §16.6).

---

## 23. Décisions porteur en attente

| # | Question | Options | Recommandation |
|---|---|---|---|
| **D-G** | Granularité de vente : le module entier, ou des sous-fonctionnalités ? | (a) La clé de registre est l'unité ; (b) sous-fonctionnalités sur le modèle `AI_FEATURES` | **(a) par défaut**, (b) seulement quand un module le justifie — `ai` le fait déjà |
| **D-H** | Télémétrie | (a) Aucune ; (b) minimale et consentie (version, résultat d'installation, classe d'erreur) ; (c) étendue | **(b)** — sans elle, R-8 n'est pas traitable. Jamais de donnée métier, jamais bloquante |
| **D-I** | Durée du support incluse à l'achat | 12 / 24 mois, renouvelable | **12 mois**, renouvelable ; la licence de code reste perpétuelle (§10.1) |
| **D-J** | Sort du module `ai` en mode licencié | (a) Non vendu on-premise ; (b) vendu avec le service Python en paquet séparé ; (c) vendu en mode hébergé chez vous, avec la bascule de souveraineté que cela implique | **(a) pour la V1** — le vendre mal est pire que ne pas le vendre |
| **D-K** | Politique de version de contrat | Cadence et durée de support des contrats majeurs | À trancher avant la phase 0 : c'est ce qui décide de la durée de vie d'un paquet |
| **D-L** | Nom commercial du dispositif | — | Sans effet technique, mais le manifeste porte un `id` : le figer tôt évite une migration de nommage |
| **D-M** | Tension T-1 : exploitation chez le client | (a) Critère de qualification client ; (b) offre d'infogérance vendue à côté ; (c) les deux selon le compte | **(a) pour la V1.** (b) réintroduit un accès chez le client et doit être un contrat distinct, jamais une extension tacite du runner |
| **D-N** | Désinstallation d'un module à plancher (`result`, `finance`, `exam`, `document`) | (a) Conserver la surface de lecture ; (b) refuser la désinstallation, geler seulement | **(a)** — (b) transforme une fin de contrat en perte d'accès aux archives d'un établissement (§16.7, R-20) |

---

## 24. Mémoire du raisonnement — les objections à ne pas réapprendre

Consignées pour qu'un successeur ne refasse pas le chemin, et pour que les
raccourcis séduisants soient reconnus quand ils reviendront.

**« L'entitlement suffit, il ne reste qu'à le brancher sur une licence. »**
Non. Il *fail-open* par conception et le client a la source. En faire une serrure
inverse sa sémantique dans un seul des deux modes de livraison (I-1), introduit
un mode de défaillance qui éteint l'ERP d'un client pour une raison sans rapport
avec son usage, et ne gêne que ceux qui n'essayaient pas de contourner. Ce qui
protège réellement, c'est que le code non acheté n'est pas dans l'arbre (D-E).

**« Il suffit de copier le dossier du module. »**
Non. La tranche d'un module, ce sont aussi 1 à 3 montages, une entrée de registre,
0 à 1 cron, une entrée de suppression définitive **plus des relations sur l'entrée
`campus` qui n'est pas la sienne**, 0 à 1 migration, des pages, un service, des
schémas Yup, des entrées de navigation, et un namespace i18n × 10 locales.

**« L'agent adaptera le code à l'architecture du client. »**
Une adaptation sans critère de succès exécutable n'est pas vérifiable, et une
promesse de fiabilité invérifiable n'a pas de prix. C'est pourquoi la suite
d'invariants est livrée avec le build et exécutée chez le client (§9.4), et
pourquoi N3 est conditionné à CH-0/CH-1/CH-2.

**« La licence protège le revenu. »**
Elle trace. Elle refuse une installation. Elle rend l'usage non acheté impossible
**de bonne foi**. Elle n'empêche rien à un adversaire, et il ne faut pas dépenser
un jour de développement en croyant le contraire.

**« On peut commencer par l'agent, le reste suivra. »**
C'est l'ordre exactement inverse (§20.2). Sans paquet, sans manifeste, sans
contrat et sans runner, l'agent n'a rien de propre à transporter — et le
dispositif doit fonctionner entièrement sans lui (I-2).

**« Le registre, on l'éditera à l'installation, c'est trois lignes. »**
C'est un fichier du tronc. Par la règle des zones, chaque installation se
déclasserait elle-même en N4, et l'égalité au bit près (§20.1) deviendrait
impossible puisqu'il faudrait ré-insérer du texte dans un littéral d'objet en
préservant l'ordre des clés. La déclaration d'un module vit avec le module
(§9.A) — c'est le préalable de tout le §9, pas un raffinement.

**« Il suffit de déposer les fichiers du plugin dans `src/`. »**
Le frontend est un bundle Vite construit (18 Mo de `dist/` mesurés). Tant que
`dist/` n'est pas reconstruit, l'installation n'a produit **aucun** effet visible,
et le runner rapporterait un succès faux — le pire mode de défaillance possible
pour un dispositif dont l'argument est la fiabilité (§11.4, R-15).

**« Le correctif de sécurité passera par le même canal que les paquets. »**
Non : une faille se corrige dans le tronc, donc en N3, explicitement hors V1. Le
canal promis n'avait aucune machinerie derrière lui. Le correctif est un
troisième objet — delta de tronc signé, sans fusion, sans migration — et il est
plus simple que N3 précisément parce qu'il **refuse** au lieu de fusionner
(§17.4).

**« Le registre décrit le graphe de dépendances. »**
Il décrit ce qu'on a pensé à y écrire. Mongoose résout ses modèles **par nom, à
l'exécution** : `mongoose.model('X')`, `ref: 'X'`, `populate()`. Ces arêtes sont
réelles — un modèle absent fait *jeter*, pas dégrader — et aucune n'est déclarée
ni testée. Le grep de §2.3, qui ne voit que les `require`, en est structurellement
aveugle et a donné une fausse assurance pendant deux révisions. Un cas est actif :
`student` (core, `free`) fait `.populate('mentor')` vers un modèle `standard` non
déclaré, donc le palier `free` lève sur la liste des étudiants (§2.3 bis). La
parade est la quatrième validation de §7.2, dérivée du **code**, jamais de la
déclaration.

**« Le test de clôture des paliers nous couvre déjà. »**
Il ne couvre que les arêtes déclarées — sa boucle parcourt
`FEATURE_REGISTRY[key].dependsOn`, rien d'autre. Il prouve que *le graphe déclaré
est clos*, jamais que *le graphe déclaré est le graphe*. La v1.1 de ce document a
tiré la seconde conclusion de la première et en a déduit « rien à écrire » : c'est
l'erreur qui a laissé passer R-23.

**« Il suffit de boucler sur le registre pour monter les routers. »**
Le champ `routers` n'est pas le chemin de `app.use`. Pour quatre modules —
`student`, `teacher`, `staff` **et `public-portal`**, celui que la v1.1 oubliait —
il déclare les préfixes *exposés* alors que le montage réel est `/api` nu. Une
boucle naïve produit `/api/public/public/…`. Elle perd aussi `UNGATED_MOUNTS`,
donc `/internal/ai`, monté depuis un second export de façade qu'une liste plate de
chemins ne sait pas décrire. Et l'ordre, que `app.js` annonce comme sensible, n'a
aucune clé dans un registre agrégé depuis 26 fichiers (§9.1).

**« On fera les bords après. »**
C'est la phrase qui a produit les incidents documentés dans les autres documents
d'architecture de ce dépôt. Les bords ici sont : les migrations, les 10 locales,
les crons en UTC, le replica set, la navigation. Chacun est un échec
d'installation visible chez un client, un lundi matin.

---

## 25. Glossaire

| Terme | Définition dans ce document |
|---|---|
| **Snapshot** | Le code source livré à l'achat, taillé au palier (free 15 / standard 22 / premium 26 modules) |
| **Palier** (*tier*) | `free` / `standard` / `premium`, dérivés de `PLAN_PRESETS` |
| **Paquet** | Artefact autonome et signé livrant un module : code, manifeste, migrations, traductions, tests |
| **Manifeste** | `feature.manifest.json`, projection du registre — jamais une déclaration concurrente |
| **Contrat de plateforme** | Version + zones + ABI. Ce sur quoi un paquet a le droit de s'appuyer |
| **ABI** | Liste fermée des symboles importables depuis un plugin |
| **Zone** | `trunk` / `extension` / `plugins` / `client` — décide de la garantie de mise à jour |
| **Extracteur** | Le composant unique qui taille les snapshots et empaquette les plugins |
| **Runner** | L'exécutable qui s'exécute **chez le client** et installe |
| **Diagnostic de fork** | État local de l'installation, remonté en condensés uniquement |
| **Porte** | Les quatre contrôles d'installation, repris de `shared/lib/hard-delete/` |
| **Expand-only** | Migration rétro-compatible avec le code en cours d'exécution ; la suppression est reportée à un paquet ultérieur (§14.5) |
| **Delta de sécurité** | Correctif de tronc signé, sans fusion et sans migration : il applique un contenu exact sur un fichier au condensé vérifié, ou il refuse (§17.4) |
| **Zone `plugins`** | `modules/<clé non core>/**` — remplacé à chaque mise à jour ; le modifier déclasse ce module en N4 |
| **Arête runtime** | Dépendance entre modules que Mongoose résout par nom à l'exécution (`mongoose.model()`, `ref:`, `populate()`) — invisible au graphe d'imports, et **jetante** si la cible est absente (§2.3 bis) |
| **`mount` / `routers`** | `mount` = l'argument d'`app.use` (valeur unique) ; `routers` = les préfixes réellement exposés (liste). Les deux diffèrent pour 4 modules sur 26 (§9.1) |
| **Paire de verrous** | `package.json` + `package-lock.json` pré-calculés par l'extracteur pour un palier donné. Le runner les remplace et lance `npm ci` ; il ne résout jamais une version (§7.4.1) |
| **Niveau** (N0–N4) | Le mode de livraison applicable, **constaté** et non choisi |
