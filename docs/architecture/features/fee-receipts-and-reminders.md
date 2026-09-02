# Frais — reçu d'encaissement et relance avant échéance

> Note de conception, étape 1 du §12 de `CLAUDE.md`. Rédigée le 2026-08-25.
> Couvre la **ligne 6 de la phase 1-B** d'`ERP_ROADMAP.md` (2–3 j).
> Premier passage complet du patron §12 : ce document est la référence contre
> laquelle les audits des étapes 6 et 7 seront menés.

| Brique | Touchée | Ce qu'elle reçoit |
|---|---|---|
| `B1` backend | oui | modèle, service, route de reçu, second job de relance |
| `B2` frontend ERP | oui | bouton de téléchargement du reçu, i18n × 10 |
| `B3` ai-service | non | aucun contenu ingéré |
| `B4` portail | non | surface non publique |

---

## 1. Problème & périmètre

Deux manques mesurés sur un module par ailleurs livré :

1. **Aucun reçu n'est produit à l'encaissement.** `FeePayment` enregistre le montant,
   la méthode, la référence et l'encaisseur — l'étudiant ne repart avec rien.
2. **La relance ne part qu'une fois l'impayé constaté.** `runOverdueJob` (06:00,
   `register-jobs.js:120`) bascule les dettes échues en `overdue` puis relance. Rien
   n'avertit **avant** la date d'échéance, alors que c'est la seule fenêtre où la
   relance peut encore éviter l'impayé.

**Dans le périmètre** — génération du reçu PDF à l'encaissement, son téléchargement
depuis le grand livre étudiant, et une cadence de relance J-7 / J-3 / Jour J.

**Explicitement hors périmètre** — le paiement en ligne (aucun prestataire n'est
retenu, cf. arbitrages ouverts du §14 de la feuille de route) ; les avoirs et
remboursements ; le reçu des `Income` / `Expense`, qui ne sont pas des dettes
d'étudiant ; l'envoi du reçu par courriel en pièce jointe — le canal transporte
aujourd'hui du texte, l'y ajouter est un chantier de la brique notification.

## 2. Contrat

Source de vérité : le backend. Le frontend miroite, ne redéclare pas.

```js
// modules/finance/fee-reminder-kind.js
const REMINDER_KINDS = Object.freeze({
  DUE_IN_7D: 'due_in_7d',
  DUE_IN_3D: 'due_in_3d',
  DUE_TODAY: 'due_today',
  OVERDUE:   'overdue',    // existant, aujourd'hui implicite
});
```

| Route | Accès | Réponse |
|---|---|---|
| `GET /api/finance/payments/:id/receipt` | rôles finance du campus + l'étudiant propriétaire | `application/pdf` en flux, ou `sendNotFound` |

Codes d'erreur nouveaux : aucun. Le reçu d'un paiement inexistant ou hors campus est
un `404`, jamais un `403` — la distinction révélerait l'existence de la ligne.

**Numéro de reçu** — dérivé, jamais stocké en second exemplaire : `FeePayment.reference`
existe déjà et porte la référence d'encaissement. Le reçu l'affiche ; il n'introduit pas
un compteur concurrent.

## 3. Portée campus

`StudentFee` et `FeePayment` déclarent tous deux **`schoolCampus`** — la convention
majoritaire (§5, corrigé le 2026-08-25). Toute lecture passe par
`buildCampusFilter(req.user)` ; `req.body.campusId` n'est jamais lu.

Le grand livre étudiant est déjà consultable par l'étudiant lui-même : la route de reçu
hérite de cette règle, avec la **double condition** campus **et** propriété du paiement.
Un `CAMPUS_MANAGER` voit les reçus de son campus ; un `STUDENT` uniquement les siens.

## 4. Suppression

`StudentFee` appartient à la famille **`isDeleted`** (§5.1, *Records & transactions*).
Filtres dérivés via `notDeletedFilter(StudentFee)`, jamais écrits à la main.

`FeePayment` **ne porte aucun marqueur de suppression** — c'est délibéré et cela reste
ainsi : un encaissement ne s'annule pas, il se contre-passe. Le reçu est donc un
artefact d'une ligne immuable, et n'a pas de cycle de vie propre.

