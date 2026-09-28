import { describe, expect, it } from "vitest";
import publicCommandModule from "../config/public-commands.js";
import buildAssetsModule from "../scripts/build-assets.js";

const {
  createPublicCommandCatalog,
  publicCommands,
  searchPublicCommands,
} = publicCommandModule;

describe("public command catalog", () => {
  it("derives only leading command markers and ignores headings and pipelines", () => {
    const catalog = createPublicCommandCatalog({
      HEADING: "not a command",
      "  COMMAND | %grep% pattern": "pipeline example",
      "prefix %hidden%": "not a leading marker",
      "%version% [--json]": "show the version",
      "%whois% root": "learn about us",
    });

    expect(catalog.map((command) => command.name)).toEqual(["version", "whois"]);
    expect(catalog.some((command) => command.name.includes("--json"))).toBe(false);
    expect(catalog.some((command) => command.name === "grep")).toBe(false);
  });

  it("deduplicates usage rows while retaining distinct marker-free descriptions", () => {
    const catalog = createPublicCommandCatalog({
      "%whois%": "list %all% partners",
      "%whois% [partner]": "learn about a %partner%",
      "%whois% root": "learn about us",
      "%whois% duplicate": "learn about us",
    });

    expect(catalog).toEqual([
      {
        name: "whois",
        description: "list all partners; learn about a partner; learn about us",
      },
    ]);
    expect(catalog[0].description).not.toContain("%");
  });

  it("keeps the production catalog unique and alphabetically ordered", () => {
    const names = publicCommands.map((command) => command.name);
    expect(names).toEqual([...new Set(names)].sort());
    expect(names).toContain("version");
    expect(names).toContain("whois");
    expect(names).not.toContain("PIPELINES");
    expect(names).not.toContain("grep");
  });
});

describe("public command search", () => {
  it("returns all commands for an empty or whitespace-only query", () => {
    expect(searchPublicCommands("")).toEqual(publicCommands);
    expect(searchPublicCommands("  \n\t ")).toEqual(publicCommands);
  });

  it("trims and matches names case-insensitively", () => {
    expect(searchPublicCommands("  VeRsIoN ").map((command) => command.name)).toEqual([
      "upgrade",
      "version",
      "www",
    ]);
  });

  it("matches plain-text descriptions case-insensitively", () => {
    expect(searchPublicCommands("PHYSICAL ADDRESS").map((command) => command.name)).toEqual([
      "locate",
    ]);
  });

  it("treats regex-like text literally and returns no unknown matches", () => {
    expect(searchPublicCommands("[unknown]*")).toEqual([]);
    expect(searchPublicCommands("definitely-not-a-command")).toEqual([]);
  });
});

describe("production bundle order", () => {
  it("loads the derived catalog immediately after its help source", () => {
    const helpIndex = buildAssetsModule.appBundleSources.indexOf("config/help.js");
    const catalogIndex = buildAssetsModule.appBundleSources.indexOf(
      "config/public-commands.js"
    );

    expect(helpIndex).toBeGreaterThanOrEqual(0);
    expect(catalogIndex).toBe(helpIndex + 1);
    expect(buildAssetsModule.staticAssets).not.toContain("config/public-commands.js");
  });
});