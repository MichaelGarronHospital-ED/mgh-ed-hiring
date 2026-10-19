// ============================================================================
//  R9: the ED tools passwords page has moved to the ED dashboard (the gear on
//  the ED tools front page, PASSWORDS_PAGE in config.js). This stub stays for
//  older passwords.html pages still in a browser's cache, which load this
//  module: it sends them to the new page. Today's passwords.html is a plain
//  redirect and does not load it. The rules of the old change (js/passwords.js)
//  were deleted in R10.
// ============================================================================
import { PASSWORDS_PAGE } from "./config.js?v=R15";

location.replace(PASSWORDS_PAGE);
