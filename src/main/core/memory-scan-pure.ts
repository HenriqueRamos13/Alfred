/**
 * Anti-poisoning scanner for memory TEXT (Phase 6 stage 4). Generalises the core
 * of `scanWidgetHtml` (widget-html-pure.ts) to plain memory entries: before any
 * agent- or auto-review-authored text enters the vault (and thus, later, the
 * system prompt), it is scanned for prompt-injection, credential-exfil, and
 * invisible/bidi/homoglyph Unicode. PURE + string-only so it is unit-tested and
 * runs at write time.
 *
 *   dangerous  → the write is REFUSED with the findings.
 *   suspicious → the write is accepted but flagged with a warning.
 *   ok         → silently accepted.
 *
 * Docs are advisory; this is a heuristic, not a boundary against an adversarial
 * model — it stops the poisoned-note → poisoned-prompt feedback loop, not a
 * determined attacker.
 */

import { INVISIBLE_UNICODE_RE, HOMOGLYPH_RE } from './widget-html-pure.ts';

export type MemoryRisk = 'ok' | 'suspicious' | 'dangerous';
export interface MemoryScan {
  risk: MemoryRisk;
  findings: string[];
}

/** Prompt-injection: attempts to override instructions or forge role framing. */
const INJECTION_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|messages?|rules?|context)/i,
    label: 'prompt-injection: "ignore previous instructions"',
  },
  { re: /disregard\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)/i, label: 'prompt-injection: "disregard previous"' },
  { re: /forget\s+(everything|all|your|the\s+(previous|prior))/i, label: 'prompt-injection: "forget everything"' },
  { re: /you\s+are\s+now\s+(a\b|an\b|the\b|no\b)/i, label: 'prompt-injection: role reassignment ("you are now …")' },
  { re: /\bnew\s+(system\s+)?(instructions?|prompt|directive)s?\s*:/i, label: 'prompt-injection: injected new instructions' },
  { re: /^\s*system\s*:/im, label: 'prompt-injection: forged "system:" role marker' },
  { re: /<\s*\/?\s*(system|assistant|user)\s*>/i, label: 'prompt-injection: forged role tag' },
  { re: /\b(override|bypass|ignore)\b[^.\n]{0,40}\b(instructions?|rules?|safety|guardrails?|governance|approvals?)/i, label: 'prompt-injection: override/bypass safety' },
];

/** Credential-exfil: secrets embedded in the note, or instructions to leak them. */
const EXFIL_PATTERNS: { re: RegExp; label: string }[] = [
  {
    re: /\b(send|post|upload|exfiltrate|leak|e-?mail|transmit|forward|curl|wget)\b[^.\n]{0,60}\b(password|secret|api[\s_-]?key|token|credential|private\s+key|\.env)/i,
    label: 'credential-exfil: instruction to send/leak a secret',
  },
  { re: /\bsk-[A-Za-z0-9]{16,}\b/, label: 'credential-exfil: embedded API key (sk-…)' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'credential-exfil: embedded AWS access key' },
  { re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/, label: 'credential-exfil: embedded private key' },
  { re: /\b(curl|wget|Invoke-WebRequest)\b[^\n]{0,80}https?:\/\//i, label: 'credential-exfil: shell egress to a URL' },
];

/** Suspicious but sandbox-safe: hidden characters, stray script/role markers. */
const SUSPICIOUS_PATTERNS: { re: RegExp; label: string }[] = [
  { re: INVISIBLE_UNICODE_RE, label: 'invisible/bidi Unicode control characters' },
  { re: HOMOGLYPH_RE, label: 'Cyrillic/Greek homoglyph characters' },
  { re: /<script(\s|>)/i, label: 'inline <script> in memory text' },
];

/**
 * Heuristic scan of memory text. Any dangerous pattern (injection or exfil) makes
 * the whole entry `dangerous`; otherwise any suspicious pattern makes it
 * `suspicious`; else `ok`. Findings list every matched label. Pure.
 */
export function scanMemoryText(text: unknown): MemoryScan {
  const s = typeof text === 'string' ? text : '';
  const findings: string[] = [];
  for (const { re, label } of [...INJECTION_PATTERNS, ...EXFIL_PATTERNS]) if (re.test(s)) findings.push(label);
  const dangerous = findings.length > 0;
  for (const { re, label } of SUSPICIOUS_PATTERNS) if (re.test(s)) findings.push(label);
  const risk: MemoryRisk = dangerous ? 'dangerous' : findings.length ? 'suspicious' : 'ok';
  return { risk, findings };
}
