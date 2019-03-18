const fs = require('fs');
const readline = require('readline');
const fetch = require('node-fetch');
const zip = require('node-stream-zip');
const xml2js = require('xml2js');

function urlfn(url) {
    return './' + url.replace(/.*\//, '');
}

var self = module.exports = {
    FORCE: true,
    url: 'https://www.treasury.gov/ofac/downloads/sdn_xml.zip',
    init: async (force = false) => {
        // if database already fetched, don't fetch again

        var fn = urlfn(self.url);
        if (!fs.existsSync(fn) || force)
            await self.fetch();

        if (!fs.existsSync(self.db) || force)
            self.db = await self.zipExtract(fn);

        return self;
    },
    fetch: (url = self.url) => {
        return fetch(url).then(res => {
            var fn = urlfn(url);
            const dest = fs.createWriteStream(fn);
            res.body.pipe(dest);
            return fn;
        });
    },
    zipExtract: (fn, path = './') => {
        var z = new zip({file: fn});
        return new Promise((resolve, reject) => {
            var xfn = 'sdn.xml';
            z.on('error', reject);
            z.on('ready', () => {
                z.extract(xfn, path, err => {
                    if (err) reject(err);
                    resolve(xfn);
                    z.close();
                })
            });
        });
    },
    search: (cust, fn = self.db) => {
        // input data clean
        
        cust = lc(cust);

        // read database file line by line

        var lineReader = readline.createInterface({
            input: fs.createReadStream(fn)
        });

        var xml = '', ret = [], collect = false;
        
        return new Promise((resolve, reject) => {
            lineReader.on('line', line => {
                try { collector(line) }
                catch(e) { reject(e) }
            })
            .on('error', reject)
            .on('close', () => resolve(ret));
        });

        function collector(line) {
            if (line.match(/<sdnEntry>/)) collect = true;
            if (collect) xml += line;
            if (!line.match(/<\/sdnEntry>/)) return;

            collect = false;
            xml2js.parseString(xml, {explicitArray: false}, (err, res) => {
                // if (err) throw new Error(err);
                if (err) throw {message: 'TEST'};
        
                // look only an individual profiles
                if (res.sdnEntry.sdnType != 'Individual') return;

                // fix XML transform
                res = x(res);

                // add anything found to return array
                if (cmp(cust, res)) ret.push(res);
            });
            xml = '';
        }
        function lc(o) {
            for (var k in o) if (o.hasOwnProperty(k) && typeof o[k] == 'string')
                o[k] = o[k].toLowerCase();
            for (var k of 'firstName|lastName'.split('|'))
                o[k] = (o[k] || '').replace(/\W/g, ' ');
            return o;
        }

        function x(o) {
            o = o.sdnEntry;
            if (o.idList) {
                o.idList = o.idList.id;
                if (!Array.isArray(o.idList)) o.idList = [o.idList];
                for (var i = 0; i < o.idList.length; i++)
                    lc(o.idList[i]);
            } else o.idList = [];

            if (o.akaList) {
                o.akaList = o.akaList.aka;
                if (!Array.isArray(o.akaList)) o.akaList = [o.akaList];
                for (var i = 0; i < o.akaList.length; i++)
                    lc(o.akaList[i]);
            } else o.akaList = [];

            return lc(o);
        }

        function cmp(cust, res) {
            // seek a match on id/country

            for (var i = 0; i < res.idList.length; i++) {
                let ok = res.idList[i].idNumber == cust.id;
                ok = ok && res.idList[i].idCountry == cust.country;
                if (ok) return true;
            }

            // if not match emerges, try by name

            let ok = res.firstName == cust.firstName;
            ok = ok && res.lastName == cust.lastName;
            if (ok) return true;
            
            // failing that we try AKAs

            for (var i = 0; i < res.akaList.length; i++) {
                let o = res.akaList[i];
                let ok = (o.firstName || res.firstName || '') == cust.firstName;
                ok = ok && (o.lastName || res.lastName || '') == cust.lastName;
                if (ok) return true;
            }
        }
    }
};