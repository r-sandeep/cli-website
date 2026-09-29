import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserEnv } from "./helpers/browser-env";

let env;

function loadBootstrap(overrides = {}) {
  let bufferLines = [""];
  const activeBuffer = {
    get length() {
      return bufferLines.length;
    },
    getLine: vi.fn((index) => ({
      isWrapped: false,
      translateToString: vi.fn(() => bufferLines[index]),
    })),
  };
  const term = {
    buffer: { active: activeBuffer },
    loadAddon: vi.fn(),
    onWriteParsed: vi.fn(),
    open: vi.fn((element) => {
      const screen = element.ownerDocument.createElement("div");
      screen.className = "xterm-screen";
      element.appendChild(screen);
    }),
  };
  const fitAddon = { fit: vi.fn() };
  const webLinksAddon = { open: vi.fn() };
  const preloadCommandAssets = vi.fn(() => Promise.resolve());
  const extend = vi.fn((instance) => {
    instance.deepLink = "whois lee";
    instance.preloadCommandAssets = preloadCommandAssets;
  });
  const runRootTerminal = vi.fn();
  const preloadASCIIArt = vi.fn();
  const preloadFiles = vi.fn();
  const idleCalls = [];
  const requestIdleCallback = vi.fn((task, options) => {
    idleCalls.push({ options, task });
  });
  const Terminal = vi.fn(function Terminal() {
    return term;
  });
  const FitAddonCtor = vi.fn(function FitAddon() {
    return fitAddon;
  });
  const WebLinksAddonCtor = vi.fn(function WebLinksAddon() {
    return webLinksAddon;
  });

  env = createBrowserEnv({
    html: `
      <!doctype html>
      <html>
        <head></head>
        <body>
          <div id="terminal"></div>
        </body>
      </html>
    `,
    url: "https://www.root.vc/#whois-lee",
    globals: {
      FitAddon: { FitAddon: FitAddonCtor },
      Terminal,
      WebLinksAddon: { WebLinksAddon: WebLinksAddonCtor },
      extend,
      preloadASCIIArt,
      preloadFiles,
      requestIdleCallback,
      runRootTerminal,
      ...overrides,
    },
  });

  env.loadScripts(["js/bootstrap.js"]);

  return {
    extend,
    fitAddon,
    idleCalls,
    setBufferLines(lines) {
      bufferLines = lines;
    },
    preloadASCIIArt,
    preloadCommandAssets,
    preloadFiles,
    requestIdleCallback,
    runRootTerminal,
    term,
    Terminal,
    webLinksAddon,
  };
}

afterEach(() => {
  if (env) {
    env.cleanup();
    env = null;
  }
});

describe("bootstrap", () => {
  it("boots the terminal and preloads deep-link assets before idle work", async () => {
    const state = loadBootstrap();

    await env.window.deepLinkAssetPromise;

    expect(state.term.open).toHaveBeenCalledWith(
      env.document.getElementById("terminal")
    );
    expect(state.term.loadAddon).toHaveBeenNthCalledWith(1, state.fitAddon);
    expect(state.term.loadAddon).toHaveBeenNthCalledWith(
      2,
      state.webLinksAddon
    );
    expect(state.extend).toHaveBeenCalledWith(state.term);
    expect(state.preloadCommandAssets).toHaveBeenCalledWith("whois lee");
    expect(state.runRootTerminal).toHaveBeenCalledWith(state.term);
    expect(state.idleCalls).toHaveLength(1);
    expect(state.idleCalls[0].options).toEqual({ timeout: 1500 });

    state.idleCalls[0].task();

    expect(state.preloadASCIIArt).toHaveBeenCalledTimes(1);
    expect(state.preloadFiles).toHaveBeenCalledTimes(1);
  });

  it("exposes canvas output as a line-delimited semantic transcript", () => {
    const state = loadBootstrap();
    const updateTranscript = state.term.onWriteParsed.mock.calls[0][0];

    state.setBufferLines(["guest:rootpc / $ pwd", "/", "guest:rootpc / $ "]);
    updateTranscript();

    const transcript = env.document.querySelector(
      ".xterm-screen .terminal-transcript"
    );
    expect(transcript).not.toBeNull();
    expect(transcript.getAttribute("role")).toBe("log");
    expect(transcript.textContent).toContain("pwd\n/\n");
  });

  it("deduplicates optional script loading for aalib and rickroll", async () => {
    const state = loadBootstrap();
    const originalAppendChild = env.document.head.appendChild.bind(
      env.document.head
    );
    const appendedScripts = [];

    vi.spyOn(env.document.head, "appendChild").mockImplementation((node) => {
      appendedScripts.push(node);
      return originalAppendChild(node);
    });

    const aalibFirst = env.window.ensureAALibLoaded();
    const aalibSecond = env.window.ensureAALibLoaded();

    expect(aalibFirst).toBe(aalibSecond);
    expect(appendedScripts).toHaveLength(1);
    expect(appendedScripts[0].src).toBe("https://www.root.vc/js/aalib.js");

    appendedScripts[0].onload();
    await aalibFirst;

    const rickrollPromise = env.window.ensureRickRollLoaded();

    expect(appendedScripts).toHaveLength(2);
    expect(appendedScripts[1].src).toBe(
      "https://www.root.vc/js/rickroll.min.js"
    );

    appendedScripts[1].onload();
    await rickrollPromise;
  });
});
