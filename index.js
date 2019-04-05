const fs = require('fs');
const readline = require('readline');
const fetch = require('node-fetch');
const Zip = require('node-stream-zip');
const xml2js = require('xml2js');

var self = module.exports = {
    url: 'https://www.treasury.gov/ofac/downloads/sdn_xml.zip',
    opts: {
        force: false,
        path: '/tmp',
        xml: 'sdn.xml',
        fetch
    },
    config: (opts) => {
        self.opts = Object.assign(self.opts, opts);
    },
    init: (opts = self.opts) => {
        self.config(opts);  

        return self.fetch()
            .then(zip => self.zipExtract(zip))
            .then(xml => self.db = xml);
    },
    fn: (url) => {
        if (!url) url = self.opts.xml;
        return self.opts.path + '/' + url.replace(/.*\//, '');
    },
    fetch: (url = self.url) => {
        var fn = self.fn(url);

        return (fs.existsSync(fn) && !self.opts.force)
            ? Promise.resolve(fn)
            : self.opts.fetch(url).then(res => new Promise((resolve, reject) => {
                const dest = fs.createWriteStream(fn);
                res.body.pipe(dest, {end: true});
                res.body.on('close', () => resolve(fn));
                dest.on('error', reject);
            }));
    },
    zipExtract: (zip, fn = self.opts.xml, dest = self.opts.path) => {
        var xml = dest + '/' + fn;
        if (fs.existsSync(xml) && !self.opts.force)
            return xml;

        var z = new Zip({file: zip});
        return new Promise((resolve, reject) => {
            z.on('error', (err) => {
                reject({zip, xml, src: 'on', err});
            });
            z.on('ready', () => {
                z.extract(fn, dest, err => {
                    if (err) reject({zip, xml, src: 'ready', err});
                    else {
                        resolve(xml);
                        z.close();
                    }
                })
            });
        });
    },
    dbinfo: async () => {
        var ret = {};
        if (!self.db) await self.init();
        return new Promise((resolve, reject) => {
            var ln = readline.createInterface({
                input: fs.createReadStream(self.db)
            });
            ln.on('line', function (line) {
                var m = line.match(/(Publish_Date|Record_Count)/);
                if (m) ret[m[1].replace('_', ' ')] = line.replace(/<.*?>/g, '').trim();
                if (ret['Record Count']) {
                    ln.close();
                    resolve(ret);
                }
            });
        });
    },
    search: async (cust, fn = self.db) => {
        if (!fn) fn = await self.init();
        if (!cust.search_type) cust.search_type = 'individual';
        
        // clean input data
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
                if (err) throw new Error(err);

                // look only for profiles of the given type
                if (res.sdnEntry.sdnType.toLowerCase() != cust.search_type)
                    return;

                // fix XML transform
                res = x(res);

                // add anything found to return array
                if (cmp(cust, res)) ret.push(res);
            });
            xml = '';
        }

        function lc(o) {
            var t = typeof o;
            if (t == 'undefined') return '';
            if (t == 'string') return o.toLowerCase();
            if (Array.isArray(o) || t != 'object') return o;

            Object.keys(o).forEach(k => {
                if (typeof o[k] == 'string') o[k] = o[k].toLowerCase();
            });
            for (var k of 'firstName/lastName'.split('/'))
                if (o[k]) o[k] = (o[k] || '').replace(/\W/g, ' ');

            return o;
        }

        function x(o) {
            o = o.sdnEntry;
            for (var k in o) {
                if (!k.match(/List$/)) continue;
                if (!o[k]) { o[k] = []; continue; }
                let kk = Object.keys(o[k])[0];
                o[k] = (o[k] || {})[kk] || [];
                if (!Array.isArray(o[k])) o[k] = [o[k]];
            }
            return o;
        }

        function cmp(cust, res) {
            // seek a match on id/country

            if (!res.idList) res.idList = [];
            var ok = res.idList.filter(o => {
                let ok = lc(o.idNumber) == cust.id;
                if (o.idCountry && cust.country)
                    ok = ok && lc(o.idCountry) == cust.country;
                if (o.idType && cust.id_type)
                    ok = ok && lc(o.idType) == cust.id_type;
                return ok;
            });
            if (ok.length > 0) return true;

            // if not match emerges, try by name

            ok = cust.firstName || cust.lastName;
            if (res.firstName && cust.firstName)
                ok = ok && lc(res.firstName) == cust.firstName;
            if (res.lastName && cust.lastName)
                ok = ok && lc(res.lastName) == cust.lastName;
            if (ok) return true;
            
            // failing that we try AKAs

            if (!res.akaList) res.akaList = [];
            for (var i = 0; i < res.akaList.length; i++) {
                let o = res.akaList[i];
                let ok = lc(o.firstName || res.firstName || '') == cust.firstName;
                ok = ok && lc(o.lastName || res.lastName || '') == cust.lastName;
                if (ok) return true;
            }
        }
    }
};
