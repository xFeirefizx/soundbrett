// Validates a Foundry module directory (default: the current directory):
//   - module.json is valid JSON and carries the required fields
//   - every file the manifest references exists
//   - every language file is valid JSON
//   - every script / ES module passes a syntax check (node --check)
//
// Usage: node .github/scripts/check-manifest.mjs [directory]
// Used by the Check workflow (repo root) and by the Release workflow (run
// against the unpacked module.zip, so the package is checked as shipped).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.argv[2] ?? ".";
const errors = [];
const fail = (message) => errors.push(message);

function readJson(relPath) {
  const full = join(root, relPath);
  if (!existsSync(full)) {
    fail(`${relPath}: file not found`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(full, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    fail(`${relPath}: invalid JSON (${err.message})`);
    return null;
  }
}

const isFilled = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function requireFile(relPath, label) {
  if (!isFilled(relPath)) {
    fail(`module.json: ${label} has no path`);
    return false;
  }
  const full = join(root, relPath);
  if (!existsSync(full) || !statSync(full).isFile()) {
    fail(`module.json: ${label} points to a missing file: ${relPath}`);
    return false;
  }
  return true;
}

const manifest = readJson("module.json");

if (manifest && !isObject(manifest)) {
  fail("module.json: top level must be an object");
} else if (manifest) {
  // Required fields. id/title/description/version are mandatory for Foundry;
  // compatibility + the three URLs are what installs and updates rely on.
  for (const key of ["id", "title", "description", "version"]) {
    if (!isFilled(manifest[key])) fail(`module.json: required field "${key}" is missing or empty`);
  }
  for (const key of ["minimum", "verified"]) {
    if (!isFilled(manifest.compatibility?.[key])) {
      fail(`module.json: required field "compatibility.${key}" is missing or empty`);
    }
  }
  for (const key of ["url", "manifest", "download"]) {
    if (!isFilled(manifest[key])) {
      fail(`module.json: required field "${key}" is missing or empty`);
    } else if (!manifest[key].startsWith("https://")) {
      fail(`module.json: "${key}" must be an https:// URL`);
    }
  }

  // Referenced files. A styles entry may be a plain path or an object with
  // "src" (Foundry accepts both).
  const list = (key) => (Array.isArray(manifest[key]) ? manifest[key] : []);
  const code = [
    ...list("esmodules").map((path) => ({ path, label: "esmodules entry", module: true })),
    ...list("scripts").map((path) => ({ path, label: "scripts entry", module: false })),
  ];
  if (code.length === 0) fail('module.json: neither "esmodules" nor "scripts" lists a file');

  for (const entry of code) {
    if (!requireFile(entry.path, entry.label)) continue;
    // ES modules are fed through stdin with --input-type=module, so
    // import/export syntax is accepted regardless of the Node version's
    // file-type detection.
    const result = entry.module
      ? spawnSync(process.execPath, ["--input-type=module", "--check"], {
          input: readFileSync(join(root, entry.path)),
          encoding: "utf8",
        })
      : spawnSync(process.execPath, ["--check", join(root, entry.path)], { encoding: "utf8" });
    if (result.status !== 0) {
      fail(`${entry.path}: syntax check failed\n${(result.stderr || "").trim()}`);
    } else {
      console.log(`ok  syntax   ${entry.path}`);
    }
  }

  for (const style of list("styles")) {
    const path = isObject(style) ? style.src : style;
    if (requireFile(path, "styles entry")) console.log(`ok  style    ${path}`);
  }

  for (const language of list("languages")) {
    if (!isFilled(language?.lang)) fail('module.json: a languages entry has no "lang"');
    if (!requireFile(language?.path, `languages entry "${language?.lang ?? "?"}"`)) continue;
    const strings = readJson(language.path);
    if (strings === null) continue;
    if (!isObject(strings)) {
      fail(`${language.path}: top level must be an object`);
    } else {
      console.log(`ok  language ${language.path} (${Object.keys(strings).length} top-level keys)`);
    }
  }
}

if (errors.length > 0) {
  for (const message of errors) console.error(`::error::${message.replace(/\r?\n/g, "%0A")}`);
  console.error(`check-manifest: ${errors.length} problem(s) found`);
  process.exit(1);
}
console.log(`check-manifest: ${manifest.id} ${manifest.version} is valid`);
