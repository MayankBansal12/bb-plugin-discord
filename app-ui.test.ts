import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const select = readFileSync(new URL("./components/ui/select.tsx", import.meta.url), "utf8");

test("Discord uses one staged settings section instead of two config surfaces", () => {
  assert.equal([...app.matchAll(/app\.slots\.settingsSection\(/g)].length, 1);
  assert.match(app, /id: "setup"/);
  assert.doesNotMatch(app, /Derived identifiers|Machine ID|Server \(guild\) ID/);
});

test("token verification gates pairing and connected configuration", () => {
  const tokenGate = app.indexOf("!state.status.paired && (");
  const pairingGate = app.indexOf("!state.status.paired", tokenGate + 1);
  assert.ok(tokenGate > 0 && pairingGate > tokenGate);
  assert.match(app, /state\.status\.gateway\.state !== "connected"/);
  assert.match(app, /return <TokenSetup/);
  assert.match(app, /return <PairingSetup/);
  assert.match(app, /return <ConnectedPanel/);
});

test("paired installs retain the disconnect control when the gateway fails", () => {
  assert.match(app, /const gatewayDown = status\.gateway\.state !== "connected"/);
  assert.match(app, /gatewayDown \? <Notice destructive>/);
  assert.match(app, />Disconnect server<\/Button>/);
});

test("fields own their labels and actions have independent busy states", () => {
  assert.match(app, /<Label id=\{labelId\} htmlFor=\{id\}>\{label\}<\/Label>/);
  assert.match(app, /role="group" aria-labelledby=\{labelId\}/);
  for (const state of ["savingConfig", "savingRouting", "savingDestructive", "unpairing"]) {
    assert.match(app, new RegExp(`const \\[${state},`));
  }
});

test("controls come from reusable UI components and theme tokens", () => {
  for (const component of ["badge", "button", "card", "input", "label", "select", "switch"]) {
    assert.match(app, new RegExp(`@/components/ui/${component}`));
  }
  assert.doesNotMatch(app, /#[0-9a-f]{3,8}\b|\brgb\(|\boklch\(/i);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgb\(|\boklch\(/i);
});

test("dropdowns are portalled UI controls and the model reuses bb's picker", () => {
  assert.match(select, /@radix-ui\/react-select/);
  assert.doesNotMatch(select, /<select\b/);
  assert.doesNotMatch(app, /<(?:select|option|optgroup)\b/);
  assert.match(app, /experimental_ProviderModelPicker as ProviderModelPicker/);
  assert.match(app, /Automatic — \$\{execution\.project\.label\}/);
  assert.match(app, /Automatic — \$\{execution\.machine\.label\}/);
  assert.match(app, /Project default — \$\{execution\.model\.label\}/);
});

test("configured tokens render only the server-provided mask", () => {
  assert.match(app, /Saved token/);
  assert.match(app, /configuration\.botToken\.applicationId/);
  assert.match(app, /configuration\.botToken\.masked/);
  assert.doesNotMatch(app, /\[set\]/);
});
