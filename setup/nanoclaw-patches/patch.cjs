#!/usr/bin/env node
// Patches NanoClaw source to remove OneCLI dependency and wire in Andy.
// Usage: node patch.cjs [/path/to/nanoclaw]
'use strict';
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const NANOCLAW = process.argv[2] ?? '/app/nanoclaw';

const src_index    = resolve(NANOCLAW, 'src/index.ts');
const src_channels = resolve(NANOCLAW, 'src/channels/index.ts');
const pkg_file     = resolve(NANOCLAW, 'package.json');

// ─────────────────────────────────────────────────────────────────────────────
// 1. Patch src/index.ts
// ─────────────────────────────────────────────────────────────────────────────
{
  let src = readFileSync(src_index, 'utf-8');

  // Remove OneCLI SDK import line
  src = src.replace(/^import \{ OneCLI \} from '@onecli-sh\/sdk';\r?\n/m, '');

  // Remove ONECLI_URL from config destructure (handles both ", ONECLI_URL" and "ONECLI_URL," forms)
  src = src.replace(/,\s*\r?\n\s*ONECLI_URL/g, '');
  src = src.replace(/,\s*ONECLI_URL/g, '');
  src = src.replace(/ONECLI_URL,\s*/g, '');

  // Remove top-level OneCLI instantiation line
  src = src.replace(/^const onecli = new OneCLI\([^)]*\);\r?\n/m, '');

  // Remove ensureOneCLIAgent function definition (whole block)
  src = src.replace(
    /^function ensureOneCLIAgent\b[\s\S]*?\n\}\r?\n/m,
    '',
  );

  // Remove all calls to ensureOneCLIAgent(...)
  src = src.replace(/^[ \t]*ensureOneCLIAgent\([^)]*\);\r?\n/gm, '');

  // Remove ensureContainerSystemRunning() call in main()
  src = src.replace(/^[ \t]*ensureContainerSystemRunning\(\);\r?\n/m, '');

  // Remove ensureContainerSystemRunning function definition
  src = src.replace(
    /^function ensureContainerSystemRunning\b[\s\S]*?\n\}\r?\n/m,
    '',
  );

  // Remove import of ensureContainerRuntimeRunning / cleanupOrphans
  src = src.replace(
    /^import \{[^}]*(?:ensureContainerRuntimeRunning|cleanupOrphans)[^}]*\} from '\.\/container-runtime\.js';\r?\n/m,
    '',
  );

  // Add PM channel auto-registration inside main() after loadState()
  // Matches the literal sequence that appears in NanoClaw's main()
  const LOAD_STATE_MARKER = "  initDatabase();\n  logger.info('Database initialized');\n  loadState();";
  const LOAD_STATE_REPLACEMENT = `  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Auto-register Andy's main Discord channel as the primary group on first run
  {
    const _pmChannelId = process.env['DISCORD_PM_CHANNEL_ID'] ?? '';
    if (_pmChannelId && !registeredGroups[_pmChannelId]) {
      registerGroup(_pmChannelId, {
        name: ASSISTANT_NAME,
        folder: 'main',
        trigger: DEFAULT_TRIGGER,
        added_at: new Date().toISOString(),
        isMain: true,
        requiresTrigger: false,
      });
    }
  }`;

  if (src.includes(LOAD_STATE_MARKER)) {
    src = src.replace(LOAD_STATE_MARKER, LOAD_STATE_REPLACEMENT);
    console.log('  ✓ Added PM channel auto-registration');
  } else {
    console.warn('  WARN: Could not find loadState() marker — skipping auto-registration patch');
  }

  writeFileSync(src_index, src);
  console.log('✓ Patched src/index.ts');
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Patch src/channels/index.ts — add Discord channel import
// ─────────────────────────────────────────────────────────────────────────────
{
  let src = readFileSync(src_channels, 'utf-8');
  if (!src.includes("import './discord.js'")) {
    src += "\nimport './discord.js';\n";
  }
  writeFileSync(src_channels, src);
  console.log('✓ Patched src/channels/index.ts');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Patch package.json — remove @onecli-sh/sdk, add discord.js
// ─────────────────────────────────────────────────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(pkg_file, 'utf-8'));
  if (pkg.dependencies['@onecli-sh/sdk']) {
    delete pkg.dependencies['@onecli-sh/sdk'];
    console.log('  ✓ Removed @onecli-sh/sdk');
  }
  pkg.dependencies['discord.js'] = '^14.18.0';
  console.log('  ✓ Added discord.js');
  writeFileSync(pkg_file, JSON.stringify(pkg, null, 2) + '\n');
  console.log('✓ Patched package.json');
}

console.log('\nNanoClaw patches applied successfully.');
