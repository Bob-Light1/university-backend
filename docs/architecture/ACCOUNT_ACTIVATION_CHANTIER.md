# Chantier sécurité — Onboarding par activation de compte

> **Document de passation.** Décrit l'objectif, les décisions, ce qui est fait, ce qui reste, et la procédure de vérification générale.
> Démarré le **2026-06-25**. Périmètre : `backend/` + `frontend/`.
> Mémoire projet liée : `project_account_activation.md`.

---

## 1. Objectif & contexte

**Problème d'origine :** la création de comptes utilisait des **mots de passe par défaut codés en dur** (`Mentor@123`, `Staff@123`, `Student@123`, `Teacher@123T789`, et `Default@123` à l'import). Faille : secret identique pour tout le monde, devinable, rarement changé.

**Solution retenue :** flux d'**activation par token** (lien à usage unique, expirant, hashé en base — pattern `document.share`). L'utilisateur **choisit lui-même** son mot de passe ; aucun secret n'est jamais transmis en clair.

---

## 2. Décisions verrouillées (NE PAS re-litiger)

1. **Activation par token**, PAS de mot de passe temporaire + `mustChangePassword` (qui transmettrait un secret en clair).
2. **Deux canaux de livraison** d'un même token :
   - **Lien** (token long 32 octets) — envoyé par email (notif `account.activate`) ;
   - **Code court 8 caractères** (alphabet non ambigu) — pour les comptes **sans email**, remis par l'admin ; l'utilisateur le saisit avec son `username/email/matricule` (second facteur).
3. **Email rendu optionnel** sur `student`/`teacher`/`parent` (beaucoup d'élèves n'ont pas d'email ; un faux email est pire que pas d'email).
4. **Périmètre complet** : `mentor`, `staff`, `student`, `teacher`, `parent` + import en masse.
5. Le lien **ET** le code sont **renvoyés dans la réponse API de création** (fallback car SMTP inerte), affichés à l'admin.
6. Token : seul le **hash SHA-256** est stocké ; le clair est renvoyé une seule fois. TTL 72 h, usage unique, garde anti-brute-force sur le code.

---

## 3. Architecture (rappel important)

> **Il n'y a PAS de modèle `User` partagé.** Chaque entité (`Mentor`, `Staff`, `Student`, `Teacher`, `Parent`) est sa propre collection + son propre modèle (avec `password` + `comparePassword`) + son propre contrôleur de login. Le module `account` est transverse et résout la bonne collection via `mongoose.model(userModel)` — **aucun require croisé de fichiers de modèles** (évite les dépendances circulaires).

Flux : `create (status:'pending' + placeholder) → issueActivationToken → notif/réponse → /activate → activateAccount (set password + status:'active')`. Le login bloque déjà tout compte non-`active`.

---

## 4. CE QUI A ÉTÉ FAIT

### 4.1 Backend — nouveau module `modules/account/`
- `account.activation.model.js` — modèle `ActivationToken` : `userModel`, `userId`, `campusId`, `tokenHash`, `codeHash`, `expiresAt` (index TTL), `usedAt`, `attempts`. `ACTIVATION_MODELS = ['Mentor','Staff','Student','Teacher','Parent']`.
- `account.service.js` — `issueActivationToken()`, `inspectToken()`, `activateAccount()`. Génère token+code, hash, notifie, renvoie `{ activationUrl, code, expiresAt }`. `activateAccount` hashe le mot de passe via `bcrypt` (pas le hook pre-save, pour ne pas re-déclencher les hooks cross-entité des modèles) et passe `status` à `active`.
- `account.controller.js` — `inspectActivation` (GET), `activate` (POST), `resendActivation` (admin, scope campus).
- `account.routes.js` — public : `GET /api/account/activate/:token`, `POST /api/account/activate` ; protégé : `POST /api/account/:model/:id/resend`.
- `index.js` — façade `{ routes, service }`.
- Monté dans **`app.js`** : `app.use('/api/account', accountRouter)`.

### 4.2 Backend — notifications & modèles
- `shared/i18n/catalogs/notifications.js` — template **`account.activate`** ajouté (inapp/email/whatsapp, 10 langues, variables `{name}` `{link}`).
- Statut **`'pending'`** ajouté à l'enum des 5 modèles : `mentor.model.js`, `staff/models/staff.model.js`, `student/models/student.model.js`, `teacher/models/teacher.model.js`, `parent/parent.model.js`.
- **Email optionnel** (`required` retiré ; `sparse` ajouté là où `unique`) sur `student`, `teacher`, `parent`.

