// Explicit offline/SDN-only configuration for the unchanged legacy suite.
const fs = require('fs');
const os = require('os');
const path = require('path');
const ofac = require('../index');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofac-legacy-'));
ofac.config({ lists: ['sdn'], refreshInterval: false,
    sources: { sdn: { file: '/tmp/sdn.xml' } }, auditPath: path.join(dir, 'audit.jsonl') });
ofac.db = '/tmp/sdn.xml';
