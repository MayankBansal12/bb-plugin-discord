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

test("fields own their labels, controls fill the row, and actions have independent busy states", () => {
  assert.match(app, /<Label id=\{labelId\} htmlFor=\{id\}>\{label\}<\/Label>/);
  assert.match(app, /role="group" aria-labelledby=\{labelId\}/);
  assert.match(app, /sm:grid-cols-\[minmax\(0,3fr\)_minmax\(0,2fr\)\]/);
  for (const state of ["savingConfig", "unpairing"]) {
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

test("routing choices are concise and fold the default into the machine list", () => {
  assert.match(select, /@radix-ui\/react-select/);
  assert.doesNotMatch(select, /<select\b/);
  assert.doesNotMatch(app, /<(?:select|option|optgroup)\b/);
  assert.match(app, /experimental_ProviderModelPicker as ProviderModelPicker/);
  assert.match(app, /personalProject\?\.name \|\| "Personal"/);
  assert.match(app, /`\$\{defaultMachine\.name\} \(default\)`/);
  assert.match(app, /machine\.id !== defaultMachineId/);
  assert.match(app, /\(no checkout\)/);
  assert.doesNotMatch(app, /Automatic/);
});

test("routing and model changes are staged for the single configuration save", () => {
  const picker = app.match(/<ProviderModelPicker([\s\S]*?)\n\s*\/>/)?.[1];
  assert.ok(picker);
  assert.match(picker, /edit\(\{ modelValue: value, modelPinned: true \}\)/);
  assert.match(app, /state\.rpc\.call\("setConfiguration"/);
  assert.match(app, /providerId: draft\.modelPinned/);
  assert.match(app, /"Save Changes"/);
  assert.doesNotMatch(app, /Apply model|setExecutionSelection/);
});

test("the model picker stays compact and every edit uses the settings-scoped save bar", () => {
  assert.match(app, /className="max-w-full"/);
  assert.doesNotMatch(app, /className="w-full justify-between"/);
  assert.match(app, /className="discord-unsaved-bar"/);
  assert.match(app, />Reset<\/Button>/);
  assert.match(app, /checked=\{draft\.destructiveActions\}/);
  assert.match(app, /edit\("destructiveActions", checked\)/);
  assert.doesNotMatch(app, /dirty && "pb-24"/);
  assert.match(app, /before using the Discord bot\./);
  assert.match(css, /\.discord-unsaved-bar\s*\{[\s\S]*?position: sticky;/);
  assert.doesNotMatch(css, /\.discord-enter\s*\{[^}]*animation:[^;}]*both/);
  const unsavedBar = css.match(/\.discord-unsaved-bar\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(unsavedBar);
  assert.match(unsavedBar, /width: 100%/);
  assert.doesNotMatch(unsavedBar, /\bleft:|translateX|calc\(50%/);
  assert.match(unsavedBar, /background: var\(--card\)/);
  assert.doesNotMatch(unsavedBar, /\bborder:|\bbox-shadow:/);
  assert.doesNotMatch(select, /focus:ring-2|focus:ring-ring/);
  assert.match(select, /focus:ring-0 focus:ring-offset-0/);
});

test("configured tokens render only the server-provided suffix mask", () => {
  assert.match(app, /Saved token/);
  assert.match(app, /configuration\.botToken\.masked/);
  assert.doesNotMatch(app, /configuration\.botToken\.applicationId/);
  assert.doesNotMatch(app, /\[set\]/);
});
