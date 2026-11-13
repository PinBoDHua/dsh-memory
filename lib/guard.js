/**
 * dsh-memory 隐私护栏 Privacy guard.
 *
 * 密码/密钥/token 永不进入记忆：写入前做规则检测，命中即拒绝。
 * 这是硬护栏；「其他敏感信息先征得用户同意」由系统提示中的指引约束。
 * Credentials never enter memory: rule-based detection rejects writes.
 * The softer "ask before storing other sensitive info" rule lives in the
 * injected guidance.
 */
const SECRET_PATTERNS = [
  { label: '私钥块 private key block', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { label: 'API 密钥 API key (sk-…)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { label: 'AWS 访问密钥 AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'GitHub token', re: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  {
    label: '凭据赋值 credential assignment',
    re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential)s?\s*[:=]\s*["']?[^\s"']{6,}/i,
  },
  { label: '凭据赋值 credential assignment', re: /(?:密码|密钥|令牌|凭证|私钥)\s*[:：=]\s*\S{6,}/ },
  { label: 'Bearer 令牌 bearer token', re: /\bBearer\s+[A-Za-z0-9_\-.]{16,}/i },
  { label: '带口令连接串 connection string with password', re: /\b(?:mongodb|postgres|postgresql|mysql|redis|amqp|sqlserver|mssql):\/\/[^\s/:@]+:[^\s/@]+@/i },
]

/** 命中返回 { label }，否则返回 null。 */
export function detectSecret(text) {
  const value = String(text ?? '')
  for (const { label, re } of SECRET_PATTERNS) {
    if (re.test(value)) return { label }
  }
  return null
}
