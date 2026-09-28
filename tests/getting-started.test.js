import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

const require = createRequire(import.meta.url);
const { appBundleSources } = require("../scripts/build-assets.js");

const environments = [];

function createPanelEnvironment(html) {
  const env = createBrowserEnv({
    html:
      html ||
      `
        <!doctype html>
        <html>
          <body>
            <button
              id="getting-started-toggle"
              type="button"
              aria-controls="getting-started-panel"
              aria-expanded="false"
            >Getting started</button>
            <section id="getting-started-panel" hidden>
              <button id="getting-started-close" type="button">Close</button>
            </section>
            <button id="outside" type="button">Outside</button>
            <div id="terminal">
              <div class="xterm-screen">screen state</div>
              <textarea class="xterm-helper-textarea">draft command</textarea>
            </div>
          </body>
        </html>
      `,
  });

  environments.push(env);
  return env;
}

function pressKey(env, target, key) {
  const event = new env.window.KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    key,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  while (environments.length > 0) {
    environments.pop().cleanup();
  }
});

describe("Getting started interactions", () => {
  it("preserves terminal state across Close, in-panel Escape, and repeat-toggle transitions", () => {
    const env = createPanelEnvironment();
    const toggle = env.document.getElementById("getting-started-toggle");
    const panel = env.document.getElementById("getting-started-panel");
    const close = env.document.getElementById("getting-started-close");
    const outside = env.document.getElementById("outside");
    const terminal = env.document.getElementById("terminal");
    const screen = terminal.querySelector(".xterm-screen");
    const input = terminal.querySelector(".xterm-helper-textarea");
    const terminalParent = terminal.parentNode;

    env.loadScript("js/getting-started.js");

    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    outside.focus();
    const outsideEscape = pressKey(env, outside, "Escape");
    expect(outsideEscape.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(outside);

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    const unrelatedKey = pressKey(env, close, "ArrowDown");
    expect(unrelatedKey.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(close);

    close.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(env.document.activeElement).toBe(close);

    const panelEscape = pressKey(env, close, "Escape");
    expect(panelEscape.defaultPrevented).toBe(true);
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);

    toggle.click();
    expect(panel.hidden).toBe(false);
    expect(env.document.activeElement).toBe(close);

    toggle.click();
    expect(panel.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(env.document.activeElement).toBe(toggle);

    expect(env.document.getElementById("terminal")).toBe(terminal);
    expect(terminal.parentNode).toBe(terminalParent);
    expect(terminal.querySelector(".xterm-screen")).toBe(screen);
    expect(screen.textContent).toBe("screen state");
    expect(terminal.querySelector(".xterm-helper-textarea")).toBe(input);
    expect(input.value).toBe("draft command");
  });

  it("does not close for Escape dispatched from outside the focused panel subtree", () => {
    const env = createPanelEnvironment();
    const toggle = env.document.getElementById("getting-started-toggle");
    const panel = env.document.getElementById("getting-started-panel");
    const outside = env.document.getElementById("outside");

    env.loadScript("js/getting-started.js");
    toggle.click();
    outside.focus();

    const event = pressKey(env, panel, "Escape");
    expect(event.defaultPrevented).toBe(false);
    expect(panel.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(env.document.activeElement).toBe(outside);
  });

  it.each([
    ["toggle", `<section id="getting-started-panel" hidden><button id="getting-started-close">Close</button></section>`],
    ["panel", `<button id="getting-started-toggle" aria-expanded="false">Getting started</button><button id="getting-started-close">Close</button>`],
    ["close", `<button id="getting-started-toggle" aria-expanded="false">Getting started</button><section id="getting-started-panel" hidden></section>`],
  ])("starts safely when the %s control is missing", (_name, markup) => {
    const env = createPanelEnvironment(`<!doctype html><html><body>${markup}<div id="terminal">unchanged</div></body></html>`);
    const terminal = env.document.getElementById("terminal");

    expect(() => env.loadScript("js/getting-started.js")).not.toThrow();
    expect(env.document.getElementById("terminal")).toBe(terminal);
    expect(terminal.textContent).toBe("unchanged");
  });

  it("is bundled before terminal bootstrap without exposing controller globals", () => {
    const env = createPanelEnvironment();

    env.loadScript("js/getting-started.js");

    expect(appBundleSources).toContain("js/getting-started.js");
    expect(appBundleSources.indexOf("js/getting-started.js")).toBeLessThan(
      appBundleSources.indexOf("js/bootstrap.js")
    );
    expect(env.window.openPanel).toBeUndefined();
    expect(env.window.closePanel).toBeUndefined();
  });
});
