// The passwords page has moved (R9): passwords.html loads this plain script
// (not a module, nothing else) to go to the ED tools passwords page at once.
// The address is PASSWORDS_PAGE in config.js; tests/versions.test.mjs keeps
// the two equal. The page's meta refresh and its link work without it.
location.replace("https://michaelgarronhospital-ed.github.io/passwords.html");
