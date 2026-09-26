// ============================================================================
//  Class-name collisions between a block and a global utility.
//
//  This repo has now been bitten twice by the same shape, both times silently:
//
//    .tip      the instant tooltip was briefly called `.tip`, which gave every
//              `.note.tip` guidance box position:absolute; opacity:0 — the
//              instructions on every tab rendered nothing.
//    .info     renderBanner set the deadline bar's className to "banner info",
//              and `.info` is the 16px round badge (display:inline-flex;
//              width:16px; height:16px). The bar collapsed to a circle with its
//              text hanging off the left edge over the header.
//
//  The second one needed NO code change to appear: the modifier is only added
//  once the deadline is in the past, so it broke by itself the morning after
//  the deadline and looked like a mystery.
//
//  No browser needed: read what app.js applies, read what styles.css defines,
//  and assert they cannot overlap.
// ============================================================================
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../js/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../css/styles.css", import.meta.url), "utf8");

// Strip comments so commentary about a class never counts as a rule.
const cssLive = css.replace(/\/\*[\s\S]*?\*\//g, "");

// Does `.name` exist as a selector in its own right (not only compounded with
// another class, like `.banner.past`)?
function standaloneRule(name) {
  const re = new RegExp(String.raw`(^|[,{}\s])\.${name}(?![\w-])(?![^,{]*\.)`, "m");
  return re.test(cssLive);
}

// Modifiers renderBanner appends: `cls += " past"`.
const bannerModifiers = [...app.matchAll(/cls\s*\+=\s*["'] ([\w-]+)["']/g)].map((m) => m[1]);

describe("the deadline banner's modifiers cannot be hijacked", () => {
  test("app.js really does apply modifiers this way (the scrape still works)", () => {
    assert.ok(bannerModifiers.length >= 2,
      `expected to find banner modifiers in app.js, found ${JSON.stringify(bannerModifiers)}`);
  });

  test("no banner modifier is also a standalone utility class", () => {
    for (const m of bannerModifiers) {
      assert.equal(standaloneRule(m), false,
        `"${m}" is both a banner modifier and a global .${m} rule. renderBanner sets the ` +
        `banner's WHOLE className, so the utility's display/width/etc. reshape the bar. ` +
        `Rename the modifier (this is exactly how "info" collapsed the bar into a 16px badge).`);
    }
  });

  test("the guard itself is real — `info` would still be caught", () => {
    // If .info ever stops being a standalone rule this test is worthless, so
    // prove the detector fires on the class that actually caused the bug.
    assert.equal(standaloneRule("info"), true, "expected .info to still be a standalone badge rule");
  });

  test("`.banner` pins its own box so a future collision can't reshape it", () => {
    const rule = cssLive.match(/\.banner\s*\{([^}]*)\}/);
    assert.ok(rule, "no .banner rule found");
    for (const prop of ["display", "width", "height"]) {
      assert.match(rule[1], new RegExp(`\\b${prop}\\s*:`),
        `.banner should set an explicit ${prop} — it is the last line of defence if a ` +
        `modifier class ever collides again`);
    }
  });
});

describe("the tooltip is still not called .tip", () => {
  test("app.js builds the tooltip with class `tooltip`", () => {
    assert.match(app, /className\s*=\s*"tooltip"/);
    assert.equal(/className\s*=\s*"tip"/.test(app), false);
  });
  test(".note.tip is still a compound selector, never bare .tip", () => {
    assert.equal(standaloneRule("tip"), false, ".tip must not exist on its own — see the note in styles.css");
  });
});

describe("mobile field sizing survives", () => {
  // iOS zooms the page when a focused field is under 16px. body drops to
  // 15.5px on a phone and every control is font:inherit, so without this the
  // access-code box zooms the layout out from under whoever is typing.
  test("a phone-width rule lifts form controls back to 16px", () => {
    const m = cssLive.match(/@media\s*\(max-width:\s*640px\)\s*\{[\s\S]*?font-size:\s*16px/);
    assert.ok(m, "no max-width:640px rule setting form controls to 16px");
  });
  test("it is the LAST rule for those selectors, or it loses on order", () => {
    const i = cssLive.search(/input,\s*select,\s*textarea,[\s\S]{0,200}font-size:\s*16px/);
    assert.ok(i > 0, "could not find the mobile field-sizing block");
    const after = cssLive.slice(i);
    assert.equal(/\.overlay-box input[^{]*\{[^}]*font:\s*inherit/.test(after), false,
      "a later rule re-applies font:inherit to .overlay-box input and undoes the 16px fix");
    assert.equal(/\.tform input[^{]*\{[^}]*font:\s*inherit/.test(after), false,
      "a later rule re-applies font:inherit to .tform input and undoes the 16px fix");
  });
});
