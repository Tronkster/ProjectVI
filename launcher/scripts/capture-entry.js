// Electron entry used by capture.js. Runs the real launcher with a temporary profile,
// then walks through STEPS and captures the window after each one.

const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pkg = require("../package.json");

const out = process.env.CAPTURE_OUT || path.join(os.tmpdir(), "projectvi-captures");
fs.mkdirSync(out, { recursive: true });

app.setName(pkg.productName);
app.getVersion = () => pkg.version;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "projectvi-capture-"));
app.setPath("userData", profile);
process.env.LOCALAPPDATA = profile; // keeps the content cache out of the real profile too

// CAPTURE_STEPS can point at a .js file exporting its own steps, for one-off checks.
const DEFAULT_STEPS = [
  { name: "01-servers", run: "" },
  { name: "02-name-dialog", run: 'document.querySelector("[data-connect]")?.click()', wait: 800 },
  { name: "03-profile-menu", run: 'document.getElementById("dialog").close(); document.getElementById("profile-chip").click()' },
  { name: "04-settings-profile", run: 'document.body.click(); document.querySelector("[data-view=settings]").click()' },
  { name: "05-settings-game", run: 'document.getElementById("set-game").scrollIntoView(); document.getElementById("check-setup").click()' },
  { name: "06-settings-downloads", run: 'document.getElementById("set-downloads").scrollIntoView()' },
  { name: "07-settings-launcher", run: 'document.getElementById("set-launcher").scrollIntoView()' },
  { name: "08-settings-about", run: 'document.getElementById("set-about").scrollIntoView()' }
];
// A steps file can export an array, or { setup, steps } where setup() runs before the launcher starts.
const plan = process.env.CAPTURE_STEPS ? require(path.resolve(process.env.CAPTURE_STEPS)) : DEFAULT_STEPS;
const STEPS = Array.isArray(plan) ? plan : plan.steps;
if (!Array.isArray(plan)) plan.setup?.();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.on("browser-window-created", (_event, win) => {
  // The capture window is often in the background, where Chromium slows timers down.
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on("console-message", (event) => {
    if (event.level === "error" || event.level === "warning") console.log(`renderer ${event.level}: ${event.message}`);
  });
  win.webContents.once("did-finish-load", async () => {
    await wait(2500);
    for (const step of STEPS) {
      if (step.run) await win.webContents.executeJavaScript(step.run);
      await wait(step.wait ?? 600);
      fs.writeFileSync(path.join(out, `${step.name}.png`), (await win.webContents.capturePage()).toPNG());
      console.log(`captured ${step.name}`);
    }
    app.quit();
  });
});

require("../src/main/index.js");
