// src/lib/engine/naver/signature.ts
import { createHmac } from 'node:crypto'

// 서명 페이로드는 쿼리 제외 path — `{timestamp}.{method}.{path}` → HMAC-SHA256 → base64.
// 공식 문서(https://naver.github.io/searchad-apidoc/#/guides)는 SPA라 WebFetch로 본문을
// 렌더링하지 못했으나, 네이버가 공식 배포하는 참조 구현
// github.com/naver/searchad-apidoc/blob/master/python-sample/examples/signaturehelper.py
// 로 페이로드 형식·해시·인코딩을 대조 확인함(VERIFY 2026-08-02, 출처: 위 GitHub 경로).
// message = f"{timestamp}.{method}.{uri}"; hmac.new(secret, message, sha256) → base64(digest)
export function naverSignature(timestampMs: string, method: string, path: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${method}.${path}`).digest('base64')
}
