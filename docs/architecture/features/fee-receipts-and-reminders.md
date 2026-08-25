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
| 2 | `modules/finance/index.js` | rien. **Mais** `modules/academic-print/index.js` exporte aujourd'hui `{ shutdownAcademicPool, cleanupExpiredPrintFiles, runPrintQueueJob }` : aucun rendu PDF réutilisable. Décision à l'étape 3 — exporter un rendu, ou rendre dans `finance` |
| 3 | `features.constants.js` | rien — clé `finance` héritée |
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

- [ ] contrat figé côté backend, aucun littéral dupliqué chez le client ;
- [ ] portée campus par `buildCampusFilter()`, double condition sur la route de reçu ;
- [ ] filtres de suppression dérivés de `StudentFee` ;
- [ ] les onze registres parcourus — six sont des « rien », et c'est un constat, pas un oubli ;
- [ ] frontend câblé, i18n × 10 locales ;
- [ ] tests : unitaire repository, unitaire service, isolation campus sur la route de reçu,
      **et le test de non-collision du §6** — une dette relancée à J-3 doit rester réclamable
      par la relance d'impayé ; chacun vu rougir une fois ;
- [ ] les trois audits passés, chaque constat fermé par un test qui rougissait avant ;
- [ ] `npm test`, `lint`, `audit:ci` verts ; `seed:test:self-check` vert (la fixture bouge) ;
- [ ] QA navigateur : deux thèmes, `CAMPUS_MANAGER` + `STUDENT`, les trois états d'entitlement ;
- [ ] `CLAUDE.md` §10/§11, `ERP_ROADMAP.md` §0 et la ligne 6 de la phase 1-B, dans le même commit.

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
