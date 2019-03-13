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


describe('Main', () => {
	before(() => {
		ofac.init();
	})
	it('id/country', async () => {
		var cust = {id: 'J287011', country: 'Colombia'};
		var actual = await ofac.search(cust, fn);
		assert.deepEqual(actual, expected);
	});
    it('first/last', async () => {
		var cust = {firstName: 'Helmer', lastName: 'Herrera-Buitrago'};
		var actual = await ofac.search(cust, fn);
		assert.deepEqual(actual, expected, 'Name search differs');
    });
    it('aliases', async () => {
		var cust = {firstName: 'Helmer', lastName: 'pacho'};
		var actual = await ofac.search(cust, fn);
		assert.deepEqual(actual, expected, 'Name search differs');
	});
/*
	it('throws error', () => {
		function throws() { 
			throw new Error('TEST');
			return new Promise((resolve, reject) => {
				reject()
			});
		}
		assert.throws(throws, {message: 'TEST'});
	});
*/
    it('bad XML', (done) => {
		var cust = {id: 'J287011', country: 'Colombia'};
		assert.rejects(() => ofac.search(cust, 't/bad.xml'), {message: 'TEST'});
	});
});