### 4.3 Backend — branchement des créations
- `mentor.controller.js` `createMentor` + `staff.controller.js` `createStaff` + `parent.crud.controller.js` `createParent` : suppression du mot de passe par défaut → `status:'pending'` + placeholder aléatoire + `issueActivationToken` + `activation` dans la réponse.
- `student` / `teacher` passent par le **contrôleur générique** `shared/lib/generic-entity.controller.js` : flag opt-in **`activation: { userModel }`** ajouté dans `student.config.js` et `teacher.config.js`. En mode activation : password ignoré, email optionnel, `status:'pending'`, token émis, `activation` dans la réponse. Notifs `account.welcome` retirées des `afterCreate`.
- **Import en masse** : `shared/services/import.service.js` + `shared/lib/generic-bulk.controller.js` threadent le flag `activation` ; en mode activation, chaque ligne crée un compte `pending` + émet un token ; les codes sont collectés dans **`results.activations[]`**. Flag ajouté dans les configs bulk de `student.controller.js` et `teacher.controller.js`.
- **Resets** `mentor`/`staff` : ré-émettent un lien d'activation au lieu d'un mot de passe par défaut.

### 4.4 Frontend
- Page publique **`src/client/components/activate/ActivateAccount.jsx`** : modes lien (`/activate/:token`) et code (`/activate`). Routes ajoutées dans **`src/App.jsx`**.
- **`src/services/accountService.js`** : `inspectActivationToken`, `activateAccount`, `resendActivation`.
- **`src/yupSchema/activateSchema.js`** : `activateLinkSchema`, `activateCodeSchema`.
- **`src/campus/components/common/ActivationResultDialog.jsx`** : dialog affichant lien + code (boutons copier), câblé dans les **5 formulaires** (`StudentForm`, `TeacherForm`, `ParentForm`, `StaffForm`, `MentorForm`).
- Dans les 5 formulaires : **champ mot de passe retiré** (l'utilisateur le choisit à l'activation) ; capture de `res.data.data.activation` → dialog.
- Schémas `createStudent/Teacher/Parent` : email optionnel + password optionnel ; `createStudentSchema` username **requis** (aligné sur le backend, cf. point 3 résolu).

### 4.5 Backend — migration des comptes existants (Point 1, FAIT le 2026-06-25)
- `scripts/migrate-account-activation.js` — script one-shot **idempotent**, **dry-run par défaut** (`--apply` pour écrire).
  - Détection par `bcrypt.compare` du mot de passe stocké contre les défauts historiques connus par collection : `Mentor@123`, `Staff@123`, `Student@123`, `Teacher@123T789`, et le générique d'import `Default@123` (candidat partout). Un compte dont le propriétaire a déjà choisi un mot de passe **ne matche jamais** → sûr et ré-exécutable.
  - Pour chaque compte matché et `status:'active'` : `status → 'pending'` + placeholder aléatoire (`updateOne`, bypass des hooks pre-save) + `issueActivationToken` ; exporte `{ model, id, identifier, email, code, activationUrl, expiresAt }` en CSV.
  - **Garde de sécurité** : les rôles élevés (`ADMIN · DIRECTOR · CAMPUS_MANAGER`, sur `role` ou `roles[]`) ne sont JAMAIS migrés. Comptes non-`active` (déjà `pending`/inactifs) ignorés.
  - Options : `--apply`, `--models=Student,Teacher`, `MIGRATION_EXPORT=/chemin.csv`.
  - Export CSV ajouté à `.gitignore` (`account-activation-export-*.csv`) — **secret, à sécuriser/supprimer** après distribution.
