// src/lib/engine/cred-crypto.ts — firm 자격증명 암호화.
// LEAD_ENC_KEY(리드 PII)와 키를 분리해 유출 반경을 절연한다. 포맷은 crypto.ts와 동일(v1:iv:tag:ct).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

function key(): Buffer {
  const b64 = process.env.CRED_ENC_KEY
  if (!b64) throw new Error('CRED_ENC_KEY is not set')
  const k = Buffer.from(b64, 'base64')
  if (k.length !== 32) throw new Error('CRED_ENC_KEY must be 32 bytes (base64)')
  return k
}

export function encryptCred(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':')
}

export function decryptCred(payload: string): string {
  const [v, ivB64, tagB64, ctB64] = payload.split(':')
  if (v !== 'v1') throw new Error('unknown payload version')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}
