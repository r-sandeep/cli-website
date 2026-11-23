import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const readme = readFileSync("README.md", "utf8");
const require = createRequire(import.meta.url);
const helpSource = readFileSync("config/help.js", "utf8");
const fixtureBuilder = readFileSync("tests/helpers/build-history-fixture.cjs", "utf8");
const fixtureDriver = readFileSync("tests/helpers/history-browser-fixture.js", "utf8");
const helpContext = vm.createContext({});
vm.runInContext(`${helpSource}\nthis.helpEntries = help; this.shortcutEntries = shortcuts;`, helpContext);

function savedHistorySection() {
  const match = readme.match(/## Saved command history\n([\s\S]*?)\n## /);
  expect(match).not.toBeNull();
  return match[1];
}

describe("saved history documentation", () => {
  it("documents locality, recall, retention, numbering, fallback, and submitted text in help and README", () => {
    const section = savedHistorySection();

    expect(helpContext.helpEntries["%history%"]).toBe(
      "saved in this browser; newest 200; ArrowUp recalls"
    );
    expect(helpContext.shortcutEntries.ArrowUp).toBe(
      "recall commands saved in this browser"
    );
    expect(Object.values(helpContext.helpEntries).join("\n")).toContain(
      "original submitted text and duplicates are saved; history numbers entries from 1000"
    );
    expect(Object.values(helpContext.helpEntries).join("\n")).toContain(
      "keep visit-only memory history"
    );

    expect(section).toContain("saved in this browser");
    expect(section).toContain("original\ntext");
    expect(section).toContain("including duplicates");
    expect(section).toContain("**ArrowUp** recalls saved commands");
    expect(section).toContain("`history`\nlists them in submission order");
    expect(section).toContain("numbering from 1000");
    expect(section).toContain("newest 200 entries remain");
    expect(section).toContain("History never leaves the browser");
    expect(section).toContain("private mode that blocks storage");
    expect(section).toContain("quota is full");
    expect(section).toContain("visit-only in-memory history");
  });

  it("documents settled failures, independent tabs, and visit-only reset semantics without stale alternatives", () => {
    const section = savedHistorySection();
    const helpText = Object.entries(helpContext.helpEntries)
      .flat()
      .join("\n");

    expect(helpText).toContain("Unsuccessful submissions");
    expect(helpText).toContain("saved for the next visit");
    expect(helpText).toContain("Open tabs");
    expect(helpText).toContain(
      "keep independent recall; saved submissions combine for later visits"
    );
    expect(helpText).toContain("%clear%, %zsh%, %upgrade%");
    expect(helpText).toContain(
      "clear current recall and replay only; their submitted lines stay saved"
    );

    expect(section).toContain("unsuccessful submissions");
    expect(section).toContain("Each open tab keeps independent recall");
    expect(section).toContain("saved\nsubmissions are combined for later visits");
    expect(section).toContain("`clear`, `zsh`, and `upgrade`");
    expect(section).toContain("clear only the current tab's recall and resize replay");
    expect(section).toContain("do not\ndelete saved history");
    expect(section).toContain("own submitted lines remain saved\nfor the next visit");
    expect(section).not.toMatch(/unsuccessful submissions (?:are not|might not|may not) (?:be )?saved/i);
    expect(section).not.toMatch(/clear.*(?:erase|delete).*saved history/i);
  });

  it("keeps managed fixture assets isolated from the production build", () => {
    expect(fixtureBuilder).toContain('path.join(dist, "__asd_history")');
    expect(fixtureBuilder).toContain('path.join(dist, "__asd_history.html")');
    expect(fixtureDriver).toContain("run-store");
    expect(fixtureDriver).toContain("run-terminal");

    const buildAssets = require("../scripts/build-assets.js");
    expect(buildAssets.appBundleSources).not.toContain(
      "tests/helpers/history-browser-fixture.js"
    );
    expect(buildAssets.staticAssets).not.toContain(
      "tests/helpers/history-browser-fixture.js"
    );
    expect(buildAssets.staticAssets).not.toContain(
      "tests/helpers/build-history-fixture.cjs"
    );
  });
});
