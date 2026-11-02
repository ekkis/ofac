'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pipeline = require('util').promisify(require('stream').pipeline);
const fetch = require('node-fetch');
const Zip = require('node-stream-zip');
const xml2js = require('xml2js');
const parseXML = require('util').promisify(xml2js.parseString);

const clone = value => JSON.parse(JSON.stringify(value));
const lower = value => String(value || '').toLowerCase();
const normalName = value => lower(value).replace(/\W/g, ' ');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const defaults = {
    force: false, path: '/tmp', xml: 'sdn.xml', fetch,
    lists: ['sdn', 'non-sdn'], refreshInterval: 24 * 60 * 60 * 1000,
    threshold: 1, auditPath: null
};
const urls = {
    sdn: 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn.xml',
    'non-sdn': 'https://sanctionslistservice.ofac.treas.gov/api/download/consolidated.xml'
};
let loaded = {}, loading;
const self = module.exports = {
    url: 'https://sanctionslistservice.ofac.treas.gov/api/download/sdn_xml.zip',
    opts: { ...defaults },
    states: Object.freeze(['pending', 'cleared', 'escalated', 'refused', 'blocked']),
    config(opts = {}) { self.opts = { ...self.opts, ...opts }; },
    fn(url = self.opts.xml) { return path.join(self.opts.path, path.basename(url)); },
    async fetch(url = self.url) {
        const fn = self.fn(url);
        const fresh = fs.existsSync(fn) && (self.opts.refreshInterval === false ||
            Date.now() - fs.statSync(fn).mtimeMs < self.opts.refreshInterval);
        if (fresh && !self.opts.force) return fn;
        fs.mkdirSync(self.opts.path, { recursive: true });
        const metadataPath = `${fn}.http.json`;
        let metadata;
        try {
            const saved = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
            // Bind validators to both the source and the actual cached bytes.
            // A missing, replaced or partially updated cache needs a full GET.
            if (saved.url === url && saved.sha256 === digest(fs.readFileSync(fn))) metadata = saved;
        } catch {}
        const headers = {};
        if (metadata && metadata.etag) headers['If-None-Match'] = metadata.etag;
        else if (metadata && metadata.lastModified) headers['If-Modified-Since'] = metadata.lastModified;
        await self.validateUrl(url);
        let res = await self.opts.fetch(url, { headers });
        if (res.status === 304) {
            if (res.body && res.body.destroy) res.body.destroy();
            // Recheck after the request in case the local file was removed or
            // changed while the server was validating it.
            let usable = false;
            try { usable = !!metadata && metadata.sha256 === digest(fs.readFileSync(fn)); } catch {}
            if (usable) {
                const now = new Date();
                fs.utimesSync(fn, now, now);
                return fn;
            }
            res = await self.opts.fetch(url, { headers: {} });
        }
        if (res.status === 304) throw new Error('List validation returned 304 without a usable cache');
        if (res.ok === false) throw new Error(`List download failed: ${res.status}`);
        const tmp = `${fn}.${crypto.randomBytes(16).toString('hex')}.tmp`;
        const metadataTmp = `${tmp}.http.json`;
        try {
            await pipeline(res.body, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
            fs.writeFileSync(metadataTmp, JSON.stringify({ url,
                etag: (res.headers && res.headers.get('etag')) || null,
                lastModified: (res.headers && res.headers.get('last-modified')) || null,
                sha256: digest(fs.readFileSync(tmp)) }), { flag: 'wx', mode: 0o600 });
            fs.renameSync(tmp, fn);
            fs.renameSync(metadataTmp, metadataPath);
        } finally {
            for (const file of [tmp, metadataTmp]) if (fs.existsSync(file)) fs.unlinkSync(file);
        }
        return fn;
    },
    validateUrl: (url) => {
        // Only validate actual URLs (start with http/https), not local file names
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            // Local file path - no URL validation needed
            return Promise.resolve(url);
        }

        // SSRF protection: parse and validate URL
        try {
            const parsed = new URL(url);

            // Only allow HTTPS
            if (parsed.protocol !== 'https:') {
                throw new Error('Only HTTPS URLs are allowed');
            }

            // Domain allowlist for OFAC data source
            const allowedHosts = [
                'www.treasury.gov',
                'sanctionssearch.ofac.treas.gov',
                'ofac.treas.gov'
            ];

            if (!allowedHosts.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) {
                console.warn(`Security: URL hostname ${parsed.hostname} is not in the trusted OFAC domain whitelist.`);
            }

            return Promise.resolve(url);
        } catch (err) {
            return Promise.reject(new Error(`Invalid URL: ${err.message}`));
        }
    },
    zipExtract(zip, fn = self.opts.xml, dest = self.opts.path) {
        if (fn.includes('..') || fn.startsWith('/') || fn.startsWith('\\')) {
            return Promise.reject(new Error(`Security: Suspicious filename in zip entry: ${fn}`));
        }
        const xml = path.join(dest, fn);
        if (fs.existsSync(xml) && !self.opts.force) return Promise.resolve(xml);
        return new Promise((resolve, reject) => {
            const z = new Zip({ file: zip });
            z.on('error', err => { z.close(); reject({ zip, xml, src: 'on', err }); });
            z.on('ready', () => z.extract(fn, dest, err => {
                z.close();
                if (err) reject({ zip, xml, src: 'ready', err });
                else resolve(xml);
            }));
        });
    },
    async init(opts = {}, requestedLists) {
        self.config(opts);
        validateOptions();
        while (loading) await loading;
        loading = (async () => {
            const next = {};
            for (const list of selectLists(requestedLists || self.opts.lists)) {
                const source = self.opts.sources && self.opts.sources[list];
                let fn;
                if (source && source.file) fn = source.file;
                else fn = await self.fetch((source && source.url) || urls[list]);
                next[list] = await readList(fn, list);
            }
            loaded = next; // publish only a complete, parsed snapshot
            self.db = next.sdn ? next.sdn.file : Object.values(next)[0].file;
            return self.db;
        })();
        try { return await loading; } finally { loading = null; }
    },
    async ensureCurrentSnapshot() {
        validateOptions();
        if (loading) await loading;
        const lists = selectLists(self.opts.lists);
        const stale = lists.some(list => !loaded[list] || (self.opts.refreshInterval !== false && Date.now() - loaded[list].loadedAt >= self.opts.refreshInterval));
        if (stale || self.opts.force) await self.init({}, lists);
        return self.listInfo();
    },
    async refresh() {
        const force = self.opts.force;
        try { return await self.init({ force: true }); }
        finally { self.opts.force = force; }
    },
    listInfo() { return Object.values(loaded).map(db => clone(db.info)); },
    async dbinfo() {
        if (!self.db) await self.init();
        const db = await readList(self.db, 'sdn');
        return { 'Publish Date': db.info.publicationDate, 'Record Count': db.count };
    },
    async search(cust, filename) {
        let given, query;
        const audit = {
            schemaVersion: 1, id: crypto.randomBytes(16).toString('hex'), kind: 'search', timestamp: new Date().toISOString(),
            query: { given: {}, normalised: {} }, purpose: 'screening',
            lists: [], results: [], disposition: { state: 'pending', reviewer: null, rationale: null }
        };
        let hits = [], failure;
        try {
            if (!cust || typeof cust !== 'object' || Array.isArray(cust)) throw new Error('Query must be an object');
            if (cust.caseContext) audit.context = clone(cust.caseContext);
            given = searchInputs(cust);
            query = normalise(given);
            audit.query = { given: clone(given), normalised: clone(query) };
            audit.purpose = ['screening', 'onboarding', 'transaction'].includes(query.purpose) ? query.purpose : 'screening';
            if (query.purpose && !['screening', 'onboarding', 'transaction'].includes(query.purpose)) throw new Error('Invalid screening purpose');
            validateOptions();
            const threshold = given.threshold === undefined ? self.opts.threshold : given.threshold;
            if (typeof threshold !== 'number' || threshold < 0 || threshold > 1 || !Number.isFinite(threshold)) throw new Error('threshold must be between 0 and 1');
            audit.matching = { threshold };
            const lists = filename ? ['external'] : selectLists(given.lists || self.opts.lists);
            audit.requestedLists = lists;
            let dbs;
            if (filename) dbs = [await readList(filename, 'external')];
            else {
                if (loading) await loading;
                const stale = lists.some(list => !loaded[list] || (self.opts.refreshInterval !== false &&
                    Date.now() - loaded[list].loadedAt >= self.opts.refreshInterval));
                if (stale || self.opts.force) await self.init({}, lists);
                dbs = lists.map(list => loaded[list]);
            }
            audit.lists = dbs.map(db => clone(db.info));
            for (const db of dbs) for (const entry of db.entries) {
                if (!typeMatches(query.search_type, entry.sdnType)) continue;
                const match = compare(query, entry, threshold);
                if (!match) continue;
                const hit = clone(entry);
                const metadata = { matchScore: match.score, matchedFields: match.fields,
                    list: db.info.list, listVersion: db.info.version, listDate: db.info.publicationDate,
                    auditId: audit.id, disposition: clone(audit.disposition), purpose: audit.purpose };
                // Preserve legacy enumerable records (including deepEqual) while exposing additive fields.
                for (const [key, value] of Object.entries(metadata)) Object.defineProperty(hit, key, { value, enumerable: false });
                Object.defineProperty(hit, 'toJSON', { value: () => ({ ...hit, ...metadata }) });
                hits.push(hit);
                audit.results.push({ uid: hit.uid, list: metadata.list, matchScore: match.score,
                    matchedFields: match.fields, entry: clone(entry), disposition: clone(audit.disposition) });
            }
        } catch (err) { failure = err; audit.error = { code: 'SCREEN_FAILED' }; }
        appendAudit(audit); // failure is fatal, including for empty results or search errors
        if (failure) throw failure;
        Object.defineProperty(hits, 'auditId', { value: audit.id });
        return hits;
    },
    screenOnboarding(query) { return self.search({ ...query, search_type: 'entity', purpose: 'onboarding' }); },
    screenTransaction(query) { return self.search({ ...query, purpose: 'transaction' }); },
    async rescreen(items, { refresh = true } = {}) {
        if (refresh) await self.refresh();
        const reports = [];
        for (const item of items) {
            const previous = item.kind === 'search' ? item : null;
            if (previous && previous.query.redacted) throw new Error('Audit query is redacted; supply the stored query and prior results instead');
            if (previous && previous.error) throw new Error('Cannot re-screen a failed search record');
            const query = clone(previous ? previous.query.given : (item.query || item));
            const external = previous && previous.requestedLists && previous.requestedLists[0] === 'external';
            if (previous && !external && query.lists === undefined) query.lists = previous.requestedLists;
            if (previous && previous.matching && query.threshold === undefined) query.threshold = previous.matching.threshold;
            const filename = external ? previous.lists[0].file : undefined;
            const results = await self.search(query, filename);
            const old = new Set((previous ? previous.results : item.results || []).map(hit => `${hit.list}:${hit.uid}`));
            reports.push({ auditId: results.auditId, previousAuditId: previous && previous.id,
                results, newMatches: results.filter(hit => !old.has(`${hit.list}:${hit.uid}`)) });
        }
        return reports;
    },
    saveCheckpoint(checkpoint) { appendAudit({ ...checkpoint, kind: 'checkpoint', timestamp: new Date().toISOString() }); },
    saveOwnership(disclosure) { appendAudit({ ...disclosure, kind: 'ownership-disclosure', timestamp: new Date().toISOString() }); },
    readAudit() {
        return fs.readFileSync(auditPath(), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    setDisposition(auditId, { state, reviewer, rationale, blocked }) {
        if (!self.states.includes(state) || state === 'pending') throw new Error('Invalid disposition transition');
        if (!reviewer || !rationale) throw new Error('reviewer and rationale are required');
        const records = self.readAudit();
        const screen = records.find(r => r.kind === 'search' && r.id === auditId);
        if (!screen) throw new Error('Unknown auditId');
        if (screen.context?.role === 'owner' && state === 'refused' && blocked !== true) throw new Error('Owner refusal requires explicit confirmation of blocking sanctions');
        if (blocked !== undefined && (screen.context?.role !== 'owner' || state !== 'refused' || blocked !== true)) throw new Error('Invalid owner blocking finding');
        const last = records.filter(r => r.kind === 'disposition' && r.auditId === auditId).pop();
        if (last && last.disposition.state !== 'escalated') throw new Error('Disposition is final');
        if (state === 'refused' && screen.purpose !== 'onboarding') throw new Error('refused requires onboarding');
        if (state === 'blocked' && screen.purpose !== 'transaction') throw new Error('blocked requires transaction');
        const record = { id: crypto.randomBytes(16).toString('hex'), kind: 'disposition', timestamp: new Date().toISOString(),
            auditId, disposition: { state, reviewer, rationale, ...(blocked === true ? { blocked: true } : {}) } };
        appendAudit(record);
        return record;
    },
    blockingReportData(hit) {
        if (hit.purpose !== 'transaction') throw new Error('Transaction screening hit required');
        return { auditId: hit.auditId, list: hit.list, listVersion: hit.listVersion, listDate: hit.listDate,
            target: clone(hit), matchedFields: hit.matchedFields, matchScore: hit.matchScore,
            callerRequired: ['holderNameAndAddress', 'contactName', 'contactTelephone', 'contactEmail',
                'transactionDescriptionParticipantsLocationsAndReferences', 'blockedDate', 'propertyDescriptionAndLocation', 'actualOrEstimatedValueUSD',
                'targetInterest', 'legalAuthority', 'actionTaken', 'supportingDocuments'] };
    }
};
function searchInputs(customer) {
    // Persist only fields this API consumes, never the caller's wider customer record.
    const query = {};
    for (const key of ['search_type', 'name', 'firstName', 'lastName', 'id', 'id_type', 'country', 'purpose', 'lists', 'threshold']) {
        if (!Object.prototype.hasOwnProperty.call(customer, key) || customer[key] === undefined) continue;
        const value = customer[key];
        if (key === 'lists') {
            if (typeof value !== 'string' && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) throw new Error('lists must be a string or an array of strings');
        } else if (key === 'threshold') {
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('threshold must be a finite number');
        } else if (typeof value !== 'string') throw new Error(`${key} must be a string`);
        query[key] = clone(value);
    }
    return query;
}
function auditPath() {
    if (!self.opts.auditPath || !path.isAbsolute(self.opts.auditPath)) throw new Error('An absolute auditPath is required; screening cannot run without an audit record');
    return self.opts.auditPath;
}
function appendAudit(record) {
    const fn = auditPath();
    const fd = fs.openSync(fn, 'a', 0o600);
    try {
        fs.fchmodSync(fd, 0o600);
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete audit write');
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
}
function validateOptions() {
    const interval = self.opts.refreshInterval;
    if (interval !== false && (typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0)) throw new Error('refreshInterval must be milliseconds >= 0, or false');
    selectLists(self.opts.lists);
}
function selectLists(value) {
    const lists = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(lists) || !lists.length) throw new Error('At least one list is required');
    const expanded = [...new Set(lists.flatMap(list => list === 'consolidated' ? ['sdn', 'non-sdn'] : [list]))];
    if (expanded.some(list => !urls[list])) throw new Error('Unknown list (use sdn, non-sdn, consolidated)');
    return expanded;
}
async function readList(file, list) {
    const bytes = await fs.promises.readFile(file);
    let parsed;
    try { parsed = await parseXML(bytes.toString(), { explicitArray: false }); }
    catch (err) {
        // Keep the legacy error format for malformed entry fragments.
        const fragments = bytes.toString().split(/\r?\n/).join('').match(/<sdnEntry>[\s\S]*?<\/sdnEntry>/g) || [];
        for (const fragment of fragments) {
            try { await parseXML(fragment, { explicitArray: false }); }
            catch (entryError) { throw new Error(String(entryError)); }
        }
        throw new Error(String(err));
    }
    const root = parsed && parsed.sdnList;
    if (!root || !root.publshInformation) throw new Error('Expected OFAC legacy sdnList XML with publication metadata');
    const raw = root.sdnEntry || [];
    const entries = (Array.isArray(raw) ? raw : [raw]).map(entry => {
        for (const key of Object.keys(entry)) if (/List$/.test(key)) {
            const value = entry[key] && entry[key][Object.keys(entry[key])[0]];
            entry[key] = value ? (Array.isArray(value) ? value : [value]) : [];
        }
        entry.idList = entry.idList || [];
        entry.akaList = entry.akaList || [];
        return entry;
    });
    return { file, entries, loadedAt: fs.statSync(file).mtimeMs, count: root.publshInformation.Record_Count,
        info: { list, version: `sha256:${digest(bytes)}`, publicationDate: root.publshInformation.Publish_Date || null,
            loadedAt: new Date().toISOString(), file } };
}
function normalise(query) {
    const out = clone(query);
    for (const key of Object.keys(out)) if (typeof out[key] === 'string') out[key] = lower(out[key]);
    for (const key of ['name', 'firstName', 'lastName']) if (out[key]) out[key] = normalName(out[key]);
    return out;
}
function typeMatches(type, actual) {
    if (!type) return true;
    if (type === 'entity') return lower(actual) !== 'individual';
    return type === lower(actual);
}
function similarity(a, b) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;
    let row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const next = [i];
        for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
        row = next;
    }
    return 1 - row[b.length] / Math.max(a.length, b.length);
}
function compare(query, entry, threshold) {
    const ids = entry.idList;
    for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (query.id && lower(id.idNumber) === query.id &&
            (!id.idCountry || !query.country || lower(id.idCountry) === query.country) &&
            (!id.idType || !query.id_type || lower(id.idType) === query.id_type)) {
            return { score: 1, fields: [`idList[${i}].idNumber`,
                ...(id.idCountry && query.country ? [`idList[${i}].idCountry`] : []),
                ...(id.idType && query.id_type ? [`idList[${i}].idType`] : [])] };
        }
    }
    const candidates = [{ record: entry, prefix: '', alias: false },
        ...entry.akaList.map((record, i) => ({ record, prefix: `akaList[${i}].`, alias: true }))];
    let best;
    for (const { record, prefix, alias } of candidates) {
        let pairs = [];
        if (query.name) {
            const first = record.firstName || (alias && lower(entry.sdnType) === 'individual' ? entry.firstName : '');
            const last = record.lastName || (alias && lower(entry.sdnType) === 'individual' ? entry.lastName : '');
            pairs = [[query.name, [first, last].filter(Boolean).join(' '), [
                ...(first ? [record.firstName ? `${prefix}firstName` : 'firstName'] : []),
                ...(last ? [record.lastName ? `${prefix}lastName` : 'lastName'] : [])
            ]]];
        } else if (alias && lower(entry.sdnType) === 'individual') {
            // Legacy aliases require both components, with canonical fallback.
            pairs = [[query.firstName || '', record.firstName || entry.firstName || '', record.firstName ? `${prefix}firstName` : 'firstName'],
                [query.lastName || '', record.lastName || entry.lastName || '', record.lastName ? `${prefix}lastName` : 'lastName']];
        } else {
            if (!alias && lower(entry.sdnType) === 'individual' && (query.firstName || query.lastName) &&
                !['firstName', 'lastName'].some(key => query[key] && record[key])) {
                return { score: 1, fields: [] }; // existing missing-component behaviour
            }
            for (const key of ['firstName', 'lastName']) if (query[key] && record[key]) pairs.push([query[key], record[key], `${prefix}${key}`]);
        }
        if (!pairs.length || !(query.name || query.firstName || query.lastName)) continue;
        const score = Math.min(...pairs.map(([queryName, value]) => similarity(queryName, normalName(value))));
        if (score >= threshold && (!best || score > best.score)) best = { score, fields: pairs.flatMap(pair => pair[2]) };
    }
    return best;
}
