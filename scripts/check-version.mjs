#!/usr/bin/env node
/**
 * Fails unless the package.json version is strictly greater than the version
 * on the base branch. Used by the PR workflow to enforce semantic versioning.
 *
 * Environment:
 *   BASE_REF - git ref to compare against (defaults to origin/main)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { gt, valid } from 'semver'

const BASE_REF_FALLBACK = 'origin/main'

function fail(message) {
  console.error(`Version check failed: ${message}`)
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const currentVersion = packageJson.version

if (!valid(currentVersion)) {
  fail(`package.json version "${currentVersion}" is not valid semantic versioning`)
}

const baseRef = (process.env.BASE_REF ?? '').trim() || BASE_REF_FALLBACK

let baseVersion
try {
  const basePackageJson = execFileSync('git', ['show', `${baseRef}:package.json`], { encoding: 'utf8' })
  baseVersion = JSON.parse(basePackageJson).version
} catch {
  console.warn(`No package.json found on "${baseRef}", treating the base version as 0.0.0`)
  baseVersion = '0.0.0'
}

if (!valid(baseVersion)) {
  fail(`package.json version on "${baseRef}" ("${baseVersion}") is not valid semantic versioning`)
}

if (!gt(currentVersion, baseVersion)) {
  fail(`package.json version must be strictly greater than "${baseRef}" (${baseVersion}), got ${currentVersion}`)
}

console.log(`Version check passed: ${currentVersion} > ${baseVersion}`)
