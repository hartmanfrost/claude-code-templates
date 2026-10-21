import { expect, test } from 'claude-code/testing'
import {
  DEFAULT_REDACT,
  MAX_INPUT,
  compileCustomPatterns,
  describeCounts,
  entropy,
  prepareField,
  redact,
  scrubForLog,
  truncate,
} from '../hooks/redact.ts'
import type { RedactOptions } from '../hooks/redact.ts'

// Fake credentials are assembled from pieces so no literal in this file looks
// like a real one to a secret scanner.
const gh = 'ghp_' + 'A1b2'.repeat(9)
const ghPat = 'github_pat_' + '11ABCDEFG0'.repeat(6)
const anthropic = 'sk-ant-' + 'api03-' + 'Zx9Qw'.repeat(6)
const openai = 'sk-' + 'proj-' + 'Ab12Cd34'.repeat(4)
const typesafe = 'apikey_' + 'k3Y9mN2p'.repeat(3)
const awsId = 'AKIA' + 'IOSFODNN7EXAMPLE'
const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
const slack = 'xoxb-' + '123456789012-abcdefghij'
const google = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'
const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij1234567890'

const run = (text: string, over: Partial<RedactOptions> = {}) => redact(text, { ...DEFAULT_REDACT, ...over })
const out = (text: string, over: Partial<RedactOptions> = {}) => run(text, over).text

// --- blocks ------------------------------------------------------------------

test('a private key block is replaced whole, and the text around it stays', () => {
  const block = ['-----BEGIN ' + 'RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA1234', '-----END ' + 'RSA PRIVATE KEY-----'].join('\n')
  const result = run(`before\n${block}\nafter`)
  expect(result.text).toBe('before\n[REDACTED:private-key]\nafter')
  expect(result.counts['private-key']).toBe(1)
})

test('OpenSSH and PGP private key blocks are private keys too', () => {
  const ssh = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END ' + 'OPENSSH PRIVATE KEY-----'
  const pgp = '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----\nlQdGBF\n-----END ' + 'PGP PRIVATE KEY BLOCK-----'
  expect(out(ssh)).toBe('[REDACTED:private-key]')
  expect(out(pgp)).toBe('[REDACTED:private-key]')
})

test('age and PGP armored messages are redacted as armored blocks', () => {
  const age = '-----BEGIN ' + 'AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24\n-----END ' + 'AGE ENCRYPTED FILE-----'
  const pgp = '-----BEGIN ' + 'PGP MESSAGE-----\nhQEMA\n-----END ' + 'PGP MESSAGE-----'
  expect(out(age)).toBe('[REDACTED:armored-block]')
  expect(out(pgp)).toBe('[REDACTED:armored-block]')
})

test('a private key cut off before its END marker is redacted to the end of the text', () => {
  const text = 'keep this\n-----BEGIN ' + 'EC PRIVATE KEY-----\nMHcCAQEEIA' + 'x'.repeat(500)
  expect(out(text)).toBe('keep this\n[REDACTED:private-key]')
})

test('certificates and public keys are not secrets and stay', () => {
  const cert = '-----BEGIN ' + 'CERTIFICATE-----\nMIIB\n-----END ' + 'CERTIFICATE-----'
  const pub = '-----BEGIN ' + 'PUBLIC KEY-----\nMFkw\n-----END ' + 'PUBLIC KEY-----'
  expect(out(cert)).toBe(cert)
  expect(out(pub)).toBe(pub)
})

test('age secret keys and sops encrypted values are redacted', () => {
  expect(out('AGE-SECRET-KEY-1' + 'QQQQQQQQQQ'.repeat(6))).toBe('[REDACTED:age-secret-key]')
  expect(out('password: ENC[AES256_GCM,data:abc123==,iv:xyz,tag:tt,type:str]')).toBe('password: [REDACTED:sops-secret]')
})

// --- vendor tokens -----------------------------------------------------------

test('Anthropic, OpenAI and TypeSafe keys are redacted by name', () => {
  expect(out(`key ${anthropic} end`)).toBe('key [REDACTED:anthropic-key] end')
  expect(out(`key ${openai} end`)).toBe('key [REDACTED:openai-key] end')
  expect(out(`key ${typesafe} end`)).toBe('key [REDACTED:typesafe-key] end')
})

