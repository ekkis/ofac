'use strict';
const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const ofac = require('../index');

// Invented fixtures only. No production list downloads are needed by this suite.
const entity = (uid, name, type = 'Entity', alias = '') => `<sdnEntry><uid>${uid}</uid><lastName>${name}</lastName><sdnType>${type}</sdnType><programList><program>TEST-ONLY</program></programList>${alias ? `<akaList><aka><uid>alias-${uid}</uid><lastName>${alias}</lastName></aka></akaList>` : ''}</sdnEntry>`;
const individual = '<sdnEntry><uid>fiction-4</uid><firstName>Zella</firstName><lastName>Exampleton</lastName><sdnType>Individual</sdnType><idList><id><idNumber>FICTION-123</idNumber><idCountry>Exampleland</idCountry><idType>Test Document</idType></id></idList><akaList><aka><lastName>Examplealias</lastName></aka></akaList></sdnEntry>';
const xml = (entries, date = '10/30/2026') => `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>${date}</Publish_Date><Record_Count>${entries.length}</Record_Count></publshInformation>${entries.join('')}</sdnList>`;
let dir, audit, sdn, non;
const query = { search_type: 'entity', name: 'Fictional-Orchid Works' };
function records() { return ofac.readAudit().filter(r => r.kind === 'search'); }
function configure(extra = {}) {
    ofac.config({ force: false, path: dir, fetch: require('node-fetch'), xml: 'sdn.xml',
        lists: ['sdn', 'non-sdn'], refreshInterval: 86400000, threshold: 1, auditPath: audit,
        sources: { sdn: { file: sdn }, 'non-sdn': { file: non } }, ...extra });
}
describe('Additive screening API', () => {
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofac-screening-'));
        audit = path.join(dir, 'audit.jsonl'); sdn = path.join(dir, 'sdn.xml'); non = path.join(dir, 'consolidated.xml');
        fs.writeFileSync(sdn, xml([entity('fiction-1', 'FICTIONAL ORCHID WORKS', 'Entity', 'FICTIONAL PETAL COMPANY'), entity('fiction-2', 'FICTIONAL ORCHID SHIP', 'Vessel'), entity('fiction-3', 'FICTIONAL ORCHID AIR', 'Aircraft'), individual]));
        fs.writeFileSync(non, xml([entity('fiction-5', 'FICTIONAL MARIGOLD COMPANY')]));
        configure(); await ofac.init();
    });
    it('matches legal entity names, aliases, punctuation and case', async () => {
        const input = { ...query };
        const hits = await ofac.search(input);
        assert.deepEqual(input, query);
        assert.equal(hits[0].uid, 'fiction-1'); assert.equal(hits[0].matchScore, 1);
        assert.deepEqual(hits[0].matchedFields, ['lastName']);
        const aliases = await ofac.search({ search_type: 'entity', lastName: 'fictional petal company' });
        assert.equal(aliases[0].uid, 'fiction-1'); assert.deepEqual(aliases[0].matchedFields, ['akaList[0].lastName']);
    });
    it('covers vessels and aircraft with entity, unifies omitted types and keeps individual filtering', async () => {
        assert.equal((await ofac.search({ search_type: 'entity', name: 'fictional orchid ship' }))[0].sdnType, 'Vessel');
        assert.equal((await ofac.search({ search_type: 'entity', name: 'fictional orchid air' }))[0].sdnType, 'Aircraft');
        assert.equal((await ofac.search({ name: 'fictional orchid works' }))[0].uid, 'fiction-1');
        assert.deepEqual(await ofac.search({ search_type: 'individual', name: query.name }), []);
        assert.equal((await ofac.search({ search_type: 'vessel', name: 'fictional orchid ship' }))[0].uid, 'fiction-2');
    });
    it('preserves individual id priority, optional country/type checks, and alias fallback', async () => {
        const hit = (await ofac.search({ search_type: 'individual', id: 'fiction-123', country: 'Exampleland', id_type: 'Test Document', firstName: 'Wrong' }))[0];
        assert.equal(hit.uid, 'fiction-4'); assert.equal(hit.matchScore, 1);
        assert.deepEqual(hit.matchedFields, ['idList[0].idNumber', 'idList[0].idCountry', 'idList[0].idType']);
        assert.deepEqual(await ofac.search({ id: 'fiction-123', country: 'Elsewhere' }), []);
        assert.deepEqual(await ofac.search({ id: 'fiction-123', id_type: 'Wrong' }), []);
        assert.equal((await ofac.search({ search_type: 'individual', firstName: 'Zella', lastName: 'Examplealias' }))[0].uid, 'fiction-4');
        assert.equal((await ofac.search({ id: 'fiction-123' }))[0].uid, 'fiction-4');
    });
    it('reports the actual primary and alias fields used for full individual names', async () => {
        const full = (await ofac.search({ search_type: 'individual', name: 'Zella Exampleton' }))[0];
        assert.deepEqual(full.matchedFields, ['firstName', 'lastName']);
        const alias = (await ofac.search({ search_type: 'individual', name: 'Zella Examplealias' }))[0];
        assert.deepEqual(alias.matchedFields, ['firstName', 'akaList[0].lastName']);
    });
    it('audits invalid query and purpose attempts as failed screens', async () => {
        await assert.rejects(() => ofac.search(null), /Query/);
        await assert.rejects(() => ofac.search({ purpose: 'fictional invalid value' }), /purpose/);
        assert.equal(records().length, 2);
        assert.equal(records()[1].query.given.purpose, 'fictional invalid value');
        assert.ok(records().every(record => record.error.code === 'SCREEN_FAILED'));
    });
    it('finds non-SDN entries only when that list is selected, with no SDN-only fallback', async () => {
        const q = { name: 'fictional marigold company' };
        assert.deepEqual(await ofac.search({ ...q, lists: ['sdn'] }), []);
        assert.equal((await ofac.search({ ...q, lists: 'consolidated' }))[0].list, 'non-sdn');
        assert.deepEqual(records()[0].lists.map(l => l.list), ['sdn']);
        assert.deepEqual(records()[1].lists.map(l => l.list), ['sdn', 'non-sdn']);
        assert.equal((await ofac.search(q))[0].uid, 'fiction-5');
    });
    it('persists every search including no hits and failures, with version/date and pending dispositions', async () => {
        const hit = (await ofac.search(query))[0];
        await ofac.search({ name: 'fictional unmatched name' });
        await assert.rejects(() => ofac.search({ ...query, threshold: 2 }), /threshold/);
        const rows = records(); assert.equal(rows.length, 3);
        const row = rows[0]; assert.ok(!Number.isNaN(Date.parse(row.timestamp)));
        assert.deepEqual(row.query.given, query);
        assert.deepEqual(row.query.normalised, { search_type: 'entity', name: 'fictional orchid works' });
        assert.equal(row.matching.threshold, 1);
        assert.equal(row.lists[0].publicationDate, '10/30/2026');
        assert.match(row.lists[0].version, /^sha256:[a-f0-9]{64}$/);
        assert.equal(row.results[0].uid, hit.uid); assert.deepEqual(row.results[0].matchedFields, hit.matchedFields);
        assert.deepEqual(row.disposition, { state: 'pending', reviewer: null, rationale: null });
        assert.deepEqual(rows[1].results, []); assert.equal(rows[2].error.code, 'SCREEN_FAILED');
        assert.equal(row.query.given.name, 'Fictional-Orchid Works');
    });
    it('retains individual search inputs exactly and normalised, excluding wider customer data', async () => {
        const input = { search_type: 'Individual', firstName: 'Zella', lastName: 'Exampleton',
            id: 'FICTION-123', country: 'Exampleland', id_type: 'Test Document',
            email: 'fictional@example.invalid', customer: { note: 'fictional customer-only note' } };
        await ofac.search(input);
        const row = records()[0];
        const { email, customer, ...expected } = input;
        assert.deepEqual(row.query.given, expected);
        assert.deepEqual(row.query.normalised, { search_type: 'individual', firstName: 'zella', lastName: 'exampleton',
            id: 'fiction-123', country: 'exampleland', id_type: 'test document' });
        const persisted = fs.readFileSync(audit, 'utf8');
        assert.ok(!persisted.includes(email)); assert.ok(!persisted.includes(customer.note));
        assert.equal(fs.statSync(audit).mode & 0o777, 0o600);
        assert.deepEqual(input.customer, customer);
    });
    it('re-screens audit records with their original list scope and effective threshold', async () => {
        configure({ threshold: 0.95 });
        await ofac.search({ search_type: 'entity', name: 'fictional orchid workz', lists: ['sdn'] });
        const original = records()[0];
        configure({ threshold: 1, lists: ['non-sdn'] });
        const [report] = await ofac.rescreen([original], { refresh: false });
        assert.equal(report.results[0].uid, 'fiction-1');
        assert.deepEqual(report.newMatches, []);
        assert.equal(report.previousAuditId, original.id);
        assert.equal(records()[1].matching.threshold, 0.95);
        assert.deepEqual(records()[1].requestedLists, ['sdn']);
    });
    it('re-screens external audit records against their recorded caller-managed file', async () => {
        await ofac.search(query, sdn);
        const original = records()[0];
        const [report] = await ofac.rescreen([original], { refresh: false });
        assert.equal(report.results[0].list, 'external'); assert.deepEqual(report.newMatches, []);
        assert.equal(report.previousAuditId, original.id);
    });
    it('rejects historical redacted records and failed screens rather than guessing their queries', async () => {
        await ofac.search(query);
        const original = records()[0];
        await assert.rejects(() => ofac.rescreen([{ ...original, query: { redacted: true } }], { refresh: false }), /redacted/);
        await assert.rejects(() => ofac.rescreen([{ ...original, error: { code: 'SCREEN_FAILED' } }], { refresh: false }), /failed/);
    });
    it('fails closed when audit path is missing, unwritable or not absolute', async () => {
        for (const auditPath of [null, 'relative.jsonl', dir, path.join(dir, 'absent', 'audit.jsonl')]) {
            configure({ auditPath }); await assert.rejects(() => ofac.search(query));
        }
    });
    it('keeps original enumerable fields while serialising additive match and disposition metadata', async () => {
        const hit = (await ofac.search(query))[0];
        assert.deepEqual(hit, { uid: 'fiction-1', lastName: 'FICTIONAL ORCHID WORKS', sdnType: 'Entity', programList: ['TEST-ONLY'], akaList: [{ uid: 'alias-fiction-1', lastName: 'FICTIONAL PETAL COMPANY' }], idList: [] });
        const serialised = JSON.parse(JSON.stringify(hit));
        assert.equal(serialised.matchScore, 1); assert.deepEqual(serialised.matchedFields, ['lastName']);
        assert.equal(serialised.disposition.state, 'pending'); assert.equal(serialised.auditId, hit.auditId);
    });
    it('uses normalised Levenshtein scores and an inclusive threshold, with exact matching as the floor', async () => {
        const near = { search_type: 'entity', name: 'fictional orchid workz' };
        assert.deepEqual(await ofac.search(near), []);
        const hits = await ofac.search({ ...near, threshold: 0.95 });
        assert.equal(hits.length, 1); assert.ok(hits[0].matchScore > 0.95 && hits[0].matchScore < 0.96);
        assert.deepEqual(await ofac.search({ ...near, threshold: 0.96 }), []);
        configure({ threshold: 0.95 }); assert.equal((await ofac.search(near))[0].uid, 'fiction-1');
        assert.equal((await ofac.search({ ...query, threshold: 1 }))[0].matchScore, 1);
    });
    it('refreshes and re-screens stored queries, surfacing new list-scoped matches as pending', async () => {
        const q = { search_type: 'entity', name: 'fictional future company', purpose: 'onboarding' };
        const before = await ofac.search(q); assert.equal(before.length, 0);
        const version = ofac.listInfo()[1].version;
        fs.writeFileSync(non, xml([entity('fiction-new', 'FICTIONAL FUTURE COMPANY')], '10/31/2026'));
        const reports = await ofac.rescreen([{ query: q, results: before }]);
        assert.notEqual(ofac.listInfo()[1].version, version);
        assert.equal(reports[0].newMatches[0].uid, 'fiction-new');
        assert.equal(reports[0].newMatches[0].disposition.state, 'pending');
        assert.equal(records()[1].lists[1].publicationDate, '10/31/2026');
        const again = await ofac.rescreen([{ query: q, results: reports[0].results }]);
        assert.deepEqual(again[0].newMatches, []);
        const fromAudit = await ofac.rescreen([records()[0]], { refresh: false });
        assert.equal(fromAudit[0].newMatches[0].uid, 'fiction-new');
        assert.equal(fromAudit[0].previousAuditId, records()[0].id);
    });
    it('refreshes stale network files and forces refresh even in explicit download-once mode', async () => {
        let calls = 0, updated = false;
        configure({ lists: ['sdn'], sources: {}, refreshInterval: false, fetch: async () => {
            calls++; return { body: Readable.from([xml([entity('fiction-fetch', updated ? 'FICTIONAL UPDATED COMPANY' : 'FICTIONAL ORIGINAL COMPANY')])]) };
        } });
        // Use a separate cache from the local fixture.
        ofac.config({ path: path.join(dir, 'downloads') });
        await ofac.init(); assert.equal(calls, 1);
        updated = true;
        await ofac.search({ name: 'fictional updated company' }); assert.equal(calls, 1);
        await ofac.refresh(); assert.equal(calls, 2);
        assert.equal((await ofac.search({ name: 'fictional updated company' }))[0].uid, 'fiction-fetch');
        ofac.config({ refreshInterval: 0 });
        await ofac.search({ name: 'fictional updated company' }); assert.equal(calls, 3);
        const snapshot = ofac.listInfo();
        ofac.config({ fetch: async () => { throw new Error('test offline'); } });
        await assert.rejects(() => ofac.search(query), /test offline/);
        assert.deepEqual(ofac.listInfo(), snapshot);
        assert.equal(records().slice(-1)[0].error.code, 'SCREEN_FAILED');
    });
    it('refreshes only explicitly selected lists without changing the configured default', async () => {
        configure({ refreshInterval: 0 });
        fs.unlinkSync(non);
        assert.equal((await ofac.search({ ...query, lists: ['sdn'] }))[0].uid, 'fiction-1');
        assert.deepEqual(ofac.opts.lists, ['sdn', 'non-sdn']);
        await assert.rejects(() => ofac.search(query), /ENOENT/);
    });
    it('serialises concurrent refreshes and records one complete audit per search', async () => {
        configure({ refreshInterval: 0 });
        const [first, second] = await Promise.all([
            ofac.search({ ...query, lists: ['sdn'] }),
            ofac.search({ name: 'fictional marigold company', lists: ['non-sdn'] })
        ]);
        assert.equal(first[0].uid, 'fiction-1'); assert.equal(second[0].uid, 'fiction-5');
        assert.equal(records().length, 2);
        assert.notEqual(first.auditId, second.auditId);
    });
    it('fails on non-SDN download or invalid XML rather than screening a partial list', async () => {
        configure({ force: true, sources: { sdn: { file: sdn } }, fetch: async () => ({ ok: false, status: 503 }) });
        await assert.rejects(() => ofac.init(), /503/);
        configure(); fs.writeFileSync(non, '<wrong/>');
        await assert.rejects(() => ofac.refresh(), /Expected OFAC/);
    });
    it('appends disposition events and distinguishes onboarding refusal from transaction blocking', async () => {
        const onboarding = await ofac.screenOnboarding({ name: query.name });
        const auditId = onboarding.auditId;
        assert.equal(onboarding[0].purpose, 'onboarding');
        assert.throws(() => ofac.setDisposition(auditId, { state: 'blocked', reviewer: 'reviewer-1', rationale: 'test decision' }), /transaction/);
        assert.throws(() => ofac.setDisposition(auditId, { state: 'cleared' }), /required/);
        const initial = fs.readFileSync(audit, 'utf8');
        ofac.setDisposition(auditId, { state: 'escalated', reviewer: 'reviewer-1', rationale: 'test review' });
        ofac.setDisposition(auditId, { state: 'refused', reviewer: 'reviewer-1', rationale: 'test confirmed' });
        assert.ok(fs.readFileSync(audit, 'utf8').startsWith(initial));
        assert.throws(() => ofac.setDisposition(auditId, { state: 'cleared', reviewer: 'reviewer-1', rationale: 'test' }), /final/);
        const transaction = await ofac.screenTransaction(query);
        ofac.setDisposition(transaction.auditId, { state: 'blocked', reviewer: 'reviewer-1', rationale: 'test confirmed' });
        const report = ofac.blockingReportData(transaction[0]);
        assert.equal(report.target.uid, 'fiction-1'); assert.deepEqual(report.target.programList, ['TEST-ONLY']);
        assert.ok(report.callerRequired.includes('blockedDate')); assert.ok(report.callerRequired.includes('supportingDocuments'));
        assert.throws(() => ofac.blockingReportData(onboarding[0]), /Transaction/);
    });
    it('records cleared false positives with rationale and permits audit export without modifying records', async () => {
        const hit = (await ofac.search(query))[0];
        ofac.setDisposition(hit.auditId, { state: 'cleared', reviewer: 'reviewer-2', rationale: 'test unrelated business' });
        const rows = ofac.readAudit(); assert.equal(rows[0].disposition.state, 'pending');
        assert.equal(rows[1].disposition.state, 'cleared'); assert.equal(rows[1].disposition.rationale, 'test unrelated business');
        assert.equal(fs.readFileSync(audit, 'utf8').trim().split('\n').length, 2);
    });
});
