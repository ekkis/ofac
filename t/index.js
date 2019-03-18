var fs = require('fs');
var assert = require('assert').strict;
const ofac = require('../index.js');
const fn = 't/t.xml';

var expected = [{
	uid: '4106',
	firstName: 'helmer',
	lastName: 'herrera buitrago',
	sdnType: 'individual',
	programList: { program: 'SDNT' },
	idList: [
		{ uid: '1011', idType: 'passport', idNumber: 'j287011', idCountry: 'colombia', firstName: '', lastName: '' },
		{ uid: '1010', idType: 'cedula no.', idNumber: '16247821', idCountry: 'colombia', firstName: '', lastName: '' } 
	],
	akaList: [
		{ uid: '7776', type: 'a.k.a.', category: 'weak', lastName: 'pacho', firstName: '' },
		{ uid: '7777', type: 'a.k.a.', category: 'weak', lastName: 'h7', firstName: '' } 
	],
	addressList: {
		address: { uid: '2006', city: 'Cali', country: 'Colombia' }
	},
	dateOfBirthList: {
		dateOfBirthItem: [
			{ uid: '1031', dateOfBirth: '24 Aug 1951', mainEntry: 'true' },
			{ uid: '1032', dateOfBirth: '05 Jul 1951', mainEntry: 'false' }
		]
	}
}];

describe('OFAC', () => {
	describe('Archive', () => {
		var zip = 'sdn_xml.zip', fn = 'sdn.xml';
		before(() => {
			if (fs.existsSync(fn)) fs.unlinkSync(fn);
		})
		it('Extraction', async () => {
			assert.ok(fs.existsSync(zip), 'Archive does not exist');
			assert.ok(!fs.existsSync(fn), 'Extract exists');

			var actual = await ofac.zipExtract(zip);
			assert.equal(actual, fn, 'Extracted a different file');
			assert.ok(fs.existsSync(fn), 'Extract file does not exist');
		});
	});
	describe('search', () => {
		before(() => {
			ofac.init();
		})
		it('Searched by id/country', async () => {
			var cust = {id: 'J287011', country: 'Colombia'};
			var actual = await ofac.search(cust, fn);
			assert.deepEqual(actual, expected);
		});
		it('Searched by first/last', async () => {
			var cust = {firstName: 'Helmer', lastName: 'Herrera-Buitrago'};
			var actual = await ofac.search(cust, fn);
			assert.deepEqual(actual, expected, 'Name search differs');
		});
		it('Checked aliases', async () => {
			var cust = {firstName: 'Helmer', lastName: 'pacho'};
			var actual = await ofac.search(cust, fn);
			assert.deepEqual(actual, expected, 'Name search differs');
		});
		it('Bad XML produces exception', (done) => {
			var cust = {id: 'J287011', country: 'Colombia'};
			assert.rejects(
				() => ofac.search(cust, 't/bad.xml').finally(done), 
				{message: 'Unhandled error. ([object Object])'}
			);
		});
		it('No match found', async () => {
			var cust = {firstName: 'XX', lastName: 'XX'};
			var actual = await ofac.search(cust, fn);
			assert.deepEqual(actual, [], 'Empty array expected');
		});
	});
});
