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
        fetch: (url, opts) => fetch(url, opts)
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
            : self.opts.fetch(url).then(res => {
                const dest = fs.createWriteStream(fn);
                res.body.pipe(dest);
                return fn;
            });
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

            var ok = res.idList.filter(o => {
                let ok = o.idNumber == cust.id;
                if (o.idCountry && cust.country)
                    ok = ok && o.idCountry == cust.country;
                if (o.idType && cust.id_type)
                    ok = ok && o.idType == cust.id_type;
                return ok;
            });
            if (ok.length > 0) return true;

            // if not match emerges, try by name

            ok = cust.firstName || cust.lastName;
            if (res.firstName && cust.firstName)
                ok = ok && res.firstName == cust.firstName;
            if (res.lastName && cust.lastName)
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