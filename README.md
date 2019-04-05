 [![npm version](https://badge.fury.io/js/ofac.svg)](https://badge.fury.io/js/ofac)

# OFAC 

A division of the US Treasury Department, the Office of Foreign Asset Control (OFAC) maintains
information related to KYC programs, particularly lists of individuals and other entities under
sanctions

This module allows for local queries against the Specially Designated Nationals and Blocked 
Persons list (SDN), which can normally be queried via the web at: https://sanctionssearch.ofac.treas.gov

Fortunately, OFAC makes the data available for download in XML format such that queries
can become programmable

## Install

Fetch from from the repository
```javascript
npm install --save ofac
```
And set up a usable instance like this:
```javascript
// using ES6 modules
import ofac from 'ofac';

// using CommonJS modules
const ofac = require('ofac');
```

## API

The module can be initialised first or just used directly:
```javascript
// example of initialisation
ofac.init({xml: 'sdn2.xml'}).then(() => ofac.search(...)));

// direct use
ofac.search(...).then(...);
```
### init(opts)

* force (boolean) - indicates that a fresh fetch of the database should be made
* path - the path where the downloaded archive and extracted database should be stored (default: `/tmp`) 
* xml - the name of the file name expected within the archive (default: `sdn.xml`)

The module downloads, and unpacks the OFAC database unto the local directory and performs
this only once, unless forced to do so again.  The file is downloaded in Zip format and is
thus light on demand for bandwidth

The method returns a NodeJs native promise wrapped around the module itself to allow chaining

### search(cust, [filename])

* cust - an object consisting of properties to look for in the database
* filename - an optional filename allowing the caller to run searches against a file other
than the default.  Useful for testing

The customer object may contain the following properties, passed in pairs:
```javascript
{
    search_type: 'Individual',
    id, id_type, country,            // and/or
    firstName, lastName
}
```
where:
* `search_type` defines the database domain within which to search.  If left unspecified
the module defaults to searches of individuals
* `id` represents a passport number or other national identification number
* `id_type` specifies the type of document to search for e.g. passport, national
ID card, etc.  If left unspecified all document types are searched.  For more information
on the types supported, please refer to the OFAC website.

The search algorithm gives priority to the id/country as this information is more authoritative
(and both are required since the same id may exist in different countries) but failing to find 
a match it opts for first name and last name.  These values are matched against the canonical 
name of the individual but are also matched against a possible list of aliases.  Searches are
performed against sanitised data, thus "Stella-Marie" will match "Stella Marie", "STELLA MARIE"
"stella marie", "stella/marie", and other variants

The method returns a promise wrapped around an array of matches.  The entire database record
is returned

## Internal methods

The module also exposes methods mostly used internaly as follows:

### fetch([url])
* url - the location of the file to fetch

This method fetches a file and writes it to the local directory with the same name as that
specified in the url.  This means that urls with parameters e.g. `?param=arg&param=arg` will
prove problematic

If the url is left unspecified, the canonical location of the SDN is used

The method returns the file name used, wrapped in a promise

### zipExtract(archive, filename, [path])
* archive - the name of the archive from which to extract
* filename - the name of the file to extract
* path - the location to which the archive should be unpacked

This method unpacks an archive.  If the path is left unspecified, the unpacks to the
current directory

## Notes

* Since the data set tends to be largish, rather than converting the XML into a DOM for in-memory
searches, the module searches the file.  This takes a little longer (though it's actually pretty 
fast) but it's super-light on RAM

* Also, at present searching is limited to first-name/last-name and id/country, and operates only on
Individual data (skips corporations, vessels and other types of entities) but the database contains
richer information.  Anyone that wishes to match against other properties is welcome to write it,
pull requests are most welcome

* The data currently retrieved is contained in the `SDN_XML.zip` listed on this page:
https://www.treasury.gov/resource-center/sanctions/SDN-List/Pages/sdn_data.aspx

## Testing

You can run the usual:
```
npm test
```
The tests are run in Mocha with plain-vanilla asserts.  Deeper testing would be recommended but
will leave to others

## Examples

For more extensive examples please see the test suite
```javascript
const ofac = require('ofac');

var cust = {id: 'J287011', country: 'Colombia'};
ofac.search(cust).then(console.log);
```
will produce something like:
```json
[{
    "uid": "4106",
    "firstName": "helmer",
    "lastName": "herrera buitrago",
    "sdnType": "individual",
    "programList": { "program": "SDNT" },
    "idList": [
        { "uid": "1011", "idType": "passport", "idNumber": "j287011", "idCountry": "colombia", "firstName": "", "lastName": "" },
        { "uid": "1010", "idType": "cedula no.", "idNumber": "16247821", "idCountry": "colombia", "firstName": "", "lastName": "" } 
    ],  
    "akaList": [
        { "uid": "7776", "type": "a.k.a.", "category": "weak", "lastName": "pacho", "firstName": "" },
        { "uid": "7777", "type": "a.k.a.", "category": "weak", "lastName": "h7", "firstName": "" } 
    ],  
    "addressList": {
        "address": { "uid": "2006", "city": "Cali", "country": "Colombia" }
    },  
    "dateOfBirthList": {
        "dateOfBirthItem": [
            { "uid": "1031", "dateOfBirth": "24 Aug 1951", "mainEntry": "true" },
            { "uid": "1032", "dateOfBirth": "05 Jul 1951", "mainEntry": "false" }
        ]   
    }   
}]
```

## NPM-as-a-service on the Now platform

The functionality in this module is also available via a REST API where methods 
may be called by passing parameters to the service's url.  The parameter "method" is
used to indicate which method to call, and additional parameters should match the
signature of the method, for example:
```bash
curl "https://ofac.npm.now.sh/server.js?method=search&cust={id: 'J287011', country: 'Colombia'}"
```
returns a JSON object with the method's return value

In Javascript you may use your fevourite package for fetching instead:
```js
const fetch = require('node-fetch')
const url = 'https://ofac.npm.now.sh/server.js?method=search&cust={id: 'J287011', country: 'Colombia'}'
fetch(url).then(res => res.json())
    .then(o => {
        console.log(o)  // will show the result
    })
```

## Licence
MIT

## Support

For support post an issue on Github or reach out to me on Telegram.
My username is [@ekkis](https://t.me/ekkis)
