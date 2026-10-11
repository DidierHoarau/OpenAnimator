#!/usr/bin/env node
// OpenAnimator headless CLI shim: runs the TypeScript CLI through tsx so the
// package needs no prebuilt CLI bundle.
import { tsImport } from 'tsx/esm/api'

await tsImport('../src/cli/main.ts', import.meta.url)
