'use strict';

/** @file admission.journey.js @description Real admission authorization, private files, races and rollback on an owned disposable replica set. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
if (process.env.NODE_ENV === 'production') throw new Error('Admission journey refuses production mode');
const previousDirectory = process.cwd();
const runtime = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'erp-admission-'));
process.chdir(runtime);
Object.assign(process.env, {
  NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(48).toString('hex'),
  PORTAL_API_KEY: crypto.randomBytes(32).toString('hex'),
  PORTAL_URL: 'http://127.0.0.1:3000', FRONTEND_URL: 'http://127.0.0.1:5173',
  AI_SERVICE_URL: '', AI_SERVICE_SECRET: '', REDIS_URL: '', UPLOAD_DIR: path.join(runtime, 'uploads'),
  DOC_STORAGE_PROVIDER: 'local',
});
for (const key of Object.keys(process.env)) if (/SMTP|CLOUDINARY|MAIL_|WHATSAPP|TWILIO|SENDGRID|RESEND/.test(key)) process.env[key] = '';
const mongoose = require('mongoose');
const request = require('supertest');
const { PDFDocument } = require('pdf-lib');
const { seed, startEphemeralDatabase } = require('./seed');
const { readAccounts } = require('./exports');
const { loadAllModels } = require('./models');
const { LEAD_STATUS: S, ADMISSION_ERRORS: E } = require('../../shared/constants/admission.constants');
let checks = 0;
const check = (label, condition) => { assert.ok(condition, label); checks += 1; console.log(`  ✓ ${label}`); };

/** Drive the actual HTTP handlers and inspect persisted outcomes after failures and races. */
async function main() {
  const handle = await startEphemeralDatabase();
  try {
    mongoose.set('autoIndex', false); mongoose.set('autoCreate', false);
    await mongoose.connect(handle.uri); loadAllModels(); await seed({});
    await require('../../scripts/prepare-auth-sessions').prepareAuthSessions({ apply: true });
    const { prepareAdmission } = require('../../scripts/prepare-admission');
    const leadCount = await mongoose.model('PartnerLead').countDocuments();
    const inspected = await prepareAdmission();
    await prepareAdmission({ apply: true }); await prepareAdmission({ apply: true });
    check('admission preparation is repeatable and never converts historical leads', inspected.applied === false
      && inspected.historicalRecordsChanged === 0 && await mongoose.model('PartnerLead').countDocuments() === leadCount);
    const app = require('../../app'); app.set('trust proxy', 'loopback');
    const catalogue = readAccounts();
    const a = catalogue.campuses.A.id; const b = catalogue.campuses.B.id;
    const Lead = mongoose.model('PartnerLead'); const Student = mongoose.model('Student');
    const Attachment = mongoose.model('AdmissionAttachment'); const Commission = mongoose.model('PartnerCommission');
    const Campus = mongoose.model('Campus'); const Notification = mongoose.model('Notification');
    const actors = Object.values(catalogue.accounts).flat();
    const tokens = {};
    let source = 1;
    for (const [name, role, campus] of [['admin', 'ADMIN'], ['managerA', 'CAMPUS_MANAGER', a], ['managerB', 'CAMPUS_MANAGER', b], ['partner', 'PARTNER', a], ['student', 'STUDENT', a]]) {
      const actor = actors.find((item) => item.role === role && (!campus || item.campusId === campus));
      const response = await request(app).post(actor.endpoint.split(' ')[1]).set('X-Forwarded-For', `192.0.2.${source++}`)
        .send({ [actor.loginField]: actor.login, password: actor.password });
      assert.equal(response.status, 200); tokens[name] = response.body.data.token;
    }
    let serial = 0;
    const makeLead = async (campus = a, partner = null) => Lead.create({
      firstName: 'Synthetic', lastName: 'Applicant', email: `admission-${++serial}@fixture.test`,
      phone: '+237600000001', schoolCampus: campus, source: 'direct', partner,
    });
    const revision = async (lead) => (await Lead.findById(lead._id).lean()).dossier?.revision || 0;
    const transition = async (lead, status, who = 'managerA', extra = {}) => request(app)
      .patch(`/api/partners/leads/${lead._id}/status`).auth(tokens[who], { type: 'bearer' })
      .send({ revision: await revision(lead), status, ...extra });
    const dossier = (lead, who = 'managerA') => request(app).get(`/api/partners/leads/${lead._id}/dossier`).auth(tokens[who], { type: 'bearer' });
    const publicRequest = (method, route, token) => request(app)[method](`/api/public/admission/${route}`)
      .set('X-Portal-Key', process.env.PORTAL_API_KEY).set('X-Forwarded-For', `198.51.100.${source++}`)
      .set('Authorization', token ? `Dossier ${token}` : '');
    const first = await makeLead(); const other = await makeLead(b);
    check('unauthenticated dossier is refused', (await request(app).get(`/api/partners/leads/${first._id}/dossier`)).status === 401);
    check('same-campus partner cannot read a dossier', (await dossier(first, 'partner')).status === 403);
    check('student cannot read an applicant dossier', (await dossier(first, 'student')).status === 403);
    check('manager cannot read another campus dossier', (await dossier(other)).status === 404);
    let response = await request(app).put('/api/partners/admission/config').auth(tokens.managerA, { type: 'bearer' })
      .query({ campusId: b }).send({ requirements: ['identity'] });
    check('configuration derives the manager campus despite an injected campus', response.status === 200
      && (await Campus.findById(a).lean()).admissionRequirements[0] === 'identity'
      && !(await Campus.findById(b).lean()).admissionRequirements?.length);
    response = await transition(first, S.SUBMITTED);
    check('missing required attachment prevents submission', response.status === 409 && response.body.errors.code === E.INCOMPLETE);
    const pdf = await PDFDocument.create(); pdf.addPage().drawText('Synthetic admission document');
    const bytes = Buffer.from(await pdf.save());
    const upload = async (lead, buffer, expected = null) => request(app).post(`/api/partners/leads/${lead._id}/dossier/files`)
      .auth(tokens.managerA, { type: 'bearer' }).field('revision', String(expected ?? await revision(lead)))
      .field('category', 'identity').attach('file', buffer, { filename: 'synthetic.pdf', contentType: 'application/pdf' });
    check('malformed PDF is rejected rather than retained', (await upload(first, Buffer.from('%PDF-broken'))).status === 422);
    const active = await PDFDocument.create(); active.addPage(); active.addJavaScript('synthetic', 'app.alert("synthetic")');
    check('active PDF is rejected', (await upload(first, Buffer.from(await active.save()))).status === 422);
    const competingFiles = await Promise.all([upload(first, bytes, 0), upload(first, bytes, 0)]);
    check('stale concurrent upload commits exactly one file', competingFiles.filter((item) => item.status === 201).length === 1
      && competingFiles.filter((item) => item.status === 409).length === 1 && await Attachment.countDocuments({ lead: first._id }) === 1);
    const file = await Attachment.findOne({ lead: first._id }).lean();
    const management = await dossier(first);
    check('metadata never exposes private storage names', !JSON.stringify(management.body).includes(file.fileName));
    response = await request(app).post(`/api/partners/leads/${first._id}/dossier/access`).auth(tokens.managerA, { type: 'bearer' }).send({ email: 'attacker@fixture.test' });
    check('SMTP absence is explicit and no bearer is returned to management', response.status === 200
      && response.body.data.delivery[0].status === 'skipped' && !JSON.stringify(response.body).includes('#access='));
    const mail = await Notification.findOne({ recipientId: first._id, template: 'admission.access' }).select('+privatePayload').lean();
    const rendered = require('../../modules/notification/notification.private').reveal(mail);
    const token = /#access=([a-f0-9]{64})/.exec(rendered.body)[1];
    check('capability ciphertext is bound to the stored email and absent from snapshots', mail.to === first.email
      && !JSON.stringify(mail).includes(token) && !(await Lead.findById(first._id).lean()).dossierAccessHash);
    check('public portal key alone is not candidate authorization', (await publicRequest('get', 'dossier')).status === 410);
    const own = await publicRequest('get', 'dossier', token);
    check('candidate projection excludes internal and enrollment data', own.status === 200
      && !Object.hasOwn(own.body.data.lead, 'notes') && !Object.hasOwn(own.body.data.lead, 'student')
      && !Object.hasOwn(own.body.data.attachments[0], 'uploadedBy'));
    const download = await publicRequest('get', `dossier/files/${file._id}`, token);
    check('candidate private file download is forced and scoped', download.status === 200
      && download.headers['content-disposition'].startsWith('attachment') && download.headers['content-type'].includes('application/pdf'));
    check('another campus cannot download the file', (await request(app).get(`/api/partners/leads/${first._id}/dossier/files/${file._id}`).auth(tokens.managerB, { type: 'bearer' })).status === 404);
    response = await publicRequest('post', 'dossier/submit', token).send({ revision: await revision(first), status: S.ENROLLED, schoolCampus: b });
    check('candidate submission ignores injected status and campus', response.status === 200 && response.body.data.lead.status === S.SUBMITTED);
    const submitted = await Lead.findById(first._id).lean();
    await request(app).put('/api/partners/admission/config').auth(tokens.managerA, { type: 'bearer' }).send({ requirements: [] });
    check('submitted dossier retains its requirement and attachment snapshot', submitted.dossier.requiredCategories[0] === 'identity'
      && String(submitted.dossier.attachmentIds[0]) === String(file._id));
    check('submitted files are frozen', (await upload(first, bytes)).status === 409);
    check('manager cannot pronounce admission', (await transition(first, S.ADMITTED)).status === 403);
    check('administrator can pronounce admission', (await transition(first, S.ADMITTED, 'admin')).status === 200);
    const klass = await mongoose.model('Class').findOne({ schoolCampus: a, ...require('../../shared/utils/soft-delete').notDeletedFilter(mongoose.model('Class')) }).lean();
    const assignment = (n) => ({ dateOfBirth: '2005-01-01', gender: 'female', username: `admission.student.${n}`, studentClass: String(klass._id) });
    const before = await Student.countDocuments({ schoolCampus: a });
    check('missing student fields roll back enrollment', (await transition(first, S.ENROLLED, 'managerA', { student: {} })).status === 400
      && await Student.countDocuments({ schoolCampus: a }) === before && (await Lead.findById(first._id).lean()).status === S.ADMITTED);
    const enrollments = await Promise.all([transition(first, S.ENROLLED, 'managerA', { student: assignment(1) }), transition(first, S.ENROLLED, 'managerA', { student: assignment(1) })]);
    check('concurrent enrollment is idempotent and creates one student', enrollments.every((item) => item.status === 200)
      && await Student.countDocuments({ schoolCampus: a }) === before + 1
      && String(enrollments[0].body.data.student._id) === String(enrollments[1].body.data.student._id));
    const studentId = enrollments[0].body.data.student._id;
    const student = await Student.findById(studentId).lean();
    check('direct enrollment creates a pending account and no commission', student.status === 'pending'
      && await Commission.countDocuments({ lead: first._id }) === 0 && await mongoose.model('ActivationToken').countDocuments({ userId: studentId }) === 1);
    const activation = enrollments.find((item) => item.body.data.activation)?.body.data.activation;
    check('one enrollment response carries activation only once', !!activation?.code && enrollments.filter((item) => item.body.data.activation).length === 1);
    check('activation is absent from subsequent lead reads', !JSON.stringify((await dossier(first)).body).includes(activation.code));
    const historical = await makeLead(); await Lead.updateOne({ _id: historical._id }, { $set: { status: S.ENROLLED } });
    response = await transition(historical, S.ENROLLED, 'managerA', { student: assignment(2) });
    check('historical enrollment is reported without inventing a student', response.status === 409 && response.body.errors.code === E.HISTORICAL);
    const partner = await mongoose.model('Partner').findOne({ schoolCampus: a }).lean();
    const referred = await makeLead(a, partner._id);
    await transition(referred, S.SUBMITTED); await transition(referred, S.ADMITTED, 'admin');
    const partnerRepo = require('../../modules/partner/partner.repository'); const originalCreate = partnerRepo.createCommission;
    partnerRepo.createCommission = async () => { throw new Error('Synthetic commission failure'); };
    try {
      response = await transition(referred, S.ENROLLED, 'managerA', { student: assignment(3) });
      check('commission failure rolls back student, status and activation', response.status === 500
        && !await Student.exists({ username: assignment(3).username }) && (await Lead.findById(referred._id).lean()).status === S.ADMITTED);
    } finally { partnerRepo.createCommission = originalCreate; }
    response = await transition(referred, S.ENROLLED, 'managerA', { student: assignment(3), tuitionFee: 100000 });
    check('referred enrollment creates exactly one linked commission', response.status === 200
      && await Commission.countDocuments({ lead: referred._id }) === 1
      && String(response.body.data.lead.commissionId) === String(response.body.data.commission._id));
    const importCsv = (username) => Buffer.from(`first_name,last_name,email,phone,date_of_birth,gender,username,student_class\nSynthetic,Import,${username}@fixture.test,+237600000002,2005-01-01,female,${username},${klass._id}\n`);
    response = await request(app).post('/api/students/import').auth(tokens.managerA, { type: 'bearer' })
      .field('campusId', a).attach('file', importCsv('admission.import.1'), { filename: 'synthetic.csv', contentType: 'text/csv' });
    check('student import reuses validated pending creation and the live campus class', response.status === 200
      && response.body.data.imported === 1 && (await Student.findOne({ username: 'admission.import.1' }).lean())?.status === 'pending');
    const quotaLeads = await Promise.all([makeLead(), makeLead()]);
    for (const item of quotaLeads) { await transition(item, S.SUBMITTED); await transition(item, S.ADMITTED, 'admin'); }
    const liveCount = await Student.countDocuments({ schoolCampus: a, ...require('../../shared/utils/soft-delete').notDeletedFilter(Student) });
    const originalEntitlement = (await Campus.findById(a).lean()).entitlement;
    await Campus.collection.updateOne({ _id: new mongoose.Types.ObjectId(a) }, { $set: { 'entitlement.quotas.maxStudents': liveCount + 1 } });
    const capacityRace = await Promise.all(quotaLeads.map((item, index) => transition(item, S.ENROLLED, 'managerA', { student: assignment(20 + index) })));
    check('different dossiers racing for the last student place cannot exceed quota', capacityRace.filter((item) => item.status === 200).length === 1
      && capacityRace.filter((item) => item.status === 409).length === 1
      && await Student.countDocuments({ schoolCampus: a, ...require('../../shared/utils/soft-delete').notDeletedFilter(Student) }) === liveCount + 1);
    response = await request(app).post('/api/students/import').auth(tokens.managerA, { type: 'bearer' })
      .field('campusId', a).attach('file', importCsv('admission.import.2'), { filename: 'synthetic.csv', contentType: 'text/csv' });
    check('ordinary imports cannot bypass capacity consumed by admission', response.status === 200
      && response.body.data.imported === 0 && response.body.data.failed === 1 && !await Student.exists({ username: 'admission.import.2' }));
    await Campus.collection.updateOne({ _id: new mongoose.Types.ObjectId(a) }, { $set: { entitlement: originalEntitlement } });
    const partnerList = await request(app).get('/api/partners/me/leads').auth(tokens.partner, { type: 'bearer' });
    const partnerLead = partnerList.body.data.find((item) => String(item._id) === String(referred._id));
    check('partner self-service excludes dossier and student linkage', !!partnerLead
      && !Object.hasOwn(partnerLead, 'student') && !Object.hasOwn(partnerLead, 'dossier') && !Object.hasOwn(partnerLead, 'notes'));
    const draftArchive = await makeLead();
    await upload(draftArchive, bytes);
    const archivedFile = await Attachment.findOne({ lead: draftArchive._id }).lean();
    await request(app).delete(`/api/partners/leads/${draftArchive._id}/dossier/files/${archivedFile._id}`)
      .auth(tokens.managerA, { type: 'bearer' }).send({ revision: await revision(draftArchive) });
    const retainedBytes = await require('../../modules/partner').service.getAdmissionStorageBytes(a);
    check('archiving retains private bytes in the campus storage budget', retainedBytes >= archivedFile.sizeBytes
      && fs.existsSync(path.join(process.env.UPLOAD_DIR, 'documents', a, 'admission', archivedFile.fileName)));
    const storage = require('../../modules/document/middleware/document.campus.middleware');
    const usageBefore = await storage.computeCampusStorageUsageMB(a);
    const impact = await request(app).get(`/api/danger-zone/admission-attachment/${archivedFile._id}/impact`).auth(tokens.managerA, { type: 'bearer' });
    check('archived attachment requires the ordinary guarded impact preview', impact.status === 200 && impact.body.data.deletable && !!impact.body.data.ticket);
    response = await request(app).delete(`/api/danger-zone/admission-attachment/${archivedFile._id}`)
      .auth(tokens.managerA, { type: 'bearer' }).send({
        ticket: impact.body.data.ticket, confirmationPhrase: impact.body.data.confirmationPhrase,
        password: catalogue.password, reason: 'Synthetic admission attachment cleanup',
      });
    check('guarded attachment deletion removes its stored file and records the audit', response.status === 200
      && !await Attachment.exists({ _id: archivedFile._id })
      && !fs.existsSync(path.join(process.env.UPLOAD_DIR, 'documents', a, 'admission', archivedFile.fileName))
      && await mongoose.model('DeletionAudit').exists({ entityType: 'admission-attachment', entityId: archivedFile._id, outcome: 'completed' }));
    check('guarded deletion immediately invalidates the shared GED usage cache', await storage.computeCampusStorageUsageMB(a) < usageBefore);
    await Campus.updateOne({ _id: a }, { $set: { campusSlug: 'admission-fixture' } });
    response = await request(app).post('/api/public/pre-register').set('X-Portal-Key', process.env.PORTAL_API_KEY)
      .set('X-Forwarded-For', `198.51.100.${source++}`).send({
        firstName: 'Synthetic', lastName: 'Language', email: 'admission-language@fixture.test',
        campusSlug: 'admission-fixture', preferredLanguage: 'constructor', source: 'direct',
      });
    check('an unknown locale cannot access prototype properties in intake normalization', response.status === 202);
    await request(app).delete(`/api/partners/leads/${first._id}/dossier/access`).auth(tokens.managerA, { type: 'bearer' });
    check('revocation invalidates an already used browser capability', (await publicRequest('get', 'dossier', token)).status === 410);
    console.log(`\n${checks}/${checks} admission journey checks passed`);
  } finally {
    await mongoose.disconnect(); await handle.stop();
    process.chdir(previousDirectory); fs.rmSync(runtime, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
