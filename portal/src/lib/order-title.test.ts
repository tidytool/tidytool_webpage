/** Run: npm run test:labels (bundled with the labels suite) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderTitle, sharedPrefixWords, stripPrefixWords } from "./order-title";

const OWTC = [
  "Mechanical Trainer - Frontier - Hand Tools",
  "Mechanical Trainer - Frontier - Chains",
  "Mechanical Trainer Frontier - Large Drawer", // missing dash — must not break grouping
];

test("word-level prefix survives inconsistent punctuation", () => {
  assert.equal(sharedPrefixWords(OWTC), 3);
  assert.deepEqual(orderTitle({ drawerNames: OWTC }), { title: "Mechanical Trainer - Frontier", prefixWords: 3 });
  assert.equal(stripPrefixWords(OWTC[0], 3), "Hand Tools");
  assert.equal(stripPrefixWords(OWTC[2], 3), "Large Drawer");
});

test("never consumes a whole name; no prefix → full names", () => {
  assert.equal(sharedPrefixWords(["Top Drawer", "Top Drawer"]), 1);
  assert.equal(sharedPrefixWords(["Spacers", "Top Drawer"]), 0);
  assert.equal(stripPrefixWords("Spacers", 0), "Spacers");
  assert.equal(orderTitle({ drawerNames: ["Spacers", "Top Drawer"], received: "Aug 12" }).title, "Order — received Aug 12");
});

test("project name wins; single drawer has no prefix", () => {
  assert.equal(orderTitle({ projectName: "Husky", drawerNames: OWTC }).title, "Husky");
  assert.equal(sharedPrefixWords(["Only Drawer"]), 0);
});
