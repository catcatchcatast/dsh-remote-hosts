import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { releasePackageDirectories, releaseProfile, workspaceRoot } from './release-profile.mjs'

export const RULES = Object.freeze({
  contextServiceAccess: 'context-service-access',
  injectOfficialService: 'inject-official-service',
  privateRuntimeImport: 'private-runtime-import',
  carrierRaw: 'carrier-raw',
  legacyChunkrow: 'legacy-chunkrow',
  legacySourceEventSeqs: 'legacy-source-event-seqs',
  legacySurfaceOpRange: 'legacy-surface-op-range',
})

const SERVICE_NAMES = new Set(['sessionController', 'workspaceController', 'connection', 'subagents'])
const MIGRATION_PACKAGES = new Set([
  'mobile-controller-compat-rc1',
  'mobile-session-sync-rc1',
  'mobile-stream-compat-rc1',
  'mobile-interactions-compat-rc1',
])
const CODE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx'])
const PRIVATE_RUNTIME_SPECIFIER = /^(?:@deepseek-ai\/dsh-api-[^/]+(?:\/|$)|@deepseek-ai\/dsh-client-connection(?:\/|$)|@deepseek-ai\/dsh-core(?:\/|$)|(?:\.\.\/)+dsh-core(?:\/|$))/u
const TRACE_COMMENT = ''

function slash(value) { return value.split(path.sep).join('/') }
function relativeFile(root, file) { return slash(path.relative(root, file)) }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex') }
function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function normalizedPrint(node, sourceFile) {
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/gu, ' ').trim()
}

export function expressionHash(node, sourceFile) {
  return sha256(normalizedPrint(node, sourceFile))
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined
}

function propertyNameText(name) {
  if (!name) return undefined
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text
  return literalText(name)
}

function isIdentifier(node, value) { return ts.isIdentifier(node) && node.text === value }

function isContextReceiver(node) {
  return isIdentifier(node, 'ctx') || isIdentifier(node, 'context')
}

function isStringElement(node, value) {
  return literalText(node) === value
}

function isSurfaceReceiver(node) {
  if (isIdentifier(node, 'surfaceOp')) return true
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'surfaceOp'
  return ts.isElementAccessExpression(node) && isStringElement(node.argumentExpression, 'surfaceOp')
}

function privateRuntimeSpecifier(value) {
  return PRIVATE_RUNTIME_SPECIFIER.test(value)
}

function codeFiles(root, directory, manifest) {
  const packageRoot = path.join(root, 'packages', directory)
  const declared = Array.isArray(manifest.files) && manifest.files.length > 0 ? manifest.files : ['src']
  const result = []
  const visit = candidate => {
    let stat
    try { stat = fs.lstatSync(candidate) } catch { return }
    if (stat.isSymbolicLink()) return
    if (stat.isFile()) {
      if (CODE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) result.push(candidate)
      return
    }
    if (!stat.isDirectory()) return
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.name === 'node_modules' || entry.name === 'dist') continue
      visit(path.join(candidate, entry.name))
    }
  }
  for (const item of declared) {
    if (typeof item !== 'string' || item.includes('\u0000')) continue
    const normalized = item.replaceAll('/', path.sep)
    if (path.isAbsolute(normalized) || normalized.split(/[\\/]+/u).includes('..')) continue
    visit(path.join(packageRoot, normalized))
  }
  return [...new Set(result)].sort()
}

function addViolation(out, sourceFile, node, ruleId, extra = {}) {
  const normalized = normalizedPrint(node, sourceFile)
  const start = node.getStart(sourceFile, true)
  const position = sourceFile.getLineAndCharacterOfPosition(start)
  out.push({
    file: relativeFile(path.dirname(path.dirname(sourceFile.fileName)), sourceFile.fileName),
    ruleId,
    line: position.line + 1,
    column: position.character + 1,
    expression: normalized,
    expressionHash: sha256(normalized),
    ...extra,
  })
}

function addContextAccess(out, sourceFile, node) {
  if (ts.isPropertyAccessExpression(node) && SERVICE_NAMES.has(node.name.text) && isContextReceiver(node.expression)) {
    addViolation(out, sourceFile, node, RULES.contextServiceAccess, { service: node.name.text })
  } else if (ts.isElementAccessExpression(node) && isContextReceiver(node.expression)) {
    const service = literalText(node.argumentExpression)
    if (SERVICE_NAMES.has(service)) addViolation(out, sourceFile, node, RULES.contextServiceAccess, { service })
  }
}

