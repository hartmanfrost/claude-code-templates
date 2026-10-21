/**
 * jev-model-router — best-effort scrubbing of text before it leaves the
 * machine.
 *
 * Pure, no `$`, no I/O. Everything the router sends to TypeSafe or the AI
 * Gateway (the subagent prompt, its description, its agent type, or a typed
 * prompt) goes through `prepareField` first: secrets are replaced with typed
 * placeholders such as `[REDACTED:github-token]`, and only then is the text
 * cut to its size limit, so a truncation can never expose half a secret.
 *
 * THIS IS BEST EFFORT. A pattern list cannot know every secret, and a secret
 * written in prose ("the password is correct horse") has no shape to match.
 * The README says so; do not read a clean result as a guarantee.
 *
 * Linear time. Every built-in detector is either a fixed literal prefix with
 * bounded, non-overlapping character classes, or a plain `indexOf` scan, so
 * no input makes the engine backtrack catastrophically. The input is also cut
 * to MAX_INPUT before any pattern runs. User patterns (`redactPatterns`)
 * cannot be proven linear in JavaScript; the input bound is the only guard
 * for those, plus a heuristic that refuses the obvious nested-quantifier
 * shapes.
 *
 * Matched values are never logged or returned: callers only ever see counts
 * per type.
 */

/** Characters scanned per field. Anything past it is dropped, not sent. */
export const MAX_INPUT = 100_000

/** Longest custom pattern accepted, and how many. */
const MAX_PATTERN_LENGTH = 200
const MAX_CUSTOM_PATTERNS = 20

export interface RedactOptions {
  /** Master switch for the built-in detectors and the custom patterns. */
  enabled: boolean
  emails: boolean
  ips: boolean
  homePaths: boolean
  custom: RegExp[]
}

export const DEFAULT_REDACT: RedactOptions = {
  enabled: true,
  emails: false,
  ips: false,
  homePaths: false,
  custom: [],
}

/** Placeholders counted per detector type. */
export type RedactCounts = Record<string, number>

export function placeholder(type: string): string {
  return `[REDACTED:${type}]`
}

function bump(counts: RedactCounts, type: string): void {
  counts[type] = (counts[type] ?? 0) + 1
}

/** Shannon entropy in bits per character. */
export function entropy(text: string): number {
  if (text.length === 0) return 0
  const seen = new Map<string, number>()
  for (const ch of text) seen.set(ch, (seen.get(ch) ?? 0) + 1)
  let bits = 0
  for (const n of seen.values()) {
    const p = n / text.length
    bits -= p * Math.log2(p)
  }
  return bits
}

/**
 * Armored blocks, found with `indexOf` rather than a lazy regex: a lazy
 * `[\s\S]*?` per BEGIN marker is quadratic on many unterminated markers.
 * A block with no END marker is redacted to the end of the text, because
 * the input may have been cut inside it.
 */
function redactBlocks(text: string, counts: RedactCounts): string {
  const BEGIN = '-----BEGIN '
  let out = ''
  let pos = 0
  for (;;) {
    const start = text.indexOf(BEGIN, pos)
    if (start === -1) break
    const labelStart = start + BEGIN.length
    // The header's closing dashes must be near; searching a bounded window
    // keeps a pile of stray BEGIN markers linear.
    const window = text.slice(labelStart, labelStart + 80)
    const rel = window.indexOf('-----')
    const label = rel === -1 ? '' : window.slice(0, rel)
    let type: string | null = null
    if (/^[A-Z0-9 ]{1,60}$/.test(label)) {
      if (label.endsWith('PRIVATE KEY') || label.endsWith('PRIVATE KEY BLOCK')) type = 'private-key'
      else if (label === 'PGP MESSAGE' || label === 'AGE ENCRYPTED FILE') type = 'armored-block'
    }
    if (!type) {
      out += text.slice(pos, labelStart)
      pos = labelStart
      continue
    }
    const headerEnd = labelStart + rel + 5
    const endMarker = `-----END ${label}-----`
    const endAt = text.indexOf(endMarker, headerEnd)
    const stop = endAt === -1 ? text.length : endAt + endMarker.length
    out += text.slice(pos, start) + placeholder(type)
    bump(counts, type)
    pos = stop
  }
  return out + text.slice(pos)
}

/** Replaces every match of `re` by a placeholder, unless `keep` vetoes it. */
function sub(
  text: string,
  re: RegExp,
  type: string,
  counts: RedactCounts,
  render?: (match: string, groups: string[]) => string | null,
): string {
  return text.replace(re, (match: string, ...rest: unknown[]) => {
    // The last two arguments are the offset and the whole input, not groups.
    const groups = rest.slice(0, rest.length - 2).map((g) => (typeof g === 'string' ? g : ''))
    const replacement = render ? render(match, groups) : placeholder(type)
    if (replacement === null) return match
    bump(counts, type)
    return replacement
  })
}