test('GitHub tokens of every prefix are redacted', () => {
  expect(out(`t=${gh}`)).toContain('[REDACTED:github-token]')
  expect(out(ghPat)).toBe('[REDACTED:github-token]')
  for (const prefix of ['gho_', 'ghu_', 'ghs_', 'ghr_']) {
    expect(out(prefix + 'a1B2'.repeat(9))).toBe('[REDACTED:github-token]')
  }
})

test('AWS access key ids and secret access key assignments are redacted', () => {
  expect(out(`id ${awsId}`)).toBe('id [REDACTED:aws-access-key]')
  expect(out(`ASIA${'ABCDEFGHJKLMNPQR'}`)).toBe('[REDACTED:aws-access-key]')
  expect(out(`aws_secret_access_key = ${awsSecret}`)).toBe('aws_secret_access_key = [REDACTED:aws-secret]')
  expect(out(`aws_secret_access_key="${awsSecret}"`)).toBe('aws_secret_access_key="[REDACTED:aws-secret]')
})

test('Slack, Google and JWT tokens are redacted', () => {
  expect(out(slack)).toBe('[REDACTED:slack-token]')
  expect(out(`k=${google}`)).toBe('k=[REDACTED:google-api-key]')
  expect(out(`jwt ${jwt}`)).toBe('jwt [REDACTED:jwt]')
})

test('look-alikes that are not credentials stay', () => {
  for (const text of [
    'sk-learn is a library',
    'the disk-usage-report-generator-daemon restarted',
    'sk-learn-is-a-python-library-with-a-long-hyphenated-name',
    'ghp_short',
    'apikey_x',
    'xoxo-hugs-and-kisses',
    'AKIAIOSFODNN7',
    'eyJhbGciOiJIUzI1NiJ9 alone',
  ]) {
    expect(out(text)).toBe(text)
  }
})

// --- headers, URLs, flags ------------------------------------------------------

test('Bearer and Basic values are redacted and the scheme word stays', () => {
  expect(out('Authorization: Bearer abc123def456ghi789jkl012')).toBe('Authorization: Bearer [REDACTED:bearer-token]')
  expect(out('Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==')).toBe('Authorization: Basic [REDACTED:bearer-token]')
})

test('prose that starts with Bearer or Basic is not an auth header', () => {
  expect(out('Bearer token authentication is described here')).toBe('Bearer token authentication is described here')
  expect(out('Basic configurationmanagement notes')).toBe('Basic configurationmanagement notes')
})

test('credentials in a URL are redacted and the host is kept', () => {
  expect(out('postgres://admin:hunter2pass@db.example.com:5432/app')).toBe(
    'postgres://[REDACTED:url-credentials]@db.example.com:5432/app',
  )
  expect(out('https://example.com:8080/path user@example.com')).toBe('https://example.com:8080/path user@example.com')
})

test('secret command-line flags lose their value', () => {
  expect(out('tool --password hunter2xyz --verbose')).toBe('tool --password [REDACTED:cli-secret] --verbose')
  expect(out('tool --api-key=abcd1234efgh')).toBe('tool --api-key=[REDACTED:cli-secret]')
  expect(out('tool --token --verbose')).toBe('tool --token --verbose')
})

// --- generic assignments -----------------------------------------------------------

test('secret assignments in env, shell, yaml, json and code forms are redacted', () => {
  expect(out('API_KEY=abc123def456ghi')).toBe('API_KEY=[REDACTED:secret-assignment]')
  expect(out('export SECRET_TOKEN="s3cr3t-value-here"')).toBe('export SECRET_TOKEN="[REDACTED:secret-assignment]"')
  expect(out('{"password": "hunter2hunter"}')).toBe('{"password": "[REDACTED:secret-assignment]"}')
  expect(out('password: hunter22abc')).toBe('password: [REDACTED:secret-assignment]')
  expect(out('DB_PASSWORD=supersecretvalue')).toBe('DB_PASSWORD=[REDACTED:secret-assignment]')
  expect(out("client_secret = 'abcd'")).toBe("client_secret = '[REDACTED:secret-assignment]'")
  expect(out('x-api-key: 9f8e7d6c5b4a3f2e')).toBe('x-api-key: [REDACTED:secret-assignment]')
  expect(out('private_key: "not-a-real-key-value"')).toBe('private_key: "[REDACTED:secret-assignment]"')
})

