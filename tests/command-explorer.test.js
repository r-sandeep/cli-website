import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv, REPO_ROOT } from "./helpers/browser-env";

let env;

function loadExplorer(commands = []) {
  const html = fs.readFileSync(`${REPO_ROOT}/index.html`, "utf8");
  const searchPublicCommands = vi.fn((query) => {
    const needle = String(query).trim().toLowerCase();
    return commands.filter(
      (command) =>
        !needle ||
        command.name.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle)
    );
  });

  env = createBrowserEnv({ html, globals: { searchPublicCommands } });
  env.loadScripts(["js/command-explorer.js"]);
  env.window.initializeCommandExplorer();

  return { searchPublicCommands };
}

function loadConnectedExplorer(commands, terminal) {
  const html = fs.readFileSync(`${REPO_ROOT}/index.html`, "utf8");
  const searchPublicCommands = vi.fn((query) => {
    const needle = String(query).trim().toLowerCase();
    return commands.filter(
      (command) =>
        !needle ||
        command.name.toLowerCase().includes(needle) ||
        command.description.toLowerCase().includes(needle)
    );
  });

  env = createBrowserEnv({ html, globals: { searchPublicCommands } });
  env.loadScripts(["js/command-explorer.js"]);
  env.window.initializeCommandExplorer(terminal);

  return { searchPublicCommands };
}

function click(element) {
  element.dispatchEvent(new env.window.MouseEvent("click", { bubbles: true }));
}

function input(element) {
  element.dispatchEvent(new env.window.Event("input", { bubbles: true }));
}

afterEach(() => {
  if (env) env.cleanup();
  env = null;
});