// ---- detectors -----------------------------------------------------------

const ANTHROPIC_KEY = /\bsk-ant-[A-Za-z0-9_-]{20,}/g
// The bounded lookahead requires a digit, which every real key has and the
// word "sk-learn-style-names" does not.
const OPENAI_KEY = /\bsk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]{0,200}\d)[A-Za-z0-9_-]{20,}/g
const TYPESAFE_KEY = /\bapikey_[A-Za-z0-9_-]{16,}/g
const GITHUB_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})/g
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
const AWS_SECRET = /(aws_secret_access_key["']?[ \t]{0,3}[:=][ \t]{0,3}["']?)[A-Za-z0-9/+=]{40}["']?/gi
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}/g
const GOOGLE_KEY = /\bAIza[A-Za-z0-9_-]{35}/g
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
const AGE_SECRET_KEY = /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/g
const SOPS_VALUE = /ENC\[AES256_GCM,[^\]]{1,4000}\]/g
const AUTH_VALUE = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{20,})/gi
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([^\s/@:'"]{1,100}):([^\s/@'"]{1,200})@/gi
const URL_TOKEN_USER = /\b([a-z][a-z0-9+.-]{1,20}:\/\/)([A-Za-z0-9._~-]{24,200})@/gi
const CLI_SECRET_FLAG =
  /(--(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|auth[-_]?token)(?:=|[ \t]+)["']?)([^\s"'$-][^\s"']{3,200})/gi

/**
 * `NAME = value`, `NAME: value`, `"name": "value"`, `export NAME=value`.
 *
 * The name must END in a secret word (optionally plural or numbered), so
 * `tokenizer`, `passwordless`, `keyCode` and `monkey` never match; a bare
 * `key` counts only behind a word that makes it a credential (`api_key`,
 * `privateKey`, `ssh-key`). The prefix is bounded, which keeps the lazy
 * quantifier linear.
 */
const ASSIGNMENT = new RegExp(
  '\\b([A-Za-z0-9_.-]{0,40}?(?:' +
    '(?:api|access|private|secret|auth|encryption|signing|master|ssh|license|client|app|session|service)[_-]?key|' +
    'secret|token|password|passwd|pwd|credentials?' +
    ')s?(?:[_-]?\\d{1,3})?)' +
    '["\']?([ \\t]{0,3}(?::=|=>|=|:)[ \\t]{0,3})' +
    '("[^"\\n]{1,500}"|\'[^\'\\n]{1,500}\'|[^\\s"\',;)}\\]]{1,500})',
  'gi',
)

/** Counters and sizes, not credentials: `max_tokens`, `inputTokens`. */
const NON_SECRET_NAME = /(?:max|min|num|total|input|output|prompt|completion|context|cache|reasoning|n)[_-]?tokens?\d*$/i

/** What a bare (unquoted) value that is a type, a reference or a call looks like. */
const NON_VALUE_WORD =
  /^(?:string|number|boolean|bool|any|unknown|never|null|undefined|nil|none|true|false|void|str|int|bytes|secretstr|optional|required|ref|process|os|env|config|settings|this|self|args|params|opts|options|input|req|request|ctx|getenv|require)\b/i

function looksLikeSecretValue(sep: string, raw: string): boolean {
  const quoted = raw.startsWith('"') || raw.startsWith("'")
  const v = quoted ? raw.slice(1, -1) : raw
  if (v.length < (quoted ? 4 : 6)) return false
  // Template and variable references, and values already masked.
  if (/^(?:\$|%|<|\{\{|@|#|\[REDACTED:)/.test(v)) return false
  if (/^(?:x{3,}|\*{3,}|\.{3,}|_{3,}|-{3,}|changeme|your[_-]|example|placeholder|redacted)/i.test(v)) return false
  if (quoted) {
    // Prose ("Enter your password") is a label, not a secret.
    if (/^[A-Za-z' ,.!?-]+$/.test(v) && (v.match(/ /g) ?? []).length >= 2) return false
    return true
  }
  if (v.includes('(')) return false // a call
  if (NON_VALUE_WORD.test(v)) return false
  if (/^[A-Za-z_][A-Za-z_.]*$/.test(v)) {
    // A bare word: `password: string` in a type, `token = loadToken` in code.
    // Only the tight env-file form `NAME=word` is taken for a secret.
    return sep === '=' && v.length >= 8
  }
  return v.length >= 8
}

const HEX_BLOB = /(?<![A-Za-z0-9+/_=-])[0-9a-fA-F]{64,}(?![A-Za-z0-9+/_=-])/g
const BASE64_BLOB = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/_=-])/g

function looksLikeBase64Secret(v: string): boolean {
  if (!/[A-Z]/.test(v) || !/[a-z]/.test(v) || !/\d/.test(v)) return false
  // File paths and kebab-case identifiers are long and "random" too.
  const slashes = (v.match(/\//g) ?? []).length
  const dashes = (v.match(/-/g) ?? []).length
  if (slashes > v.length / 16 || dashes > v.length / 10) return false
  // A random string has digits throughout; a long identifier has one or two.
  const digits = (v.match(/\d/g) ?? []).length
  if (digits < Math.max(2, v.length / 20)) return false
  return entropy(v) >= 4.3
}

const EMAIL = /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,24}\b/g
const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g
const IPV6_FULL = /(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])/g
const IPV6_COMPRESSED =
  /(?<![0-9A-Fa-f:])(?:(?:[0-9A-Fa-f]{1,4}:){1,7}(?::[0-9A-Fa-f]{1,4}){1,7}|(?:[0-9A-Fa-f]{1,4}:){1,7}:|:(?::[0-9A-Fa-f]{1,4}){1,7})(?![0-9A-Fa-f:])/g
const HOME_UNIX = /(?<![\w.-])\/(?:home|Users)\/[A-Za-z0-9._-]{1,64}/g
const HOME_WINDOWS = /\b[A-Za-z]:\\Users\\[^\\\s]{1,64}/g

/**
 * Scrubs `text`. Order matters: specific, typed detectors first, so a token
 * is named for what it is; the generic ones (assignments, entropy blobs) see
 * what is left. Custom patterns run first of all, on the original text.
 */
export function redact(text: string, options: RedactOptions): { text: string; counts: RedactCounts } {
  const counts: RedactCounts = {}
  let out = text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) : text
  if (!options.enabled) return { text: out, counts }

  for (const re of options.custom) {
    out = sub(out, re, 'custom', counts)
  }

  out = redactBlocks(out, counts)
  out = sub(out, AGE_SECRET_KEY, 'age-secret-key', counts)
  out = sub(out, SOPS_VALUE, 'sops-secret', counts)
  out = sub(out, ANTHROPIC_KEY, 'anthropic-key', counts)
  out = sub(out, OPENAI_KEY, 'openai-key', counts)
  out = sub(out, TYPESAFE_KEY, 'typesafe-key', counts)
  out = sub(out, GITHUB_TOKEN, 'github-token', counts)
  out = sub(out, AWS_ACCESS_KEY, 'aws-access-key', counts)
  out = sub(out, AWS_SECRET, 'aws-secret', counts, (_m, g) => `${g[0]}${placeholder('aws-secret')}`)
  out = sub(out, SLACK_TOKEN, 'slack-token', counts)
  out = sub(out, GOOGLE_KEY, 'google-api-key', counts)
  out = sub(out, JWT, 'jwt', counts)
  out = sub(out, URL_CREDENTIALS, 'url-credentials', counts, (_m, g) => `${g[0]}${placeholder('url-credentials')}@`)
  out = sub(out, URL_TOKEN_USER, 'url-credentials', counts, (m, g) =>
    /\d/.test(g[1] ?? '') ? `${g[0]}${placeholder('url-credentials')}@` : null,
  )
  out = sub(out, AUTH_VALUE, 'bearer-token', counts, (_m, g) => {
    const value = g[2] ?? ''
    // `Basic authentication-methods...` is prose; a credential has a digit
    // or is long and mixed-case.
    const secret = /\d/.test(value) || (value.length >= 32 && /[A-Z]/.test(value) && /[a-z]/.test(value))
    return secret ? `${g[0]}${g[1]}${placeholder('bearer-token')}` : null
  })
  out = sub(out, CLI_SECRET_FLAG, 'cli-secret', counts, (_m, g) => `${g[0]}${placeholder('cli-secret')}`)
  out = sub(out, ASSIGNMENT, 'secret-assignment', counts, (m, g) => {
    const name = g[0] ?? ''
    const sep = g[1] ?? ''
    const raw = g[2] ?? ''
    if (NON_SECRET_NAME.test(name)) return null
    if (!looksLikeSecretValue(sep, raw)) return null
    const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : ''
    // Keep everything before the value exactly as written.
    const head = m.slice(0, m.length - raw.length)
    return `${head}${quote}${placeholder('secret-assignment')}${quote}`
  })
  out = sub(out, HEX_BLOB, 'high-entropy-hex', counts, (m) => (entropy(m) >= 3 ? placeholder('high-entropy-hex') : null))
  out = sub(out, BASE64_BLOB, 'high-entropy-base64', counts, (m) =>
    looksLikeBase64Secret(m) ? placeholder('high-entropy-base64') : null,
  )

  if (options.emails) out = sub(out, EMAIL, 'email', counts)
  if (options.ips) {
    out = sub(out, IPV4, 'ipv4', counts)
    out = sub(out, IPV6_FULL, 'ipv6', counts, (m) =>
      // `12:30:45` is a time, not an address: a v6 address has a letter or `::`.
      /[A-Fa-f]/.test(m) ? placeholder('ipv6') : null,
    )
    out = sub(out, IPV6_COMPRESSED, 'ipv6', counts)
  }
  if (options.homePaths) {
    out = sub(out, HOME_UNIX, 'home-path', counts, () => '~')
    out = sub(out, HOME_WINDOWS, 'home-path', counts, () => '~')
  }
  return { text: out, counts }
}

/**
 * Cuts `text` to `max` characters without leaving half a placeholder, and
 * says how much was dropped.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  let cut = text.slice(0, max)
  const open = cut.lastIndexOf('[REDACTED:')
  if (open !== -1 && cut.indexOf(']', open) === -1) cut = cut.slice(0, open)
  return `${cut}…[+${text.length - cut.length} chars]`
}

/** Redacts first, then truncates: the only order that is safe. */
export function prepareField(
  text: string,
  max: number,
  options: RedactOptions,
): { text: string; counts: RedactCounts } {
  const redacted = redact(text, options)
  return { text: truncate(redacted.text, max), counts: redacted.counts }
}

export function mergeCounts(into: RedactCounts, from: RedactCounts): RedactCounts {
  for (const [type, n] of Object.entries(from)) into[type] = (into[type] ?? 0) + n
  return into
}

/** `3 redacted (github-token ×2, email ×1)`, or an empty string for none. */
export function describeCounts(counts: RedactCounts): string {
  const entries = Object.entries(counts).filter(([, n]) => n > 0)
  if (entries.length === 0) return ''
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  return `${total} redacted (${entries.map(([type, n]) => `${type} ×${n}`).join(', ')})`
}

/**
 * A line safe to log: the built-in secret detectors always run, whatever the
 * `redactSensitive` setting, and the result is cut short. Used for error
 * strings that could echo a request.
 */
export function scrubForLog(text: string, max = 200): string {
  const scrubbed = redact(text, { ...DEFAULT_REDACT, enabled: true }).text
  return scrubbed.length > max ? `${scrubbed.slice(0, max)}…` : scrubbed
}

/** Shapes that make a backtracking engine blow up: a quantified group holding a quantifier. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]|\\[1-9]/

/**
 * Compiles the user's `redactPatterns`: a JSON array of strings, or one
 * pattern per line. An invalid or dangerous pattern is skipped and named by
 * its position, never by its text.
 */
export function compileCustomPatterns(raw: unknown): { patterns: RegExp[]; errors: string[] } {
  const patterns: RegExp[] = []
  const errors: string[] = []
  let sources: string[] = []
  if (Array.isArray(raw)) {
    sources = raw.filter((p): p is string => typeof p === 'string')
  } else if (typeof raw === 'string' && raw.trim()) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed)
        if (Array.isArray(parsed)) sources = parsed.filter((p): p is string => typeof p === 'string')
        else errors.push('redactPatterns: expected a JSON array of strings')
      } catch {
        errors.push('redactPatterns: not valid JSON; use a JSON array of strings or one regex per line')
      }
    } else {
      sources = trimmed.split(/\r?\n/).filter((line) => line.trim())
    }
  }
  sources.forEach((source, i) => {
    const n = i + 1
    if (patterns.length >= MAX_CUSTOM_PATTERNS) {
      if (n === MAX_CUSTOM_PATTERNS + 1) errors.push(`redactPatterns: only the first ${MAX_CUSTOM_PATTERNS} patterns are used`)
      return
    }
    if (source.length > MAX_PATTERN_LENGTH) {
      errors.push(`redactPatterns #${n}: longer than ${MAX_PATTERN_LENGTH} characters, skipped`)
      return
    }
    if (NESTED_QUANTIFIER.test(source)) {
      errors.push(`redactPatterns #${n}: nested quantifier or backreference (backtracking risk), skipped`)
      return
    }
    try {
      const re = new RegExp(source, 'g')
      // A pattern that matches the empty string would replace between every character.
      if (re.test('')) {
        errors.push(`redactPatterns #${n}: matches the empty string, skipped`)
        return
      }
      re.lastIndex = 0
      patterns.push(re)
    } catch {
      errors.push(`redactPatterns #${n}: not a valid regular expression, skipped`)
    }
  })
  return { patterns, errors }
}