test('ordinary code that merely mentions a secret word is not redacted', () => {
  for (const text of [
    'const token = getToken()',
    'password: string',
    'password: string,',
    'let secret: string = ""',
    'token = process.env.TOKEN',
    'api_key = os.environ["API_KEY"]',
    'const passwordLabel = "Enter your password"',
    'max_tokens: 4096',
    'tokenizer: "bert-base-uncased"',
    'keyboard: "qwerty123"',
    'sortKey: "name"',
    'password: ${PASSWORD}',
    'API_KEY=$API_KEY',
    'password = input("Password: ")',
    'secret: <your-secret-here>',
    'token: str = Field(...)',
    'password: SecretStr',
    'if (!token) throw new Error("missing")',
  ]) {
    expect(out(text)).toBe(text)
  }
})

test('a value that is already a placeholder is not redacted twice', () => {
  const once = out('API_KEY=abc123def456ghi')
  expect(out(once)).toBe(once)
})

// --- entropy blobs --------------------------------------------------------------------

test('long random hex and base64 blobs are redacted', () => {
  const hex = '3f9a1c7e5b2d8046a1f3c9e7b5d20486'.repeat(2)
  expect(out(`key ${hex} end`)).toBe('key [REDACTED:high-entropy-hex] end')
  const b64 = 'q8Zr3Tn7Xw1Vb9Kd4Lf0Hs6Jm2Gp5Ac8Ye3Ui7Ro1Pt4Nx9Wz2Bv6Cq0Dj5Fk'
  expect(out(`blob ${b64} end`)).toBe('blob [REDACTED:high-entropy-base64] end')
})

test('git hashes, hashes of lockfiles, paths and long identifiers are left alone', () => {
  for (const text of [
    'commit 100b8bcbb2800b24cb33b6d5e5606c302fff198c',
    'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'this-is-a-very-long-kebab-case-identifier-used-in-config-files-and-more',
    'someVeryLongCamelCaseIdentifierNameThatKeepsGoingAndGoing2',
    '/usr/local/lib/python3.12/site-packages/numpy/core/_multiarray_umath',
    'a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6',
    '0000000000000000000000000000000000000000000000000000000000000000',
  ]) {
    expect(out(text)).toBe(text)
  }
})

test('entropy separates random text from prose', () => {
  expect(entropy('aaaa')).toBe(0)
  expect(entropy('q8Zr3Tn7Xw1Vb9Kd4Lf0Hs6Jm2Gp5Ac8Ye3Ui7Ro1Pt4Nx9Wz2Bv6Cq0Dj5Fk') > 5).toBe(true)
})

// --- optional detectors ---------------------------------------------------------------------

test('emails, addresses and home paths are off by default', () => {
  const text = 'mail alice@example.com from 10.0.0.12 in /home/alice/work'
  expect(out(text)).toBe(text)
})

test('emails can be switched on', () => {
  expect(out('mail alice@example.com now', { emails: true })).toBe('mail [REDACTED:email] now')
  expect(out('the @decorator and a@b', { emails: true })).toBe('the @decorator and a@b')
})

test('IPv4 and IPv6 addresses can be switched on, and a time of day is not one', () => {
  expect(out('host 192.168.1.20 up', { ips: true })).toBe('host [REDACTED:ipv4] up')
  expect(out('host 2001:db8:85a3::8a2e:370:7334 up', { ips: true })).toContain('[REDACTED:ipv6]')
  expect(out('addr fe80::1 up', { ips: true })).toBe('addr [REDACTED:ipv6] up')
  expect(out('at 12:30:45 sharp', { ips: true })).toBe('at 12:30:45 sharp')
  expect(out('version 1.2.3 and 300.1.1.1', { ips: true })).toBe('version 1.2.3 and 300.1.1.1')
})

test('home directories become ~ when switched on', () => {
  expect(out('see /home/alice/proj/x.ts', { homePaths: true })).toBe('see ~/proj/x.ts')
  expect(out('see /Users/bob/x', { homePaths: true })).toBe('see ~/x')
  expect(out('see C:\\Users\\bob\\x', { homePaths: true })).toBe('see ~\\x')
  expect(out('see /homework/x and /var/home', { homePaths: true })).toBe('see /homework/x and /var/home')
})

// --- the switch, custom patterns, counts ------------------------------------------------------

test('the master switch turns every built-in detector off but still bounds the input', () => {
  const text = `key ${gh}`
  expect(out(text, { enabled: false })).toBe(text)
  expect(out('x'.repeat(MAX_INPUT + 500), { enabled: false }).length).toBe(MAX_INPUT)
})

