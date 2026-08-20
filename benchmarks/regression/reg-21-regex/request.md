The email regex in src/email.js matches emails without a domain. Fix it so `isEmail('a@b.com')` is true and `isEmail('nope')` is false.
