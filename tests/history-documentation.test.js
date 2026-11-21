import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import buildAssetsModule from "../scripts/build-assets.js";

const readme = readFileSync("README.md", "utf8");
const normalizedReadme = readme.replace(/\s+/g, " ");

describe("saved command history documentation", () => {
  it("documents retention, recall, locality, fallback, and approved choices", () => {
    const expectedClauses = [
      "## Saved command history",
      "saves submitted commands in this browser across visits",
      "**ArrowUp** to recall",
      "run `history` to list",
      "latest 200",
      "including duplicate, failed, and invalid commands",
      "never synchronizes to another browser or device",
      "browser storage is unavailable or full",
      "in memory for the current visit",
      "`clear`, `zsh`, and `upgrade`",
      "do not delete the saved archive",
      "Remove this site's browser data",
      "Simultaneous tabs merge successfully saved commands",
      "independent live recall list",
      "does not change the existing per-command analytics",
    ];

    for (const clause of expectedClauses) {
      expect(normalizedReadme).toContain(clause);
    }
  });

  it("ships the documented README as a deployed static asset", () => {
    expect(buildAssetsModule.staticAssets).toContain("README.md");
  });
});
