/**
 * Tuya IoT API 연동 모듈
 * 락프로 H5000 도어락 제어
 * Data Center: Western America (openapi.tuyaus.com)
 */

const crypto = require('crypto');

const TUYA_BASE_URL    = 'https://openapi.tuyaus.com';
const ACCESS_ID        = process.env.TUYA_ACCESS_ID     || '';
const ACCESS_SECRET    = process.env.TUYA_ACCESS_SECRET || '';
const DEFAULT_DEVICE   = process.env.TUYA_DEVICE_ID     || '';

// 토큰 캐시 (만료 1분 전에 갱신)
let tokenCache = { token: null, expireAt: 0 };

// ── 서명 생성 ──────────────────────────────────────────────────
function makeSign(method, path, body, token, timestamp, nonce) {
  const bodyStr    = body ? JSON.stringify(body) : '';
  const bodyHash   = crypto.createHash('sha256').update(bodyStr).digest('hex');
  const strToSign  = [method, bodyHash, '', path].join('\n');
  const signInput  = token
    ? `${ACCESS_ID}${token}${timestamp}${nonce}${strToSign}`
    : `${ACCESS_ID}${timestamp}${nonce}${strToSign}`;
  return crypto.createHmac('sha256', ACCESS_SECRET).update(signInput).digest('hex').toUpperCase();
}

// ── 액세스 토큰 발급 ───────────────────────────────────────────
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expireAt) {
    return tokenCache.token;
  }

  const timestamp = Date.now().toString();
  const nonce     = crypto.randomBytes(8).toString('hex');
  const path      = '/v1.0/token?grant_type=1';
  const sign      = makeSign('GET', path, null, '', timestamp, nonce);

  const res  = await fetch(`${TUYA_BASE_URL}${path}`, {
    headers: {
      'client_id':   ACCESS_ID,
      'sign':        sign,
      'sign_method': 'HMAC-SHA256',
      't':           timestamp,
      'nonce':       nonce,
    }
  });
  const data = await res.json();

  if (!data.success) {
    throw new Error('[Tuya] 토큰 발급 실패: ' + JSON.stringify(data));
  }

  tokenCache.token    = data.result.access_token;
  tokenCache.expireAt = Date.now() + (data.result.expire_time - 60) * 1000;
  console.log('[Tuya] ✅ 토큰 발급 성공');
  return tokenCache.token;
}

// ── 공통 요청 함수 ─────────────────────────────────────────────
async function tuyaRequest(method, path, body = null) {
  if (!ACCESS_ID || !ACCESS_SECRET) {
    console.log('[Tuya] ⚠️  API 키 없음 — 시뮬레이션 모드');
    return { success: false, simulated: true };
  }

  const token     = await getToken();
  const timestamp = Date.now().toString();
  const nonce     = crypto.randomBytes(8).toString('hex');
  const sign      = makeSign(method, path, body, token, timestamp, nonce);

  const opts = {
    method,
    headers: {
      'client_id':     ACCESS_ID,
      'access_token':  token,
      'sign':          sign,
      'sign_method':   'HMAC-SHA256',
      't':             timestamp,
      'nonce':         nonce,
      'Content-Type':  'application/json',
    }
  };
  if (body) opts.body = JSON.stringify(body);

  const res  = await fetch(`${TUYA_BASE_URL}${path}`, opts);
  const data = await res.json();

  if (!data.success) {
    console.error('[Tuya] API 오류:', JSON.stringify(data));
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// 도어락 기능 함수
// ─────────────────────────────────────────────────────────────

/**
 * 임시 비밀번호 등록
 * @param {string} deviceId  - 도어락 Device ID
 * @param {string} name      - 비밀번호 이름 (예약자명)
 * @param {string} password  - 6~8자리 숫자
 * @param {number} effectiveTime - 유효시작 (Unix 초)
 * @param {number} invalidTime   - 유효종료 (Unix 초)
 */
async function createTempPassword(deviceId, name, password, effectiveTime, invalidTime) {
  const did  = deviceId || DEFAULT_DEVICE;
  const path = `/v1.0/devices/${did}/door-lock/temp-passwords`;
  const data = await tuyaRequest('POST', path, {
    name,
    password,
    effective_time: effectiveTime,
    invalid_time:   invalidTime,
    password_type:  'period',   // 기간형
  });

  if (data.simulated) {
    console.log(`[Tuya 시뮬] 임시 비번 등록: ${name} / ${password}# (${new Date(effectiveTime * 1000).toLocaleDateString()} ~ ${new Date(invalidTime * 1000).toLocaleDateString()})`);
    return { success: true, simulated: true, passwordId: 'SIM-' + Date.now() };
  }
  if (data.success) {
    console.log(`[Tuya] ✅ 임시 비번 등록 완료: ${name} / ${password}#  ID=${data.result?.id}`);
  }
  return data;
}

/**
 * 임시 비밀번호 목록 조회
 */
async function getTempPasswords(deviceId) {
  const did  = deviceId || DEFAULT_DEVICE;
  return tuyaRequest('GET', `/v1.0/devices/${did}/door-lock/temp-passwords`);
}

/**
 * 임시 비밀번호 삭제 (체크아웃 시)
 */
async function deleteTempPassword(deviceId, passwordId) {
  const did  = deviceId || DEFAULT_DEVICE;
  if (!passwordId || passwordId.startsWith('SIM-')) {
    console.log('[Tuya 시뮬] 임시 비번 삭제:', passwordId);
    return { success: true, simulated: true };
  }
  const data = await tuyaRequest('DELETE', `/v1.0/devices/${did}/door-lock/temp-passwords/${passwordId}`);
  if (data.success) console.log(`[Tuya] ✅ 임시 비번 삭제: ${passwordId}`);
  return data;
}

/**
 * 원격 해제 (관리자용)
 */
async function remoteUnlock(deviceId) {
  const did  = deviceId || DEFAULT_DEVICE;
  if (!ACCESS_ID) {
    console.log('[Tuya 시뮬] 원격 해제 시뮬레이션');
    return { success: true, simulated: true };
  }
  const data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
    commands: [{ code: 'unlock_request', value: true }]
  });
  if (data.success) console.log(`[Tuya] ✅ 원격 해제 완료: ${did}`);
  return data;
}

/**
 * 도어락 상태 확인
 */
async function getDeviceStatus(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  return tuyaRequest('GET', `/v1.0/devices/${did}/status`);
}

// Tuya 설정 여부 확인
function isTuyaEnabled() {
  return !!(ACCESS_ID && ACCESS_SECRET && DEFAULT_DEVICE);
}

module.exports = {
  createTempPassword,
  getTempPasswords,
  deleteTempPassword,
  remoteUnlock,
  getDeviceStatus,
  isTuyaEnabled,
};
