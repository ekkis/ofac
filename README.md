# OFAC 

A division of the US Treasury Department, the Office of Foreign Asset Control (OFAC) maintains
information related to KYC programs, particularly lists of individuals and other entities under
sanctions

This module allows for local queries against the Specially Designated Nationals and Blocked 
Persons list (SDN), which can normally be queried via the web at:

    [https://sanctionssearch.ofac.treas.gov](https://sanctionssearch.ofac.treas.gov)

Fortunately, OFAC makes the data available for download in XML format such that queries
can become programmable

## Installation

The usual way:
```
npm install --save ofac
```

## API

In the CommonJs paradigm, we require the module and subsequently initialise it:
```
const ofaq = require('ofac');
ofaq.init().then(...);
```
### init(force)
* force (boolean) - indicates that a fresh fetch of the database should be made

The module downloads, and unpacks the OFAC database unto the local directory and performs
this only once, unless forced to do so again.  The file is downloaded in Zip format and is
thus light on demand for bandwidth

The method returns a NodeJs native promise wrapped around the module itself to allow chaining
### search(cust, [filename])
* cust - an object consisting of properties to look for in the database
* filename - an optional filename allowing the caller to run searches against a file other
than the default.  Useful for testing

The customer object may contain the following properties, passed in pairs:
```
{
    id, country,            // and/or
    firstName, lastName
}
```
where `id` represents a passport number or other national identification number.  

The search algorithm gives priority to the id/country as it is more authoritative (and 
both are required since the same id may exist in different countries) but failing to find 
it match it opts for first name and last name.  These values are matched against the canonical 
name of the individual but are also match against a possible list of aliases.  Searches are
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
### zipInfo(filename, [property])
* filename - specifies the name of the file to read
* property - optionally passed, retrieves only a property of the meta-data

This method returns meta-data on a Zip archive as produced by the `unzip` module.  When 
the second parameter is specified, it names the property of the object to return instead

The method returns a promise
### unzip(filename, [path])
* filename - the name of the file to unpack
* path - the location to which the archive should be unpacked

This method unpacks an archive.  If the path is left unspecified, the unpacks to the
current directory

## Notes

Since the data set tends to be largish, rather than converting the XML into a DOM for in-memory
searches, the module searches the file.  This takes a little longer (though it's actually pretty 
fast) but it's super-light on RAM

Also, at present searching is limited to first-name/last-name and id/country, and operates only on
Individual data (skips corporations, vessels and other types of entities) but the database contains
richer information.  Anyone that wishes to match against other properties is welcome to write it,
pull requests are most welcome

## Testing

You can run the usual:
```
npm test
```
The tests are run in Mocha with plain-vanilla asserts.  Deeper testing would be recommended but
will leave to others