function addInjectEntries(out, sourceFile, node) {
  const initializer = ts.isVariableDeclaration(node) && isIdentifier(node.name, 'inject')
    ? node.initializer
    : ts.isPropertyAssignment(node) && propertyNameText(node.name) === 'inject'
      ? node.initializer
      : undefined
  if (!initializer || !ts.isArrayLiteralExpression(initializer)) return
  for (const element of initializer.elements) {
    const service = literalText(element)
    if (SERVICE_NAMES.has(service)) addViolation(out, sourceFile, element, RULES.injectOfficialService, { service })
  }
}

function addImportViolations(out, sourceFile, node) {
  if (ts.isImportDeclaration(node)) {
    const specifier = literalText(node.moduleSpecifier)
    if (specifier !== undefined && privateRuntimeSpecifier(specifier)) addViolation(out, sourceFile, node.moduleSpecifier, RULES.privateRuntimeImport, { specifier })
    return
  }
  if (!ts.isCallExpression(node) || !isIdentifier(node.expression, 'require')) return
  const specifier = literalText(node.arguments[0])
  if (specifier !== undefined && privateRuntimeSpecifier(specifier)) addViolation(out, sourceFile, node.arguments[0], RULES.privateRuntimeImport, { specifier })
}

function addRawViolation(out, sourceFile, node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'raw') addViolation(out, sourceFile, node, RULES.carrierRaw)
  else if (ts.isElementAccessExpression(node) && isStringElement(node.argumentExpression, 'raw')) addViolation(out, sourceFile, node, RULES.carrierRaw)
}

function addLegacyFieldViolation(out, sourceFile, node) {
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'sourceEventSeqs') {
    addViolation(out, sourceFile, node, RULES.legacySourceEventSeqs)
  } else if (ts.isElementAccessExpression(node) && isStringElement(node.argumentExpression, 'sourceEventSeqs')) {
    addViolation(out, sourceFile, node, RULES.legacySourceEventSeqs)
  } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isPropertySignature(node)) && propertyNameText(node.name) === 'sourceEventSeqs') {
    addViolation(out, sourceFile, node.name, RULES.legacySourceEventSeqs)
  }
}

function isNestedSurfaceObjectField(node) {
  if (!ts.isPropertyAssignment(node) || !['start', 'end'].includes(propertyNameText(node.name))) return false
  const object = node.parent
  if (!ts.isObjectLiteralExpression(object)) return false
  const owner = object.parent
  return ts.isPropertyAssignment(owner) && propertyNameText(owner.name) === 'surfaceOp'
}

function addSurfaceViolation(out, sourceFile, node) {
  if (ts.isPropertyAccessExpression(node) && ['start', 'end'].includes(node.name.text) && isSurfaceReceiver(node.expression)) {
    addViolation(out, sourceFile, node, RULES.legacySurfaceOpRange, { field: node.name.text })
  } else if (ts.isElementAccessExpression(node) && ['start', 'end'].some(field => isStringElement(node.argumentExpression, field)) && isSurfaceReceiver(node.expression)) {
    addViolation(out, sourceFile, node, RULES.legacySurfaceOpRange, { field: node.argumentExpression.text.slice(1, -1) })
  } else if (isNestedSurfaceObjectField(node)) {
    addViolation(out, sourceFile, node.name, RULES.legacySurfaceOpRange, { field: propertyNameText(node.name) })
  }
}