- **Dry-run exécuté contre la base `university`** : 26 comptes scannés, **0 en mot de passe par défaut** (20 mots de passe choisis par l'utilisateur, 6 déjà non-actifs). Vrai négatif vérifié (hashes bcrypt bien lus malgré `select:false`). Le script est prêt pour la prod / tout futur compte vulnérable.
- ⚠️ **Réseau** : la connexion Atlas exige un egress non sandboxé dans cet environnement (sinon `ReplicaSetNoPrimary`).

### 4.7 Frontend — affichage des codes d'activation à l'import (Point 2, FAIT le 2026-06-25)
- `src/components/shared/ImportDialog.jsx` (composant d'import réutilisable, unique consommateur, monté par `GenericEntityPage`) — exploite désormais `data.activations[]` renvoyé par le backend.
  - **Tableau récapitulatif** après import : colonnes `Row · Name · Identifier · Email · Code · Link`. Les lignes **sans email** sont surlignées + badge « no email » (ce sont elles qui dépendent du code hors-ligne).
  - **Boutons copier** par ligne (code + lien) et **export CSV** client-side (`<endpoint>_activation_codes.csv`, BOM UTF-8 pour Excel) — les codes ne sont renvoyés qu'une fois.
  - **Correctif UX critique** : l'auto-fermeture du dialog (qui appelait `onSuccess` → `setIsImportDialogOpen(false)`) effaçait les codes en 2 s. Désormais, si `activations[]` est non vide, le dialog **reste ouvert** (message de succès différé dans `pendingSuccessMsg`) ; le rafraîchissement de la liste + snackbar ne sont déclenchés qu'au clic sur **« Done »**. Sans activations, comportement inchangé.
- **Backend inchangé** : le contrat `data.activations[] = { row, name, identifier, email, code, activationUrl }` (émis par `shared/services/import.service.js`) était déjà en place ; Point 2 est purement front.
- ESLint sur `ImportDialog.jsx` → **0 erreur** (nettoyage au passage d'un `entityName` non utilisé pré-existant).

### 4.6 Vérifications effectuées
- `node --check` sur tout le backend modifié ✅ (script de migration inclus).
- Chargement complet de l'app Express (`require('./app.js')`) sans erreur ✅.
- Rendu du template `account.activate` testé ✅.
- ESLint sur les 13+ fichiers frontend → **0 erreur** (seuls warnings `exhaustive-deps` pré-existants).
- §6 (vérification générale) ré-exécutée le 2026-06-25 avant reprise → tout vert ✅.

---

## 5. CE QUI RESTE À FAIRE

### Point 1 — Migration des comptes EXISTANTS — ✅ FAIT (2026-06-25)
Script `scripts/migrate-account-activation.js` livré (cf. §4.5). Idempotent, dry-run par défaut, garde rôles élevés, export CSV des liens+codes.
**Reste opérationnel (pas du code) :** en prod, prendre une sauvegarde puis lancer `node scripts/migrate-account-activation.js` (dry-run) → vérifier le rapport → relancer avec `--apply` → distribuer le CSV d'activations aux comptes sans email. Sur la base de dev actuelle : 0 compte concerné.

### Point 2 — Affichage des codes d'activation en IMPORT de masse — ✅ FAIT (2026-06-25)
`src/components/shared/ImportDialog.jsx` affiche désormais `data.activations[]` (cf. §4.7) : tableau + copier par ligne + export CSV, lignes sans email surlignées, dialog maintenu ouvert tant que les codes ne sont pas relevés. **Rien à faire de plus** (backend déjà conforme).

### Point 3 — Identité de login étudiant — ✅ RÉSOLU
Faux problème : `username` est requis+unique côté modèle → identité toujours garantie. Schéma front aligné (`yupUsername(true)`). **Rien à faire.**

### Points de vigilance / dette mineure
- `notification` `account.welcome` reste utilisé par le module `admin` — ne pas le supprimer.
- Vérifier que les **formulaires d'édition** (mode `isEdit`) ne sont pas régressés par le retrait du champ password (l'édition ne gérait déjà pas le password ici).
- Le `resend` admin renvoie un nouveau token et invalide l'ancien (un seul lien vivant par compte) — comportement voulu.
- SMTP inerte : tant qu'il n'est pas configuré, l'email d'activation n'est pas envoyé → le canal réel est la **réponse API** (lien+code affichés à l'admin). Ne pas considérer l'absence d'email comme un bug.

---

## 6. Procédure de VÉRIFICATION GÉNÉRALE (à lancer avant de continuer)

```bash
# Backend — syntaxe + chargement complet
cd /home/adminsecu/Projects/university/backend
node --check app.js
node -e "require('dotenv').config(); process.env.JWT_SECRET=process.env.JWT_SECRET||'test'; require('./app.js'); console.log('app OK')"
# Template notif
node -e "const t=require('./modules/notification/templates'); console.log('account.activate:', t.has('account.activate'))"

# Frontend — lint des fichiers du chantier
cd /home/adminsecu/Projects/university/frontend
npx eslint \
  src/client/components/activate/ActivateAccount.jsx \
  src/services/accountService.js src/yupSchema/activateSchema.js \
  src/campus/components/common/ActivationResultDialog.jsx \
  src/campus/components/{students/StudentForm,teachers/TeacherForm,parents/ParentForm,staff/StaffForm,mentors/MentorForm}.jsx \
  src/yupSchema/create{Student,Teacher,Parent}Schema.js src/App.jsx
```

**Tests fonctionnels manuels conseillés** (avec un backend connecté à la DB) :
1. Créer un compte (chaque rôle) → vérifier réponse 201 avec `data.activation = { activationUrl, code, expiresAt }` et `status: 'pending'`.
2. `GET /api/account/activate/:token` → 200 + `firstName`.
3. `POST /api/account/activate` `{ token, password }` → 200, compte `active`, login OK.
4. Mode hors-ligne : `POST /api/account/activate` `{ identifier, code, password }` → 200.
5. Token expiré/réutilisé → 410 ; mauvais identifiant sur code → 401 ; trop de tentatives → 429.
6. Login avant activation → 403 (compte non actif).

---

## 7. Convention pour la suite

Quand on reprend ce chantier : **lire ce document d'abord**, lancer la §6 (vérification générale) **avant** toute modification, puis traiter Point 1 ou Point 2. Mettre à jour les §4/§5 de ce document et la mémoire `project_account_activation.md` à chaque avancée.
