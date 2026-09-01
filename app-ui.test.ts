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

test("fields own their labels, use a compact form grid, and actions have independent busy states", () => {
  assert.match(app, /<Label id=\{labelId\} htmlFor=\{id\}>\{label\}<\/Label>/);
  assert.match(app, /role="group" aria-labelledby=\{labelId\}/);
  assert.match(app, /sm:grid-cols-\[minmax\(0,11rem\)_minmax\(0,1fr\)\]/);
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

test("routing copy explains personal, project-default, and incompatible-machine choices", () => {
  assert.match(select, /@radix-ui\/react-select/);
  assert.doesNotMatch(select, /<select\b/);
  assert.doesNotMatch(app, /<(?:select|option|optgroup)\b/);
  assert.match(app, /experimental_ProviderModelPicker as ProviderModelPicker/);
  assert.match(app, /Personal workspace \(no project\)/);
  assert.match(app, /Project default\$\{defaultMachine/);
  assert.match(app, /no project checkout/);
  assert.doesNotMatch(app, /Automatic —/);
});

test("provider changes remain a draft until the operator applies them", () => {
  const picker = app.match(/<ProviderModelPicker([\s\S]*?)\n\s*\/>/)?.[1];
  assert.ok(picker);
  assert.match(picker, /setModelDraft\(value\)/);
  assert.match(picker, /setModelDirty\(true\)/);
  assert.doesNotMatch(picker, /\bsave\(/);
  assert.match(app, /"Apply model"/);
  assert.match(app, /const applyModel = async/);
  assert.match(app, /providerId: modelDraft\.providerId/);
});

test("configured tokens render only the server-provided mask", () => {
  assert.match(app, /Saved token/);
  assert.match(app, /configuration\.botToken\.applicationId/);
  assert.match(app, /configuration\.botToken\.masked/);
  assert.doesNotMatch(app, /\[set\]/);
});