function scanFile(root, packageDirectory, file, violations) {
  const source = fs.readFileSync(file, 'utf8')
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const local = []
  const visit = node => {
    addContextAccess(local, sourceFile, node)
    addInjectEntries(local, sourceFile, node)
    addImportViolations(local, sourceFile, node)
    addRawViolation(local, sourceFile, node)
    addLegacyFieldViolation(local, sourceFile, node)
    addSurfaceViolation(local, sourceFile, node)
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (node.text.includes('chunkrow/')) addViolation(local, sourceFile, node, RULES.legacyChunkrow)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  const workspaceRelative = relativeFile(root, file)
  for (const violation of local) {
    violation.file = workspaceRelative
    violation.package = packageDirectory
    violation.trace = TRACE_COMMENT
    violations.push(violation)
  }
}

function readExceptions(file) {
  if (file === undefined || !fs.existsSync(file)) return { entries: [], source: file }
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = Array.isArray(value) ? value : value?.exceptions
  if (!Array.isArray(entries)) throw new Error('INTERFACE_EXCEPTIONS_MUST_BE_ARRAY')
  return { entries, source: file }
}

function exceptionKey(item) { return `${item.file}\u0000${item.ruleId}\u0000${item.expressionHash}` }

function validateExceptions(root, entries, violations) {
  const errors = []
  const normalized = []
  const keys = new Set()
  for (const item of entries) {
    const expressionHashValue = isRecord(item) ? (item.expressionHash ?? item.normalizedExpressionHash ?? item.hash) : undefined
    if (!isRecord(item) || typeof item.file !== 'string' || typeof item.ruleId !== 'string' || typeof expressionHashValue !== 'string') {
      errors.push({ code: 'INVALID_EXCEPTION', exception: item })
      continue
    }
    const file = slash(item.file)
    if (!file.startsWith('packages/') || path.posix.isAbsolute(file) || path.win32.isAbsolute(file) || file.includes('..') || file.includes('*') || file.includes('?') || file.endsWith('/')) {
      errors.push({ code: 'INVALID_EXCEPTION_FILE', file })
      continue
    }
    const packageName = file.split('/')[1]
    if (MIGRATION_PACKAGES.has(packageName)) {
      errors.push({ code: 'MIGRATION_EXCEPTION_FORBIDDEN', file, ruleId: item.ruleId })
      continue
    }
    const canonical = { file, ruleId: item.ruleId, expressionHash: expressionHashValue }
    const key = exceptionKey(canonical)
    if (keys.has(key)) errors.push({ code: 'DUPLICATE_EXCEPTION', ...canonical })
    keys.add(key)
    normalized.push(canonical)
  }
  const actual = new Map(violations.map(item => [exceptionKey(item), item]))
  const applied = []
  const stale = []
  for (const item of normalized) {
    const match = actual.get(exceptionKey(item))
    if (match) applied.push(item)
    else stale.push({ code: 'STALE_EXCEPTION', ...item })
  }
  const suppressed = new Set(applied.map(exceptionKey))
  return { errors, applied, stale, suppressed }
}

export function scanInterfaceBoundary({ root = workspaceRoot, profile = releaseProfile, exceptionsPath = path.join(root, 'docs', 'interface-exceptions.json') } = {}) {
  const packageDirectories = releasePackageDirectories(root, profile)
  const violations = []
  const files = []
  for (const directory of packageDirectories) {
    const manifestPath = path.join(root, 'packages', directory, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const packageFiles = codeFiles(root, directory, manifest)
    files.push(...packageFiles)
    if (directory === 'runtime-interface') continue
    for (const file of packageFiles) scanFile(root, directory, file, violations)
  }
  const exceptionData = readExceptions(exceptionsPath)
  const exceptionState = validateExceptions(root, exceptionData.entries, violations)
  const unsuppressed = violations.filter(item => !exceptionState.suppressed.has(exceptionKey(item)))
  const errors = [...exceptionState.errors, ...exceptionState.stale]
  return {
    schemaVersion: 1,
    root: path.resolve(root),
    profile: profile.profile,
    packageDirectories,
    filesScanned: files.map(file => relativeFile(root, file)),
    violations,
    unsuppressed,
    errors,
    exceptions: {
      configured: exceptionData.entries.length,
      applied: exceptionState.applied,
      stale: exceptionState.stale,
      errors: exceptionState.errors,
    },
    passed: unsuppressed.length === 0 && errors.length === 0,
    summary: {
      files: files.length,
      violations: violations.length,
      suppressed: violations.length - unsuppressed.length,
      unsuppressed: unsuppressed.length,
      exceptionErrors: errors.length,
    },
  }
}

function printUsage() {
  process.stderr.write('Usage: node tools/check-interface-boundary.mjs [--root <workspace>] [--exceptions <file>]\n')
}

function cli(argv) {
  let root = workspaceRoot
  let exceptionsPath
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') root = path.resolve(argv[++index] ?? '')
    else if (argv[index] === '--exceptions') exceptionsPath = path.resolve(argv[++index] ?? '')
    else if (argv[index] === '--help' || argv[index] === '-h') { printUsage(); return 0 }
    else throw new Error(`UNKNOWN_ARGUMENT_${argv[index]}`)
  }
  const report = scanInterfaceBoundary({ root, exceptionsPath })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.stderr.write(`interface-boundary ${report.passed ? 'PASS' : 'FAIL'}: ${report.summary.unsuppressed} unsuppressed violations, ${report.summary.exceptionErrors} exception errors (${report.summary.files} files)\n`)
  return report.passed ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = cli(process.argv.slice(2)) } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`)
    process.exitCode = 2
  }
}