test('custom patterns replace their matches with a typed placeholder', () => {
  const { patterns, errors } = compileCustomPatterns('ACME-[0-9]{6}\nproject-(?:alpha|beta)')
  expect(errors.length).toBe(0)
  const result = run('ticket ACME-123456 on project-beta', { custom: patterns })
  expect(result.text).toBe('ticket [REDACTED:custom] on [REDACTED:custom]')
  expect(result.counts.custom).toBe(2)
})

test('custom patterns can be given as a JSON array', () => {
  const { patterns, errors } = compileCustomPatterns('["foo-[0-9]+", "bar"]')
  expect(errors.length).toBe(0)
  expect(patterns.length).toBe(2)
})

test('an invalid custom pattern is reported by position and skipped, the rest still work', () => {
  const { patterns, errors } = compileCustomPatterns('([\nvalid-[0-9]+')
  expect(patterns.length).toBe(1)
  expect(errors.length).toBe(1)
  expect(errors[0]).toContain('#1')
  expect(errors[0]).not.toContain('([')
})

test('patterns that backtrack badly or match nothing are refused', () => {
  for (const source of ['(a+)+$', '(.*)*x', '(x+x+)+y', '(a)\\1', '.*', 'a*']) {
    const { patterns, errors } = compileCustomPatterns(source)
    expect(patterns.length).toBe(0)
    expect(errors.length).toBe(1)
  }
  expect(compileCustomPatterns('x'.repeat(201)).patterns.length).toBe(0)
  expect(compileCustomPatterns('[1,2').errors.length).toBe(1)
  expect(compileCustomPatterns('').errors.length).toBe(0)
})

test('counts are per type and never carry a value', () => {
  const result = run(`a ${gh} b ${gh} c ${awsId}`)
  expect(result.counts['github-token']).toBe(2)
  expect(result.counts['aws-access-key']).toBe(1)
  const line = describeCounts(result.counts)
  expect(line).toBe('3 redacted (github-token ×2, aws-access-key ×1)')
  expect(line).not.toContain('ghp_')
  expect(describeCounts({})).toBe('')
})

// --- truncation -------------------------------------------------------------------------------------

test('redaction runs before truncation, so a cut never exposes half a secret', () => {
  const text = 'x'.repeat(990) + ` ${gh} ` + 'y'.repeat(500)
  const cut = prepareField(text, 1000, DEFAULT_REDACT)
  expect(cut.text).not.toContain('ghp_')
  expect(cut.text).not.toContain('A1b2')
  expect(cut.counts['github-token']).toBe(1)
})

test('a cut inside a placeholder drops the placeholder rather than leaving half of it', () => {
  const cut = truncate('x'.repeat(10) + '[REDACTED:github-token] tail', 20)
  expect(cut.startsWith('xxxxxxxxxx…')).toBe(true)
  expect(cut).not.toContain('[REDACTED')
})

test('truncation says how much it dropped and leaves short text alone', () => {
  expect(truncate('short', 100)).toBe('short')
  expect(truncate('abcdefghij', 4)).toBe('abcd…[+6 chars]')
})

// --- safety ---------------------------------------------------------------------------------------------

test('adversarial input finishes quickly', () => {
  const started = Date.now()
  const inputs = [
    'sk-'.repeat(30000),
    ('-----BEGIN ' + 'X PRIVATE KEY----- ').repeat(3000),
    'a'.repeat(MAX_INPUT),
    'password=' + 'a'.repeat(MAX_INPUT),
    'key_' + 'a-'.repeat(50000),
    'ENC[AES256_GCM,' + 'a'.repeat(MAX_INPUT),
    'Bearer ' + 'a'.repeat(MAX_INPUT),
    ('a:'.repeat(50000)),
    ('1.'.repeat(50000)),
    'x@' + 'a.'.repeat(50000),
    'https://' + 'a:'.repeat(50000),
    '/home/' + 'a'.repeat(MAX_INPUT),
  ]
  for (const text of inputs) {
    redact(text, { ...DEFAULT_REDACT, emails: true, ips: true, homePaths: true })
  }
  expect(Date.now() - started < 8000).toBe(true)
})

test('error text is scrubbed before it is logged, whatever the settings', () => {
  const line = scrubForLog(`fetch failed for key ${gh} at host`)
  expect(line).not.toContain('ghp_')
  expect(line).toContain('[REDACTED:github-token]')
  expect(scrubForLog('x'.repeat(500)).length).toBe(201)
})