describe("command explorer", () => {
  const commands = [
    { name: "help", description: "list <all> & commands" },
    { name: "version", description: "show the terminal version" },
  ];

  it("starts hidden with labelled native controls outside the terminal", () => {
    loadExplorer(commands);
    const document = env.document;
    const panel = document.getElementById("command-explorer-panel");
    const toggle = document.getElementById("command-explorer-toggle");

    expect(panel.hidden).toBe(true);
    expect(panel.getAttribute("role")).toBeNull();
    expect(panel.getAttribute("aria-labelledby")).toBe("command-explorer-title");
    expect(toggle).toBeInstanceOf(env.window.HTMLButtonElement);
    expect(toggle.textContent.trim()).toBe("Command explorer");
    expect(toggle.closest("#terminal")).toBeNull();
    expect(document.getElementById("command-explorer-search").labels[0].textContent).toBe(
      "Search commands"
    );
    expect(document.getElementById("command-explorer-status").getAttribute("aria-live")).toBe(
      "polite"
    );
    expect(document.getElementById("command-explorer-close")).toBeInstanceOf(
      env.window.HTMLButtonElement
    );
  });

  it("opens, renders safe native result buttons, and filters without moving focus", () => {
    const state = loadExplorer(commands);
    const document = env.document;
    const toggle = document.getElementById("command-explorer-toggle");
    const panel = document.getElementById("command-explorer-panel");
    const search = document.getElementById("command-explorer-search");

    click(toggle);

    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(search);
    expect(state.searchPublicCommands).toHaveBeenLastCalledWith("");

    const helpButton = document.querySelector('[data-command="help"]');
    expect(helpButton).toBeInstanceOf(env.window.HTMLButtonElement);
    expect(helpButton.getAttribute("aria-label")).toBe("Insert help");
    expect(helpButton.textContent).toContain("Insert help");
    expect(helpButton.textContent).toContain("list <all> & commands");
    expect(helpButton.querySelector("all")).toBeNull();
    expect(document.querySelectorAll("#command-explorer-results button")).toHaveLength(2);

    search.value = "VeRsIoN";
    input(search);

    expect(document.activeElement).toBe(search);
    expect(state.searchPublicCommands).toHaveBeenLastCalledWith("VeRsIoN");
    expect(document.querySelectorAll("#command-explorer-results button")).toHaveLength(1);
    expect(document.querySelector('[data-command="version"]')).not.toBeNull();
    expect(document.getElementById("command-explorer-status").textContent).toBe(
      "1 matching command"
    );
  });

  it("reports special and unknown queries without interpreting markup", () => {
    loadExplorer(commands);
    const document = env.document;
    const search = document.getElementById("command-explorer-search");
    click(document.getElementById("command-explorer-toggle"));

    search.value = "[unknown]*<img>";
    input(search);

    expect(document.getElementById("command-explorer-status").textContent).toBe(
      "No matching commands"
    );
    expect(document.getElementById("command-explorer-results").children).toHaveLength(0);
    expect(document.querySelector("#command-explorer-results img")).toBeNull();
    expect(document.activeElement).toBe(search);
  });

  it("restores opener focus after Close, in-panel Escape, and toggle-again", () => {
    loadExplorer(commands);
    const document = env.document;
    const toggle = document.getElementById("command-explorer-toggle");
    const panel = document.getElementById("command-explorer-panel");

    click(toggle);
    click(document.getElementById("command-explorer-close"));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);

    click(toggle);
    document.getElementById("command-explorer-search").dispatchEvent(
      new env.window.KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);

    click(toggle);
    click(toggle);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
  });

  it("does not wire result activation to terminal insertion in M3", () => {
    const setCurrentLine = vi.fn();
    env = createBrowserEnv({
      html: fs.readFileSync(`${REPO_ROOT}/index.html`, "utf8"),
      globals: {
        searchPublicCommands: () => commands,
        term: { setCurrentLine },
      },
    });
    env.loadScripts(["js/command-explorer.js"]);
    env.window.initializeCommandExplorer();
    click(env.document.getElementById("command-explorer-toggle"));

    click(env.document.querySelector('[data-command="help"]'));

    expect(setCurrentLine).not.toHaveBeenCalled();
    expect(env.document.getElementById("command-explorer-panel").hidden).toBe(false);
    expect(env.document.getElementById("command-explorer-status").textContent).toBe(
      "Finish or clear the terminal input before inserting a command"
    );
  });

  it("inserts only the exact command into an idle empty terminal and focuses xterm", () => {
    const terminal = {
      aliases: { ll: "ls -la" },
      bookmarks: { docs: "~/docs" },
      busy: false,
      currentLine: "",
      environment: { NAME: "value" },
      executeCommandLine: vi.fn(),
      focus: vi.fn(),
      history: ["version"],
      preferences: { theme: "default" },
      setCurrentLine: vi.fn((line) => {
        terminal.currentLine = line;
      }),
    };
    const unchanged = {
      aliases: structuredClone(terminal.aliases),
      bookmarks: structuredClone(terminal.bookmarks),
      environment: structuredClone(terminal.environment),
      history: [...terminal.history],
      preferences: structuredClone(terminal.preferences),
    };
    loadConnectedExplorer(commands, terminal);
    const document = env.document;

    click(document.getElementById("command-explorer-toggle"));
    click(document.querySelector('[data-command="help"]'));

    expect(terminal.setCurrentLine).toHaveBeenCalledTimes(1);
    expect(terminal.setCurrentLine).toHaveBeenCalledWith("help");
    expect(terminal.executeCommandLine).not.toHaveBeenCalled();
    expect(terminal.history).toEqual(unchanged.history);
    expect(terminal.aliases).toEqual(unchanged.aliases);
    expect(terminal.environment).toEqual(unchanged.environment);
    expect(terminal.bookmarks).toEqual(unchanged.bookmarks);
    expect(terminal.preferences).toEqual(unchanged.preferences);
    expect(document.getElementById("command-explorer-panel").hidden).toBe(true);
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("refuses pending input, preserves state, and restores toggle focus on Close", () => {
    const terminal = {
      busy: false,
      currentLine: "echo pending",
      executeCommandLine: vi.fn(),
      focus: vi.fn(),
      history: ["help"],
      output: "continuity-marker",
      setCurrentLine: vi.fn(),
    };
    loadConnectedExplorer(commands, terminal);
    const document = env.document;
    const panel = document.getElementById("command-explorer-panel");
    const toggle = document.getElementById("command-explorer-toggle");

    click(toggle);
    click(document.querySelector('[data-command="version"]'));

    expect(terminal.setCurrentLine).not.toHaveBeenCalled();
    expect(terminal.executeCommandLine).not.toHaveBeenCalled();
    expect(terminal.currentLine).toBe("echo pending");
    expect(terminal.history).toEqual(["help"]);
    expect(terminal.output).toBe("continuity-marker");
    expect(panel.hidden).toBe(false);
    expect(document.getElementById("command-explorer-status").textContent).toBe(
      "Finish or clear the terminal input before inserting a command"
    );

    click(document.getElementById("command-explorer-close"));
    expect(terminal.currentLine).toBe("echo pending");
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
    expect(terminal.focus).not.toHaveBeenCalled();
  });

  it("refuses a busy terminal without mutation and permits a later idle insertion", () => {
    const terminal = {
      busy: true,
      currentLine: "",
      executeCommandLine: vi.fn(),
      focus: vi.fn(),
      history: [],
      output: "still-here",
      setCurrentLine: vi.fn((line) => {
        terminal.currentLine = line;
      }),
    };
    loadConnectedExplorer(commands, terminal);
    const document = env.document;
    const toggle = document.getElementById("command-explorer-toggle");
    const panel = document.getElementById("command-explorer-panel");

    click(toggle);
    click(document.querySelector('[data-command="help"]'));

    expect(terminal.setCurrentLine).not.toHaveBeenCalled();
    expect(terminal.executeCommandLine).not.toHaveBeenCalled();
    expect(terminal.currentLine).toBe("");
    expect(terminal.output).toBe("still-here");
    expect(panel.hidden).toBe(false);

    terminal.busy = false;
    click(document.querySelector('[data-command="help"]'));

    expect(terminal.setCurrentLine).toHaveBeenCalledTimes(1);
    expect(terminal.setCurrentLine).toHaveBeenCalledWith("help");
    expect(terminal.executeCommandLine).not.toHaveBeenCalled();
    expect(panel.hidden).toBe(true);
    expect(terminal.focus).toHaveBeenCalledTimes(1);

    terminal.executeCommandLine(terminal.currentLine);
    expect(terminal.executeCommandLine).toHaveBeenCalledTimes(1);
    expect(terminal.executeCommandLine).toHaveBeenCalledWith("help");
  });
});