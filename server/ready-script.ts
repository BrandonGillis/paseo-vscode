/*
 * Served by the proxy as <secret>/__paseo/ready.js and loaded by the workbench page (its CSP
 * allows same-origin scripts). It tells the Paseo panel when VS Code shows the expected
 * theme, so the panel keeps its own loader until then instead of flashing VS Code's default
 * (light) theme. The expected editor color comes from <meta name="paseo-editor-background">.
 */
export const READY_PATH = "/__paseo/ready.js";
export const READY_MESSAGE = "paseo-vscode-ready";

export const READY_SCRIPT = `(function () {
  var meta = document.querySelector('meta[name="paseo-editor-background"]');
  var expected = meta ? meta.getAttribute("content") : null;
  var sent = false;
  function send() {
    if (sent) return;
    sent = true;
    try { parent.postMessage({ type: "${READY_MESSAGE}" }, "*"); } catch (e) {}
  }
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return "rgb(" + ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255) + ")";
  }
  function themed() {
    var editor = document.querySelector(".monaco-workbench .part.editor > .content");
    if (!editor || !document.querySelector(".monaco-workbench .part.statusbar")) return false;
    return !expected || getComputedStyle(editor).backgroundColor === hexToRgb(expected);
  }
  function check() {
    if (sent || !themed()) return;
    // A timer, not requestAnimationFrame: Chromium does not run animation frames in a hidden
    // cross-origin iframe, which this one is until it reports ready.
    setTimeout(send, 50);
  }
  new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
  var poll = setInterval(function () { check(); if (sent) clearInterval(poll); }, 100);
  // Never keep VS Code hidden: show it anyway after 20 s.
  setTimeout(send, 20000);
})();
`;
