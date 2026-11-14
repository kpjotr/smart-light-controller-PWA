#!/usr/bin/env node
/**
 * FSF v1.1.0 & DAW – Deterministic Local Verification Gate (.fsf/fsf-verify.js)
 * Zero-dependency Node.js script enforcing:
 *  - CORE-HANDOFF-001: Schema validation of .fsf/planner_to_coder.json & generation of .fsf/coder_to_reviewer.json
 *  - CORE-CONC-001: Exclusive File Locking (allowed_files_to_modify vs git status)
 *  - AGENT-CODE-001: Static AST/Regex security banlist & FireFlow __VERSION__ protection
 *  - REF-VERIFY-001: Truthful test execution & .fsf/review_bundle.txt generation for SEPARATE_AGENT_INSTANCE
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const ROOT_DIR = process.cwd();
const FSF_DIR = path.join(ROOT_DIR, '.fsf');
const PLANNER_FILE = path.join(FSF_DIR, 'planner_to_coder.json');
const CODER_FILE = path.join(FSF_DIR, 'coder_to_reviewer.json');
const BUNDLE_FILE = path.join(FSF_DIR, 'review_bundle.txt');

const args = process.argv.slice(2);
const SKIP_TESTS = args.includes('--skip-tests');
const CUSTOM_TEST_CMD = (() => {
  const idx = args.indexOf('--test-cmd');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
})();

const errors = [];
const warnings = [];
const executedTests = [];
const deferredTests = [];

function logStep(step, msg) {
  console.log(`\n[FSF-GATE][${step}] ${msg}`);
}

function failGate(reason) {
  console.error(`\n❌ [FSF-GATE: FAIL] ${reason}`);
  errors.forEach((e, i) => console.error(`   ${i + 1}. ${e}`));
  console.error(`\nACTION REQUIRED FOR CODER AGENT (Anti): Fix all errors above and re-run 'node .fsf/fsf-verify.js' before requesting review!`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. Validate .gitignore & Load PLANNER_TO_CODER Contract (CORE-HANDOFF-001)
// ---------------------------------------------------------------------------
logStep('1/5', 'Validating .gitignore and loading .fsf/planner_to_coder.json...');

const gitignorePath = path.join(ROOT_DIR, '.gitignore');
if (fs.existsSync(gitignorePath)) {
  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  if (!gitignoreContent.split(/\r?\n/).some((line) => line.trim().startsWith('.fsf'))) {
    errors.push(`GITIGNORE VIOLATION: '.fsf/' directory MUST be listed in .gitignore to keep FireFlow working tree clean.`);
  }
} else {
  warnings.push(`No .gitignore found in project root. Ensure '.fsf/' is ignored before running FireFlow.`);
}

if (!fs.existsSync(PLANNER_FILE)) {
  failGate(`Missing '${PLANNER_FILE}'. Save the PLANNER_TO_CODER JSON contract first!`);
}

let plannerContract;
try {
  plannerContract = JSON.parse(fs.readFileSync(PLANNER_FILE, 'utf8'));
} catch (err) {
  failGate(`Invalid JSON in ${PLANNER_FILE}: ${err.message}`);
}

const requiredPlannerFields = [
  'schema_version',
  'framework_version',
  'handoff_type',
  'task_id',
  'project_context',
  'scope',
  'required_security_modules',
  'security_invariants',
  'authorization_expectations',
  'required_tests',
  'prohibited_actions',
];

for (const field of requiredPlannerFields) {
  if (!(field in plannerContract)) {
    errors.push(`SCHEMA ERROR (CORE-HANDOFF-001): Missing required field '${field}' in planner_to_coder.json.`);
  }
}

if (plannerContract.handoff_type !== 'PLANNER_TO_CODER') {
  errors.push(`SCHEMA ERROR: handoff_type must be 'PLANNER_TO_CODER'.`);
}

const allowedFiles = (plannerContract.scope?.allowed_files_to_modify || []).map((f) =>
  f.replace(/\\/g, '/').replace(/^\.\//, '')
);

if (allowedFiles.length === 0) {
  errors.push(`SCHEMA ERROR (CORE-CONC-001): scope.allowed_files_to_modify cannot be empty.`);
}

if (errors.length > 0) {
  failGate('PLANNER_TO_CODER contract validation failed.');
}

// ---------------------------------------------------------------------------
// 2. Enforce 6-Step Exclusive File Lock (CORE-CONC-001)
// ---------------------------------------------------------------------------
logStep('2/5', 'Checking Git working tree against scope.allowed_files_to_modify (CORE-CONC-001)...');

let gitStatusRaw = '';
try {
  gitStatusRaw = execSync('git status --porcelain -uall', { encoding: 'utf8' });
} catch (err) {
  failGate(`Git execution failed. Ensure this is a Git repository: ${err.message}`);
}

const modifiedFilesSet = new Set();
const statusLines = gitStatusRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);

for (const line of statusLines) {
  // Format: XY PATH or XY ORIG_PATH -> PATH
  const rawPath = line.slice(3).trim();
  const normalizedPath = (rawPath.includes(' -> ') ? rawPath.split(' -> ')[1] : rawPath)
    .replace(/^"|"$/g, '')
    .replace(/\\/g, '/');

  // Ignore .fsf/ internal artifacts
  if (normalizedPath.startsWith('.fsf/')) continue;
  modifiedFilesSet.add(normalizedPath);
}

const modifiedFiles = Array.from(modifiedFilesSet);

if (modifiedFiles.length === 0) {
  errors.push(`NO CHANGES DETECTED: Working tree has 0 modified files outside .fsf/.`);
}

for (const modFile of modifiedFiles) {
  const isAllowed = allowedFiles.some((allowed) => {
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -1);
      return modFile.startsWith(prefix);
    }
    return modFile === allowed;
  });

  if (!isAllowed) {
    errors.push(
      `FILE LOCK VIOLATION (CORE-CONC-001): File '${modFile}' was modified or created, but is NOT in scope.allowed_files_to_modify: [${allowedFiles.join(', ')}]. Revert unauthorized changes immediately!`
    );
  }
}

if (errors.length > 0) {
  failGate('File Lock Enforcement (CORE-CONC-001) failed.');
}
console.log(`   ✔ File Lock OK. Modified files (${modifiedFiles.length}): ${modifiedFiles.join(', ')}`);

// ---------------------------------------------------------------------------
// 3. Static Security & FireFlow __VERSION__ Scanner (AGENT-CODE-001)
// ---------------------------------------------------------------------------
logStep('3/5', 'Running Static Security Scanner (AGENT-CODE-001) & FireFlow checks...');

const STATIC_RULES = [
  {
    id: 'FIREBASE-RULES-001',
    testFile: (f) => f.endsWith('.rules'),
    regex: /allow\s+[^;]*:\s*if\s+true\s*;/i,
    msg: 'Critical open rule detected ("allow ...: if true;"). Strictly prohibited by AGENT-CODE-001.',
  },
  {
    id: 'FIREBASE-RULES-002',
    testFile: (f) => f.endsWith('.rules'),
    regex: /allow\s+(?:read\s*,\s*write|write)\s*:\s*if\s+request\.auth\s*!=\s*null\s*;/i,
    msg: 'Overly broad authenticated write rule ("allow write: if request.auth != null;") without ownership/schema check.',
  },
  {
    id: 'FRONTEND-XSS-001',
    testFile: (f) => /\.(js|jsx|ts|tsx|html)$/i.test(f) && !f.includes('.spec.') && !f.includes('.test.'),
    regex: /\b(eval\s*\(|new\s+Function\s*\(|dangerouslySetInnerHTML)/,
    msg: 'Unsafe dynamic code execution or raw HTML injection sink (eval / new Function / dangerouslySetInnerHTML) detected.',
  },
  {
    id: 'AGENT-TOOL-001',
    testFile: (f) => /\.(js|jsx|ts|tsx|html|json)$/i.test(f),
    regex: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----|AIza[0-9A-Za-z-_]{35}.*private_key/,
    msg: 'Potential hardcoded private key or service account credential detected in source file!',
  },
];

for (const file of modifiedFiles) {
  const fullPath = path.join(ROOT_DIR, file);
  if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;

  const content = fs.readFileSync(fullPath, 'utf8');

  for (const rule of STATIC_RULES) {
    if (rule.testFile(file) && rule.regex.test(content)) {
      errors.push(`STATIC SECURITY VIOLATION [${rule.id}] in '${file}': ${rule.msg}`);
    }
  }

  // Check Zod .strict() on backend functions if z.object is used (FIREBASE-FN-002)
  if (file.startsWith('functions/') && /\.(ts|js)$/.test(file) && content.includes('z.object(')) {
    if (!content.includes('.strict()')) {
      errors.push(
        `STATIC SECURITY VIOLATION [FIREBASE-FN-002] in '${file}': z.object() used without .strict(). Reject unknown fields!`
      );
    }
  }

  // Check negative test presence in modified test files (CORE-TIER-L1-001 / REF-TEST-RULES-001)
  if ((file.includes('.spec.') || file.includes('.test.')) && !/assertFails|rejects\.toThrow|toThrow/.test(content)) {
    errors.push(
      `MISSING NEGATIVE TEST [REF-VERIFY-001] in '${file}': Modified security/unit test file must include negative test assertions (e.g., assertFails or rejects.toThrow).`
    );
  }
}

// FireFlow __VERSION__ accidental removal check via git diff on .html files
for (const file of modifiedFiles.filter((f) => f.endsWith('.html'))) {
  try {
    const diffOut = execSync(`git diff -- "${file}"`, { encoding: 'utf8' });
    const removedVersion = /^-[^-].*__VERSION__/m.test(diffOut);
    const addedVersion = /^\+[^+].*__VERSION__/m.test(diffOut);
    if (removedVersion && !addedVersion) {
      errors.push(
        `FIREFLOW PLACEHOLDER VIOLATION in '${file}': The '__VERSION__' placeholder was removed! Restore '__VERSION__' for FireFlow byte-exact release sync.`
      );
    }
  } catch (_) {
    // Untracked new HTML file; warn if __VERSION__ is missing in index.html
    const fullPath = path.join(ROOT_DIR, file);
    if (path.basename(file) === 'index.html' && fs.existsSync(fullPath)) {
      const htmlContent = fs.readFileSync(fullPath, 'utf8');
      if (!htmlContent.includes('__VERSION__')) {
        warnings.push(`New '${file}' does not contain '__VERSION__' placeholder for FireFlow.`);
      }
    }
  }
}

if (errors.length > 0) {
  failGate('Static Security & FireFlow checks failed.');
}
console.log(`   ✔ Static Security & FireFlow checks passed.`);

// ---------------------------------------------------------------------------
// 4. Execute Tests & Record Truthful Evidence (REF-VERIFY-001)
// ---------------------------------------------------------------------------
logStep('4/5', 'Executing test suite and collecting verification evidence (REF-VERIFY-001)...');

let testCommandToRun = CUSTOM_TEST_CMD;
if (!testCommandToRun && !SKIP_TESTS) {
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.scripts?.['test:fsf']) {
        testCommandToRun = 'npm run test:fsf';
      } else if (
        pkg.scripts?.test &&
        !pkg.scripts.test.includes('no test specified')
      ) {
        testCommandToRun = 'npm test';
      }
    } catch (_) {}
  }
}

let proposedStatus = 'PASS';
let rawTestOutput = '';

if (testCommandToRun && !SKIP_TESTS) {
  console.log(`   Running command: ${testCommandToRun}`);
  const runResult = spawnSync(testCommandToRun, {
    shell: true,
    encoding: 'utf8',
    stdio: 'pipe',
  });

  rawTestOutput = `${runResult.stdout || ''}\n${runResult.stderr || ''}`.trim();
  console.log(rawTestOutput);

  // Parse test counts heuristically from Mocha/Jest/Vitest/Node test runner output cleanly
  const passMatch = rawTestOutput.match(/(\d+)\s+(?:passing|passed)/i);
  const failMatch = rawTestOutput.match(/(\d+)\s+(?:failing|failed)/i);
  const passedCount = passMatch ? parseInt(passMatch[1], 10) : runResult.status === 0 ? 1 : 0;
  const failedCount = failMatch ? parseInt(failMatch[1], 10) : runResult.status === 0 ? 0 : 1;

  executedTests.push({
    suite: 'Automated Project Test Suite',
    command: testCommandToRun,
    result: runResult.status === 0 ? 'PASS' : 'FAIL',
    passed_count: passedCount,
    failed_count: failedCount,
  });

  if (runResult.status !== 0) {
    errors.push(`TEST SUITE FAILED: Command '${testCommandToRun}' exited with code ${runResult.status}.`);
    failGate('Runtime / Emulator test suite failed.');
  }
} else {
  // Truthful reporting when no automated test runner is configured or --skip-tests is used
  proposedStatus = 'CONDITIONAL_PASS';
  const allReqTests = [
    ...(plannerContract.required_tests?.positive || []),
    ...(plannerContract.required_tests?.negative || []),
  ];
  for (const tRef of allReqTests) {
    deferredTests.push({
      test_ref: tRef,
      status: 'DEFERRED',
      justification: SKIP_TESTS
        ? 'Skipped via --skip-tests flag during static verification.'
        : 'No automated npm test / emulator script configured in package.json; requires Reviewer/UAT verification.',
      target_environment: 'Local Emulator / Reviewer Session',
    });
  }
  console.log(
    `   ⚠ No automated test script executed (Verification Level: STATIC_CHECKED). Proposed status capped at CONDITIONAL_PASS per REF-VERIFY-001.`
  );
}

// ---------------------------------------------------------------------------
// 5. Generate .fsf/coder_to_reviewer.json & .fsf/review_bundle.txt
// ---------------------------------------------------------------------------
logStep('5/5', 'Generating .fsf/coder_to_reviewer.json and .fsf/review_bundle.txt...');

let gitDiffRaw = '';
let headSha = 'uncommitted';
try {
  gitDiffRaw = execSync('git diff HEAD', { encoding: 'utf8' });
  headSha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
} catch (_) {
  try {
    gitDiffRaw = execSync('git diff', { encoding: 'utf8' });
  } catch (_) {}
}

const diffHash = crypto.createHash('sha256').update(gitDiffRaw || modifiedFiles.join(',')).digest('hex').slice(0, 12);
const changeId = `${headSha}-diff-${diffHash}`;
const tier = plannerContract.project_context?.tier || 'L2';

const coderToReviewer = {
  schema_version: '1.1.0',
  framework_version: '1.1.0',
  handoff_type: 'CODER_TO_REVIEWER',
  task_id: plannerContract.task_id,
  commit_or_change_id: changeId,
  modified_files: modifiedFiles,
  lock_released: true,
  verification_evidence: {
    executed_tests: executedTests,
    not_applicable_or_deferred_tests: deferredTests,
  },
  known_issues_and_open_items: warnings,
  residual_risks:
    executedTests.length === 0
      ? ['Automated runtime/emulator tests were not executed by fsf-verify.js; static checks passed (STATIC_CHECKED).']
      : [],
  requested_review_mode: tier === 'L1' ? 'SELF_REVIEWED_L1_ONLY' : 'SEPARATE_AGENT_INSTANCE',
  proposed_status: proposedStatus,
};

fs.writeFileSync(CODER_FILE, JSON.stringify(coderToReviewer, null, 2), 'utf8');

// Assemble self-contained review_bundle.txt for SEPARATE_AGENT_INSTANCE Reviewer Tab
const untrackedContents = modifiedFiles
  .filter((f) => {
    const line = statusLines.find((l) => l.includes(f));
    return line && line.startsWith('??');
  })
  .map((f) => {
    const p = path.join(ROOT_DIR, f);
    if (fs.existsSync(p) && !fs.statSync(p).isDirectory()) {
      return `--- NEW UNTRACKED FILE: ${f} ---\n${fs.readFileSync(p, 'utf8')}`;
    }
    return '';
  })
  .filter(Boolean)
  .join('\n\n');

const reviewBundle = [
  `================================================================================`,
  `FSF v1.1.0 INDEPENDENT SECURITY REVIEW BUNDLE (CORE-REV-001 / AGENT-REV-001)`,
  `Generated: ${new Date().toISOString()}`,
  `Change ID: ${changeId}`,
  `================================================================================`,
  ``,
  `### 1. PLANNER_TO_CODER CONTRACT (.fsf/planner_to_coder.json)`,
  JSON.stringify(plannerContract, null, 2),
  ``,
  `### 2. DETERMINISTIC CODER_TO_REVIEWER CONTRACT (.fsf/coder_to_reviewer.json)`,
  JSON.stringify(coderToReviewer, null, 2),
  ``,
  `### 3. EXECUTED TEST OUTPUT`,
  rawTestOutput || '(No automated test runner output captured; static verification only)',
  ``,
  `### 4. GIT DIFF & NEW FILES (INSPECT AGAINST 10-POINT AGENT-REV-001 PROTOCOL)`,
  gitDiffRaw || '(No tracked file diff)',
  untrackedContents ? `\n${untrackedContents}` : '',
].join('\n');

fs.writeFileSync(BUNDLE_FILE, reviewBundle, 'utf8');

console.log(`\n✅ [FSF-GATE: GATE_READY]`);
console.log(`   - Deterministic Contract : .fsf/coder_to_reviewer.json`);
console.log(`   - Reviewer Bundle        : .fsf/review_bundle.txt`);
console.log(`   - Proposed Status        : ${proposedStatus}`);
console.log(`   - Requested Review Mode  : ${coderToReviewer.requested_review_mode}\n`);