**Le PDF n'est pas persisté.** Il est rendu à la demande depuis la ligne d'encaissement.
Un fichier stocké devrait être purgé par le teardown de la danger zone, compté au quota
de stockage du campus, et il survivrait à la suppression définitive de l'étudiant — trois
problèmes que le rendu à la volée n'a pas. C'est aussi ce qui évite la ligne 14 de la
phase 1-B (l'expiration TTL du GED hors danger zone).

## 5. Entitlement

**Aucune clé nouvelle.** La fonctionnalité vit dans le module `finance` et hérite de sa
clé (R2 du §12 : la granularité est le module ; `premium` porte déjà les 26 clés, donc
une clé nouvelle serait une unité vendable de plus).

Comportement attendu des trois états :

| État | Reçu (`GET`) | Relances |
|---|---|---|
| `enabled` | servi | émises |
| `read_only` | **servi** — c'est une lecture, l'historique reste lisible | **suspendues** : une relance est une mutation sortante |
| `hidden` | `404` par la gate de route | suspendues |

Le second point est déjà acquis sans code : `notification.features.js` attribue le
gabarit `payment.reminder` à `finance`, et `notify()` refuse d'émettre pour un module
inactif sur le campus du destinataire. À **vérifier** à l'étape 10, pas à supposer.

## 6. Le piège de conception — les compteurs de relance sont déjà pris

`StudentFee` porte `lastRemindedAt` et `reminderCount`, que
`finance.repository.js:287` réclame **atomiquement** pour la relance d'impayé
(`claimFeeForReminder` : `$set lastRemindedAt`, `$inc reminderCount`, sous condition
`status: 'overdue'`).

Réutiliser ces deux champs pour la cadence avant échéance les fait entrer en collision :
une relance J-3 estampille `lastRemindedAt`, et la réclamation d'impayé du lendemain,
qui exige `lastRemindedAt < cutoff`, **ne sélectionne plus la dette**. Résultat : la
dette qui vient de basculer en impayé saute sa relance d'impayé — silencieusement, et
d'autant plus sûrement que la relance avant échéance aura bien fonctionné.

**Décision** : un marqueur par *type* de relance, et non un compteur global.

```js
remindersSent: [{ kind: <REMINDER_KINDS>, sentAt: Date }]   // borné à 4 entrées
```

`lastRemindedAt` / `reminderCount` sont **conservés** et continuent de gouverner la
relance d'impayé : ajout purement additif, aucune écriture rétroactive. La réclamation
atomique de chaque type teste l'absence de son propre `kind`, jamais celle d'un autre.
Le champ n'a finalement demandé **aucun script** de migration — voir §9.

## 7. Registres touchés (§12.5)

| # | Registre | Ce qui y entre |
|---|---|---|
| 1 | `app.js` | rien — la route est ajoutée au routeur `finance` déjà monté |
| 2 | `modules/finance/index.js` | rien pour `finance`. **Mais** `modules/academic-print/index.js` exporte désormais `renderPdf` + `getCampusBranding` (décision tranchée à l'étape 3, §9④) |
| 3 | `features.constants.js` | **pas « rien » — la note se trompait** : un cron nouveau s'y déclare avec sa nature, et se double d'une entrée dans `EMISSION_SITES` (§9⑤) |
| 4 | `hard-delete.registry.js` | rien — aucun modèle nouveau, aucun champ `ref` nouveau |
| 5 | `soft-delete.js` | rien — `StudentFee` reste `isDeleted`, marqueur unique |
| 6 | `register-jobs.js` + `CLAUDE.md` §11 | **un job** : `finance-due-soon`, `0 7 * * *` (après l'impayé de 06:00, pour que la bascule du jour soit acquise) |
| 7 | `seed.config.js` (`COUNTS`) | trois dettes de la fixture ancrées à J-7, J-3 et J+0 — sans quoi la cadence n'est testable sur rien |
| 8 | `shared/i18n/catalogs/notifications.js` + `public/locales/×10` | trois gabarits de relance + les libellés du reçu |
| 9 | `frontend/src/services/financeService.js` + navigation | téléchargement du reçu ; pas d'entrée de navigation nouvelle, donc pas de clé `feature:` nouvelle |
| 10 | `COURSE_HOOKS.md` | rien — aucun fichier déplacé ni renommé |
| 11 | `CLAUDE.md` §10 / §11 | la ligne du cron, et la mention du reçu au module finance |

## 8. Definition of done

Reprise du §12.6, amendée : les cases i18n et cron s'appliquent, la case
`check-solutions.sh` ne s'applique pas (aucun changement structurel).

- [x] contrat figé côté backend, aucun littéral dupliqué chez le client ;
- [x] portée campus par `buildCampusFilter()`, double condition sur la route de reçu ;
- [x] filtres de suppression dérivés de `StudentFee` ;
- [x] les onze registres parcourus — **cinq** sont des « rien » (§9⑤), et c'est un constat, pas un oubli ;
- [x] frontend câblé, i18n × 10 locales ;
- [x] tests : unitaire repository, unitaire service, isolation campus sur la route de reçu,
      **et le test de non-collision du §6** — une dette relancée à J-3 doit rester réclamable
      par la relance d'impayé ; chacun vu rougir une fois (§9⑫) ;
- [x] les trois audits passés, chaque constat fermé par un test qui rougissait avant (§9⑬ à ⑮) ;
- [x] `npm test` (**1 566** au 2026-09-02 — 1 546 était le relevé du 2026-08-27, avant les deux
      commits de la branche A et le test du constat ⑲), `lint`, `audit:ci` verts ;
      `seed:test:self-check` vert 16/16 (la fixture bouge) ;
- [x] `docs/cours/check-solutions.sh` — **vert, 67/67** depuis le 2026-09-02 (§9⑯ et §9⑰) ;
- [x] QA navigateur : deux thèmes, `CAMPUS_MANAGER` + `STUDENT`, les trois états d'entitlement —
      **jouée le 2026-09-02**, et écrite dans `npm run test:visual` plutôt que passée à la main
      (§9⑲) : **36/36**, dont une régression trouvée et corrigée sur place ;
- [x] le préavis `due_today` est délivré : défaut §9⑰ **corrigé** par la branche A (§9⑱),
      fermé par quatre tests vus rouges — dont l'invariant inter-cadences qui manquait ;
- [x] `CLAUDE.md` §7/§8/§10/§11, `ERP_ROADMAP.md` §0 et la ligne 6 de la phase 1-B, dans le même commit.

## 9. Ce que la construction a démenti

**Étape 2 (2026-08-25) — trois écarts, tous dans le sens de la simplification.**

**① L'enum porte trois valeurs, pas quatre.** Le §2 annonçait `OVERDUE` parmi les types,
« existant, aujourd'hui implicite ». Il n'y entre pas. La cadence d'impayé **se répète** —
un rappel par fenêtre, tant que la dette tient, d'où le `$inc` de `reminderCount` — tandis
que la cadence avant échéance tire chaque type **au plus une fois**, ce qui est précisément
ce qui rend `remindersSent[]` réclamable de façon idempotente. Déclarer `overdue` dans un
tableau dont l'invariant est « une entrée par type » aurait invité quelqu'un à l'y écrire,
et recréé la collision décrite au §6. Le fichier `fee-reminder-kind.js` porte cette absence
en commentaire, pour que le prochain lecteur ne la prenne pas pour un oubli.

**② Aucun script de migration.** Le §6 en annonçait un, expand-only. Il n'en faut pas, et
c'est vérifié contre un vrai MongoDB plutôt que supposé — une ligne écrite *avant* le
changement, donc sans le chemin `remindersSent` du tout :

| Vérifié | Résultat |
|---|---|
| la ligne héritée est sélectionnée par le filtre de réclamation (`$ne` matche un champ absent) | oui |
| la première réclamation `$push` gagne, la seconde renvoie `null` | oui — pas de doublon |
| le tableau ne contient qu'une entrée | oui |
| `lastRemindedAt` / `reminderCount` restent intacts | oui |
| l'index `status_1_dueDate_1` est bâti sans script | oui |

Le seul script justifiable aurait été la création d'index ; ce dépôt ne fixe pas
`autoIndex`, donc Mongoose la fait à la connexion comme pour tous les autres index.
Écrire une migration qui n'écrit rien aurait été de la cérémonie.

**③ L'entitlement est appliqué plus tôt que la note ne le disait.** Le §5 s'appuyait sur
`notify()` refusant d'émettre pour un module inactif. C'est vrai, mais `findRemindableOverdueFees`
fait déjà mieux : il exclut `suppressedCampusIds('finance')` **dans la requête**, avec une
raison écrite — la réclamation estampille le marqueur au ramassage, donc une dette écartée
après coup brûlerait son créneau et resterait muette une fenêtre entière une fois le module
réactivé. Le balayage avant échéance doit reproduire ce filtre à l'étape 3, et non se reposer
sur `notify()`. C'est une contrainte de plus que la note n'avait pas vue.

**Ce qui n'a pas bougé** : la portée campus, la famille de suppression, l'absence de clé
d'entitlement, le non-stockage du PDF, et les six registres à « rien » — les quatre suites de
registres sont vertes sans qu'une ligne y soit ajoutée (353 tests).

**Étape 3 (2026-08-27) — quatre écarts, dont un qui retire un « rien » au §7.**

**④ Le reçu passe par une primitive exportée, pas par un septième type de document.** Le §7
laissait le choix ouvert : ajouter `RECEIPT` à `generateAcademicPdf`, ou rendre dans `finance`.
Aucune des deux formulations n'était la bonne. Ce que `academic-print` possède et que personne ne
doit posséder deux fois est la **ressource** — un navigateur Puppeteer pour tout le processus, un
plafond FIFO de pages simultanées, un cache de branding, et une extinction propre appelée par
`server.js`. Un second pool ouvert dans `finance` doublerait l'empreinte Chrome et survivrait à
`shutdownAcademicPool()`. Ce qu'il ne possède pas, c'est un reçu d'encaissement : la mise en page
et les règles appartiennent à la finance. La façade exporte donc `renderPdf` et
`getCampusBranding` ; le gabarit vit dans `modules/finance/fee-receipt.template.js`, pur et
testable sans navigateur.

Cette décision a coûté **deux extractions vers `shared/` que la note n'avait pas vues**, toutes
deux imposées par le §0.1 : `escapeHtml` existait déjà en deux exemplaires (GED et impressions
académiques) et le reçu aurait été le troisième — il vit maintenant dans `shared/utils/html.js` ;
et la table BCP-47 des locales, jusqu'ici privée d'`academic-pdf.service.js`, devient
`localeContext()` dans `shared/i18n/languages.js`, pour qu'un reçu et un bulletin émis par le même
campus n'écrivent pas une date de deux façons.

**⑤ Le registre 3 n'était pas un « rien ».** La note le classait tel, clé `finance` héritée — vrai
pour l'entitlement de la route, faux pour le cron : `features.constants.js` déclare **aussi** les
jobs de chaque module avec leur nature, et `tests/unit/feature-registry.test.js` compare cette
liste, nom par nom, à celle que `register-jobs.js` planifie. Un job ajouté d'un seul côté fait
rougir la suite. Le doublon est ailleurs et il compte : `EMISSION_SITES`
(`shared/lib/entitlement/entitlement.jobs.js`) associe le job à la clé qu'il faut consulter pour
se taire — sans cette ligne, `entitlement.jobs.test.js` rougit, et un campus dont la finance est
éteinte recevrait quand même les relances. **Cinq registres à « rien », pas six.**

**⑥ Le reçu est rendu dans la langue de l'étudiant, jamais dans celle du demandeur.** La note ne
tranchait pas. Un `CAMPUS_MANAGER` qui télécharge le reçu l'imprime **pour** l'étudiant : le
rendre dans la langue d'interface du gestionnaire donnerait un reçu anglais à un étudiant
francophone. Même règle et même source que les relances (`UserPreferences`).

**⑦ Le balayage avant échéance ne peut pas paginer par `skip`.** Contrainte propre à cette
cadence, absente de la note : réclamer une dette **ne la retire pas** de la fenêtre — elle y reste
jusqu'à son échéance. L'hypothèse d'ensemble décroissant que `runOverdueJob` a le droit de faire
(chaque réclamation estampille `lastRemindedAt` et sort la dette du lot suivant) est ici fausse, et
une boucle `skip` ne terminerait jamais. La pagination se fait donc **par `_id` croissant**, et la
terminaison ne dépend d'aucune réclamation.

**Étape 4 (2026-08-27) — le frontend, et une duplication qui existait déjà dix fois.**

**⑧ Trois tableaux de paiements, pas un.** La note parlait d'« un bouton de téléchargement dans le
grand livre étudiant ». Il y a en réalité **trois** endroits où une ligne d'encaissement est
rendue : `FeeDetailDialog` (détail d'une dette, campus), `StudentLedgerDrawer` (grand livre d'un
étudiant vu par le campus) et `StudentFinance` (l'étudiant chez lui). Le bouton est donc un
composant **autonome** de `financeShared.jsx` — il porte son propre indicateur d'attente *et* sa
propre surface d'erreur — plutôt qu'un branchement répété trois fois : trois branchements, ce sont
trois occasions d'avaler le message du serveur.

**⑨ La danse de téléchargement binaire était déjà écrite dix fois.** `URL.createObjectURL` → ancre
cachée → `click()` → `revokeObjectURL` apparaît dans dix fichiers du frontend (documents, prospects,
partenaires, commissions, actions groupées, examens). Le reçu n'en est pas le onzième :
`src/utils/downloadBlob.js`. Les dix existants sont **laissés en place** — les migrer est un
nettoyage à part, pas un effet de bord de la livraison d'un reçu — mais deux défauts que chaque
copie porte sont corrigés dans le helper :

| Défaut | Ce que fait le helper |
|---|---|
| le nom de fichier est inventé côté client, l'en-tête `Content-Disposition` du serveur ignoré | il le lit, et le nom du client n'est qu'un repli |
| en `responseType: 'blob'`, le corps d'une erreur est un Blob : `err.response.data.message` vaut `undefined` et chaque copie retombe sur une phrase anglaise en dur | `readBlobError()` le relit et le reparse — sans quoi le 404 de la portée s'afficherait « réessayez » |

Le second n'est pas théorique : `MyCommissions.jsx` annonce « Receipt download is not yet available
for this commission » pour **toute** panne, y compris une session expirée.

**⑩ Aucun littéral n'est miroité, et c'est structurel.** Le §2 exigeait que le client ne redéclare
rien. Il n'a rien à redéclarer : les trois `REMINDER_KINDS` ne sortent jamais du backend (les
gabarits sont rendus côté serveur) et le reçu est un PDF, pas une structure. Le registre 9 se
limite donc à `financeService.js` + le helper + le hook, sans clé `feature:` nouvelle — conforme à
la prévision du §7.

**⑪ L'état `read_only` n'a demandé aucun code frontend.** Les écrans finance sont gardés **à la
route** (`FeatureGuard`), pas composant par composant : `hidden` retire la route, `read_only` la
laisse, et le reçu étant un `GET`, il reste servi sans qu'une condition soit écrite nulle part.
C'est la ligne du §5 obtenue par construction — à confirmer à l'étape 10, comme prévu, et non à
supposer.

Le contrat du §2 est tenu tel qu'il était écrit : une route `GET /api/finance/payments/:id/receipt`,
`application/pdf` ou `404`, aucun code d'erreur nouveau, et le numéro de reçu dérivé de
`FeePayment.reference` — avec un repli sur une forme courte de l'`_id` quand l'encaissement n'en
porte pas, qui est un **rendu** de l'identifiant et non un second compteur.

**Étape 5 (2026-08-27) — les tests, et ce qu'ils ont trouvé en s'écrivant.**

**⑫ Cinq suites, 120 tests, et chacune vue rouge au moins une fois.** L'obligation du §12.6 est
tenue par mutation du code de production, pas par relecture : chaque suite a été relancée contre une
version volontairement fausse, et le compte des tests rouges est noté ici pour que le prochain
lecteur n'ait pas à la refaire.

| Suite | Ce qu'elle verrouille | Mutation jouée → rouge |
|---|---|---|
| `tests/unit/fee-reminder-kind.test.js` (20) | la règle pure, **et les chemins de schéma réels** que le balayage interroge | éligibilité `lead !== daysUntil` (la cadence perd un préavis manqué) ; fenêtre raccourcie d'un jour ; `CRON_TIMEZONE` passé à `Africa/Douala` |
| `tests/unit/finance.repository.test.js` (14) | la forme des trois requêtes nouvelles | le `$push` réécrit `lastRemindedAt` (**la collision du §6**) ; l'exclusion d'entitlement retirée de la requête ; `findPaymentById` ignorant la portée |
| `tests/unit/finance.service.test.js` (45) | l'orchestration des deux cadences et le reçu | type figé au lieu d'être recalculé ; pagination repartant du **premier** id ; langue du demandeur ; nom de fichier non assaini ; exclusion non transmise |
| `tests/unit/fee-receipt.template.test.js` (42) | le document lui-même | valeur d'identité non échappée ; numéro de repli tiré de `Date.now()` ; suffixe de devise en dur |
| `tests/integration/finance.receipt.test.js` (21) | tout ce qui précède le service : rôles, portée composée, **les trois états d'entitlement** | l'épingle `student` retirée (un étudiant lit le reçu d'un camarade) ; 403 au lieu de 404 ; route ouverte à `TEACHER` |

Deux choses que l'écriture des tests a imposées et que la note n'avait pas vues :

- **`jest.useFakeTimers()` fige aussi `setImmediate`**, donc le `flush()` qui draine les envois
  fire-and-forget ne se résout jamais. Les tests de cadence gèlent l'horloge avec
  `doNotFake: ['setImmediate', 'nextTick']` — sans quoi la suite ne rougit pas, elle expire.
- **La fixture porte une clé de plus** : `studentFeesDueSoon` (3 sur le campus A, 0 sur B). Sans elle
  toute dette vivante est à 30 jours et le balayage de 07:00 rapporterait `0` pour toujours — un
  chiffre, pas une panne. `verify.js` vérifie la fenêtre **dérivée de `preDueWindow()`**, un préavis
  par type, un solde restant sur chacune, et aucun marqueur déjà posé : 132 contrôles au lieu de 127.

**Étapes 6 à 8 (2026-08-27) — trois constats, tous fermés par un test qui rougissait avant.**

**⑬ `{name}` n'était renseigné nulle part.** Tous les corps de courriel du catalogue l'épellent, et
`interpolate` rend une variable absente par une chaîne vide : chaque relance de frais commençait donc
par « Bonjour , ». Le défaut **préexistait** sur `payment.reminder` ; la cadence avant échéance l'a
recopié trois fois avant que quiconque le lise. L'émetteur passe désormais
`contact?.firstName || ''` — le repli explicite est là pour qu'un étudiant sans prénom ne reçoive pas
« undefined ».

**⑭ La date d'échéance des relances était en ISO, quelle que soit la langue.** Un étudiant lit la
relance *et* le reçu de la même dette ; l'un écrivait `2026-07-01`, l'autre « 1 juillet 2026 ». Même
table, même helper (`localeContext`), une fonction `formatDueDate()` dans le service.

**⑮ Le reçu était le seul rendu PDF de la plateforme derrière le quota générique.** `apiLimiter`
compte 100 requêtes / 15 min **par IP** ; la GED, elle, garde ses exports derrière 5/min **par
utilisateur**, et pour la bonne raison : le pool Puppeteer plafonne la *concurrence*, pas le débit —
au-delà de quatre pages, les rendus font la queue et une rafale sur une route retarde toutes les
autres, balayage de la file d'impression compris. Le reçu est la seule de ces routes qu'un `STUDENT`
peut atteindre, c'est-à-dire la population la plus nombreuse de la plateforme.

Le budget a donc été **extrait** vers `shared/middleware/rate-limiter.js` (`pdfLimiter`, 5/min, clé
utilisateur, préfixe de store propre) et la copie locale de `document.routes.js` supprimée : deux
exemplaires d'un même quota dérivent, et c'est celui que personne ne relit qui reste faux. La clé
reste l'utilisateur et non l'IP — un secrétariat sort par une seule adresse NAT, où un budget par IP
laisserait le premier caissier faire taire les autres. Règle inscrite au §7 de `CLAUDE.md`.

*Effet de bord assumé sur la suite d'intégration* : un budget par utilisateur rend une suite qui
signe toutes ses requêtes avec la même identité dépendante de son propre ordre. Chaque requête y
porte désormais un acteur neuf, sauf là où le test nomme l'appelant.

**Ce que les audits n'ont PAS trouvé, et qui a été vérifié plutôt que supposé** : l'horloge des crons
est bien `UTC` (`CRON_TIMEZONE`), donc les journées comptées par `daysUntilDue` et celles du
planificateur coïncident — un test le verrouille, parce qu'un changement d'horloge décalerait le
préavis « jour J » d'un jour pour un fuseau et pour personne d'autre ; l'index
`{ status: 1, dueDate: 1 }` existe déjà ; `renderPdf` prend bien un jeton du plafond FIFO, donc le
reçu ne contourne pas la limite mémoire ; et le reçu d'un encaissement rattaché à une dette
**archivée** reste servi — délibéré, l'argent a bien été reçu et l'archivage d'une dette ne défait
pas un encaissement.

**Étape 9 (2026-08-27) — quatre briques passées, une garde rouge.**

| Vérification | Résultat |
|---|---|
| `npm test` (backend) | **1 546 tests, 71 suites, vert** (1 426 avant l'étape 5 ; **1 565** après §9⑱) |
| `npm run lint` (backend) | 0 erreur (44 avertissements préexistants) |
| `npm run audit:ci` | vert (rouge le 2026-09-02 sur deux avis `browserslist` sans rapport avec ce chantier — override `^4.28.8`, §9⑱) |
| `npm run seed:test:self-check` | **16/16**, dont la vérification 132 contrôles (134 depuis §9⑱) |
| `frontend` : `npm run build` | vert |
| `frontend` : `npm run lint` | 91 erreurs **préexistantes**, aucune dans les fichiers de la fonctionnalité |
| `ai-service`, portail | non touchés (§ tableau des briques) |
| `docs/cours/check-solutions.sh` | **rouge : 57 réussites, 10 échecs** — vert 67/67 depuis le 2026-09-02 (§9⑰) |

**⑯ La garde du cours est rouge, et la note s'était trompée en disant qu'elle ne s'appliquait pas.**
Le §8 annonçait « aucun changement structurel ». Faux : un cron de plus, une route de plus, deux
exports de façade de plus, trois fichiers de test de plus. Dix solutions comptent ces choses-là et
citent le chiffre dans leur énoncé.

| Leçon(s) | Chiffre qui a bougé | Origine |
|---|---|---|
| `12.4`, `13.4`, `19.1`, `19.3` | 7 jobs → **8** (et 2 émissions → **3**) | étape 3 — le cron `finance-due-soon` |
| `10.1` | sites de `require` inter-modules, arêtes module→module, `shared/ → modules/` | étape 3 — le service finance appelle deux façades de plus |
| `f2.2`, `f2.4`, `f2.5` | 68 suites → **71**, 3 suites d'intégration → **4**, fichiers du frontend | étape 5 et étape 4 |
| `15.2` | constat ㉒ : « un seul export du repository est couvert par sa propre suite » | **étape 5 : le constat est fermé**, six le sont désormais, dont les deux requêtes nocturnes |

Une seule de ces dix a été corrigée côté backend, parce que c'était le code qui avait tort et non
l'énoncé : `f2.1` exige qu'une attente de `verify.js` ne redise jamais une liste en dur, et la
nouvelle vérification comparait une liste de types épelée. Elle compare maintenant un booléen, comme
les autres invariants structurels du fichier. **Les neuf autres sont des chiffres d'énoncé, et leur
correction appartient au dépôt `docs/cours/` (§11bis : le commit se fait depuis là-bas, jamais
d'ici).** Le cas `09.4` mérite une décision et non une substitution : son titre même est *Seven Jobs,
Four Postures* et sa narration compte sept jobs sur toute une piste — la leçon fige explicitement
l'état « vérifié le 2026-08-13 », donc la question est de savoir si la piste 09 se réécrit pour le
huitième job ou si elle assume sa date. C'est un arbitrage de contenu pédagogique, pas une
substitution mécanique.

**Reste donc, avant de pouvoir déclarer la ligne 6 livrée** : la garde du cours au vert (dépôt
`docs/cours/`), puis l'étape 10 — la QA navigateur, qui ne se délègue pas.

**2026-09-02 — la garde du cours fermée, et ce qu'elle a fait remonter.**

**⑰ Le préavis « Jour J » n'est jamais délivré.** Fermer la leçon 15.2 imposait de trancher la
prédiction qu'elle portait (son constat ⑰, écrit *avant* que le code existe) : au lieu de la
substituer, elle a été **mesurée contre un vrai MongoDB**, en rejouant la cadence entière jour par
jour avec les deux requêtes réelles.

```
  jour  statut à 06:00 après markPastDueOverdue   balayage 07:00   type voulu par la règle
  ────  ─────────────────────────────────────     ──────────────   ──────────────────────
  J-7   pending                                        1            due_in_7d  → envoyé
  J-3   pending                                        1            due_in_3d  → envoyé
  J-0   overdue                                        0            due_today
```

`markPastDueOverdue` sélectionne `dueDate: { $lt: now }` à 06:00 ; une dette dont l'échéance est
horodatée à minuit UTC — ce que `<input type="date">` envoie, donc **toute** dette créée par le
formulaire ERP — est déjà `overdue` quand le balayage de 07:00 la cherche parmi les
`pending`/`partial`. **Un tiers de la cadence déclarée ne part jamais**, silencieusement : le
journal écrit `2 reminder(s) sent` et c'est aussi ce à quoi ressemble une nuit normale.

Trois choses à retenir sur *pourquoi personne ne l'a vu* :

- **la fixture ne le voit pas** : son ancre est `2026-06-15T09:00:00Z`, donc la dette « due
  aujourd'hui » porte une échéance à 09:00 et survit au passage de 06:00. C'est l'horloge de la
  fixture, pas le code, qui rend le troisième préavis atteignable ;
- **le test de service ne le voit pas non plus** : il moque le repository, donc il vérifie que le
  service *demande* une réclamation `DUE_TODAY` sur une dette que la requête ne renverra jamais ;
- **la note l'avait sous les yeux** : le §9③ notait déjà que le balayage devait reproduire le
  filtre d'entitlement « dans la requête ». La question voisine — *que reste-t-il dans la requête
  après le job de 06:00 ?* — n'a pas été posée.

C'est un constat d'étape 7 (audit de la plateforme *avec* la fonctionnalité) arrivé après l'étape 9.
Trois réparations étaient possibles, et elles ne coûtaient pas la même chose :

| Branche | Le changement | Ce qu'il coûte |
|---|---|---|
| **A — déplacer la bascule à la fin du jour d'échéance** (`dueDate < minuit du jour`) | `computeStatus` + `markPastDueOverdue` | sémantique de statut visible partout : une dette due aujourd'hui s'affiche `pending` et non `overdue`. C'est la réparation que la leçon recommande au constat ⑯, et la seule qui rende l'ordre 06:00 → 07:00 correct |
| **B — élargir le filtre du balayage au statut `overdue` pour le seul `due_today`** | `findFeesDueSoon` | la même dette reçoit « due aujourd'hui » à 07:00 et sa première relance d'impayé à 06:00, une heure plus tôt |
| **C — avancer le balayage avant 06:00** | une ligne du manifeste | ne règle rien : la dette bascule quand même à 06:00 et reçoit les deux courriers le même matin |

**⑱ Branche A retenue par le porteur, le 2026-09-02 — et la règle y gagne indépendamment du
défaut.** Une échéance est un **jour**, pas un instant : `<input type="date">` envoie minuit, donc
`dueDate < now` déclarait une dette en retard à 00:00:01 du jour même où elle était due. La
correction ne se contente pas de rendre le troisième préavis atteignable, elle rend la règle vraie —
*le débiteur possède la totalité de sa journée d'échéance*.

| Fichier | Ce qui change |
|---|---|
| `fee-status.js` | `startOfUtcDay(dueDate) < startOfUtcDay(now)` ; `startOfUtcDay` et `DAY_MS` y sont **exportés** — c'est le fichier qui possède la frontière |
| `fee-reminder-kind.js` | sa copie privée de `startOfUtcDay` **supprimée**, importée de `fee-status.js` (§0.1). Deux définitions de « quel jour sommes-nous » sont exactement ce qui a laissé les deux cadences diverger |
| `finance.repository.js` | `markPastDueOverdue` borne sur `new Date(startOfUtcDay(now))`, importé et non redit |

**Quatre tests, tous vus rouges avant le correctif** (R1) — et l'un d'eux est le test qui manquait,
pas un test du correctif :

| Suite | Ce qu'elle verrouille | Vue rouge |
|---|---|---|
| `fee-status.test.js` (+5) | la journée d'échéance appartient au débiteur : 06:00, 23:59, minuit le lendemain, l'acompte, et l'échéance horodatée en cours de journée | 2 rouges |
| `fee-reminder-kind.test.js` (+3, dont un `test.each` sur toute la fenêtre) | **l'invariant qui manquait** : à chaque jour J-7…J-0, ce que la règle veut envoyer à 07:00 doit rester lisible par le balayage après la passe de 06:00 | 1 rouge, à J-0 exactement |
| `finance.repository.test.js` (+4) | `markPastDueOverdue` et `touchReminded` — les deux **écritures** nocturnes, jusqu'ici épinglées par rien (constat ㉒ de la leçon 15.2, désormais **fermé**) | 3 rouges |
| `tests/fixtures/verify.js` (+2 × 2 campus) | les dettes avant échéance portent minuit, **et** la passe de 06:00 les laisse toutes réclamables | — |

L'invariant mérite d'être lu pour lui-même : il n'affirme pas qu'une fonction renvoie une valeur,
il affirme que **les deux règles ne se cachent pas des dettes l'une à l'autre**. Chacune était juste
seule ; c'est leur composition, à une heure d'intervalle, qui était fausse. Aucun test unitaire de
l'une ou de l'autre ne pouvait le voir.

**Vérifié contre une vraie base, dans les deux sens** — le correctif ne se contente pas de rendre le
préavis atteignable, il doit laisser la bascule intacte :

```
  jour  statut à 06:00   balayage 07:00   type voulu            bascule
  ───   ──────────────   ──────────────   ─────────             ───────
  J-7   pending                1          due_in_7d  → envoyé
  J-3   pending                1          due_in_3d  → envoyé
  J-0   pending                1          due_today  → envoyé   jour J 23:59 → pending
  J+1                                                           lendemain 00:00 → overdue
```

Les trois préavis partent, et la dette devient bien impayée — le lendemain, jamais pendant sa
journée.

**Deux effets de bord de l'étape 9 rejouée, tous deux hors périmètre de ce chantier :**

- `npm run audit:ci` était **rouge** sur deux avis `browserslist` (GHSA-c83g-rgw3-j3cx,
  GHSA-73wf-gq98-2v4g) publiés depuis l'étape 9 initiale. Le paquet n'est atteint que par
  `jest → @babel/core`, donc inatteignable en production, mais le correctif est un patch sur un
  chemin **de développement** — moins cher à prendre qu'à justifier dans une exception. Troisième
  entrée `overrides` (`^4.28.8`), inscrite au §8.1 de `CLAUDE.md`. Gate vert.
- la garde du cours cédait par intermittence sur `09.1` et `f2.3` : `TIMEOUT_S=30` était trop juste
  pour deux solutions qui chargent tous les modules du backend et lancent un venv Python. Portée à
  90 s dans `docs/cours/` (v2.17.2). Une expiration rapportée comme `FAIL` à côté d'un contrôle de
  chiffre est une garde qui crie au loup.

**La fixture cesse d'être chanceuse.** Ses dettes avant échéance héritaient du 09:00 de l'ancre, et
c'est cette heure — pas le code — qui les faisait survivre à la passe de 06:00. Elles portent
désormais minuit, comme celles du formulaire ERP (`dueAtMidnight`), et `verify.js` vérifie les deux
propriétés plutôt que de les supposer. `COUNTS` est inchangé : aucun document n'est ajouté.

**⑯ (rappel) La garde était rouge sur onze solutions, pas dix.** Le décompte de l'étape 9 en
annonçait dix ; `09.1` et `f2.3` échouaient aussi, mais par **temps d'exécution** sous la charge des
67 exécutions successives, pas par un chiffre faux — les deux passent isolément et sont vertes à la
reprise. C'est une propriété de la garde (`TIMEOUT_S=30`) qu'il vaut mieux connaître : un échec de
la garde n'est pas toujours un chiffre qui a bougé.

Correction faite depuis `docs/cours/` (§11bis), version **2.17.1** : huit lignes de chiffres
substituées, et quatre passages réécrits parce que le code avait *décidé* quelque chose —
15.2 §6.4 (la prédiction tranchée), §8.4 (la cadence rejouée), le constat ㉑ (fermé par le fait que
le code a été écrit, pas relu) et le constat ㉒ (à moitié fermé : les deux *écritures* nocturnes ne
sont toujours épinglées par rien). `09.4` garde son décompte de sept jobs, daté, avec une note qui
place le huitième dans sa taxonomie — le cas d'arbitrage éditorial que l'étape 9 avait signalé.

Côté backend, trois commentaires devenus faux ont été corrigés dans le même passage :
`document.retention.cron.js` (« all seven background jobs »), `entitlement.jobs.js` (« two of the
seven ») et l'en-tête de `entitlement.jobs.test.js`.

**2026-09-02 — l'étape 10 jouée, et ce que seule une page rendue montre.**

La QA navigateur a été **écrite dans le harnais** (`npm run test:visual`, second acte) plutôt que
jouée à la main, comme la QA d'entitlement l'avait été au 2026-08-22 (D-R7 de la feuille de route).
Le motif est le même : une passe manuelle prouve l'état d'un jour, un harnais le prouve à chaque
exécution — et il est ici la seule chose qui regarde le **fichier qui arrive sur le disque**. Le
harnais passe de 16 à **36 contrôles**, tous verts ; les captures restent l'artefact qu'un humain
lit (`tests/fixtures/.generated/visual/`).

**⑲ Le nom du reçu n'atteignait jamais le disque.** Le SPA et l'API ne partagent **jamais** une
origine — front sur Vercel et API ailleurs en production, `:5173` contre `:5000` dans le harnais.
`app.js` déclarait `exposedHeaders: ['Authorization']`, et un en-tête absent de cette liste est
**invisible au JavaScript** du SPA quelle que soit la façon dont le serveur l'envoie.
`saveBlobResponse` lisait donc `undefined` pour `Content-Disposition`, retombait sur son nom de
repli, et le fichier arrivait sous `receipt-<id du paiement>.pdf` — 24 caractères hexadécimaux à la
place du numéro de reçu que `finance.service.js` prend soin de composer. Le premier téléchargement
du harnais a produit `receipt-3a3079ca994b4e1791a54411.pdf` ; après correctif,
`receipt-PAY-A-002.pdf`.

Trois choses rendent ce défaut intéressant plutôt qu'anecdotique :

- **aucun test existant ne pouvait le voir.** `tests/integration/finance.receipt.test.js` vérifiait
  déjà que l'en-tête est *envoyé* — supertest est same-origin et lit tout. Le constat est fermé par
  un test qui pose une origine (`.set('Origin', …)`) et exige `Content-Disposition` dans
  `Access-Control-Expose-Headers` : rouge (`Received: ["Authorization"]`) avant le correctif, vert
  après ;
- **le défaut ne se limite pas au reçu.** `ExportDialog.jsx` (export GED) lit le même en-tête et
  retombait de la même façon. Une ligne d'`app.js` répare les deux ;
- **le commentaire de `downloadBlob.js` disait déjà pourquoi il fallait lire cet en-tête** — « le
  serveur est celui qui connaît l'identifiant métier ». L'intention était juste ; c'est la
  configuration CORS, écrite deux ans plus tôt et à un autre étage, qui la vidait.

**Quatre contrôles ont d'abord échoué pour de mauvaises raisons**, et chacun a coûté une exécution
complète du harnais. Ils sont consignés parce qu'ils sont les pièges de *ce* type de test, pas des
accidents :

| Symptôme | Cause réelle |
|---|---|
| l'écran du gestionnaire répond « Access Denied » | `localStorage` appartient à l'**origine**, pas à l'onglet : le dernier connecté devenait l'identité de toutes les pages ouvertes. Chaque portail a désormais son propre contexte de navigateur (`portalPage`) |
| « 2 boutons de reçu pour 1 paiement », puis « le clic ne produit aucun fichier » | le `Tooltip` de `ReceiptButton` porte le **même `aria-label`** que le bouton qu'il enveloppe. Le compte doublait, et surtout le clic tombait sur le `<span>` : rien ne se passait, et le contrôle accusait le téléchargement |
| le fichier n'arrivait nulle part | `Browser.setDownloadBehavior` sans `browserContextId` ne vaut que pour le contexte **par défaut** — donc pour aucun des portails ouverts ci-dessus |
| trois contrôles rouges sur un écran parfait | ils étaient écrits en **anglais** et les comptes de la fixture lisent le français. Le harnais interroge maintenant le **même catalogue que le SPA** (`dist/locales`), ce qui les rend indépendants de la locale et, accessoirement, rouges sur une clé brute laissée à l'écran |

Deux propriétés de plateforme se sont invitées au passage, toutes deux hors périmètre de ce
chantier et notées ici pour la suivante : `app.js` mesure **100 requêtes par quart d'heure et par
adresse** sur tout `/api/`, budget qu'une passe navigateur épuise en chargements de pages (le
harnais le remet à zéro entre ses actes, et le budget qui protège réellement le pool PDF est celui
**par utilisateur**, épinglé dans la suite d'intégration) ; et trois navigateurs simultanés — celui
du harnais, celui du pool PDF, mongod par-dessus — suffisent à faire disparaître le premier en
cours de route, ce que le harnais annonce désormais au lieu d'attendre indéfiniment.

**Les trois états d'entitlement, dont celui que la donnée refuse.** `finance` déclare `FeePayment`
et `Income` comme écritures : sur un campus qui en porte, `hidden` est **refusé** (409
`FEATURE_HAS_RECORDS`, « freeze it instead ») — ce refus est un contrôle à part entière, parce qu'un
masquage à moitié appliqué serait pire que son absence. Le troisième état est donc **vu** sur le
campus B, dont les écritures sont retirées d'abord, dans une base dont la vie entière est ce
processus : le menu de l'étudiant perd son entrée Finance, et l'URL directe donne l'écran « Module
non activé » et non une page qui se remplit de 403. Le contrôle « avant masquage » est le témoin
négatif de celui « après » — c'est ce qui empêche cette paire d'être verte sur un menu vide.

**Ce que la QA a confirmé, et qui n'allait pas de soi** : le relevé de l'étudiant est rendu dans
**sa** langue, un paiement porte exactement un bouton de reçu, le PDF fait 48 ko et commence par
`%PDF-`, les deux écrans suivent le thème sombre par la **préférence** de l'utilisateur (l'écrire
dans `localStorage` ne prouve rien : `AuthContext` réapplique `UserPreferences.theme` à chaque
rechargement), et **le reçu reste téléchargeable sous gel** — c'est une lecture, et c'est
précisément le document dont un campus a besoin pendant que son abonnement est suspendu.

**Effet de bord, dans l'autre dépôt.** Fermer la ligne 6 a fait **rougir la garde du cours** :
`lesson-15.2-challenge.js` vérifiait que la ligne du roadmap était encore `EN COURS` — sa
démonstration « inachevé, pas abandonné » s'appuyait dessus. Le constat est juste et la leçon garde
son propos : ce qui distingue l'inachevé de l'abandon est que la **ligne existe** dans un état
déclaré, pas l'état qu'elle porte. Corrigé depuis `docs/cours/` (§11bis de `CLAUDE.md`), version
**2.17.3**, garde de nouveau **67/67**. À retenir pour les quatorze autres lignes de la phase 1-B :
la clôture d'une ligne est un changement de code pour le dépôt du cours.
