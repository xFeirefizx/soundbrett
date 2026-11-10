// Rewrites module.json in place for a release, so version + URLs match that
// exact release: "download" points at the tag's asset, "manifest" stays on
// "latest" so Foundry detects future updates.
//
// Inputs (environment): VERSION (e.g. 1.2.0), TAG (e.g. v1.2.0),
// GITHUB_REPOSITORY (owner/name, set by GitHub Actions).
//
// Replaces the archived microsoft/variable-substitution action and keeps its
// output format (4-space indent, no trailing newline), so released manifests
// stay byte-identical to earlier releases.
import { readFileSync, writeFileSync } from "node:fs";

const { VERSION, TAG, GITHUB_REPOSITORY } = process.env;
for (const [name, value] of Object.entries({ VERSION, TAG, GITHUB_REPOSITORY })) {
  if (!value) {
    console.error(`prepare-manifest: environment variable ${name} is not set`);
    process.exit(1);
  }
}

const file = "module.json";
const manifest = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
const repoUrl = `https://github.com/${GITHUB_REPOSITORY}`;

// Only existing keys are overwritten — a key missing from module.json is an
// error, never silently added.
const values = {
  version: VERSION,
  url: repoUrl,
  manifest: `${repoUrl}/releases/latest/download/module.json`,
  download: `${repoUrl}/releases/download/${TAG}/module.zip`,
};
for (const [key, value] of Object.entries(values)) {
  if (!(key in manifest)) {
    console.error(`prepare-manifest: module.json has no "${key}" field`);
    process.exit(1);
  }
  manifest[key] = value;
  console.log(`${key} = ${value}`);
}

writeFileSync(file, JSON.stringify(manifest, null, 4));
