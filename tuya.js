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
// jtmspro(호텔 도어락 프로) Raw DP 헬퍼
// unlock_method_create / unlock_method_delete Raw 바이트 포맷
// ─────────────────────────────────────────────────────────────

/**
 * unlock_method_create Raw 바이트 빌드 (JTMSPro SP1 공식 포맷)
 * 출처: Tuya AI (T Sma) 공식 문서 요약
 *
 * 총 길이 = 22 + N 바이트
 *   [0-1]  Peripheral ID : 0x00, keyIndex(1~200)
 *   [2]    Type          : 0x00 = 기간형(time-bound)
 *   [3-8]  Start datetime: year(BCD,year-2000), month, day, hour, min, sec
 *   [9-14] End datetime  : same format
 *   [15-19] Reserved     : 0x00 x5
 *   [20]   Use count     : 0x00 = unlimited
 *   [21]   Password len  : N
 *   [22~]  Password digits: raw 0x00~0x09
 */
function buildCreateRaw(password, effectiveTime, invalidTime, keyIndex) {
  const startDate = new Date(effectiveTime * 1000);
  const endDate   = new Date(invalidTime   * 1000);
  const digits    = password.split('').map(d => parseInt(d, 10));
  const N         = digits.length;
  const buf       = Buffer.alloc(22 + N);
  let off = 0;

  // [0-1] Peripheral ID
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;

  // [2] Type: time-bound
  buf[off++] = 0x00;

  // [3-8] Start datetime (UTC, year BCD)
  const toBcd = v => ((Math.floor(v / 10) << 4) | (v % 10));
  buf[off++] = toBcd(startDate.getUTCFullYear() - 2000);
  buf[off++] = startDate.getUTCMonth() + 1;
  buf[off++] = startDate.getUTCDate();
  buf[off++] = startDate.getUTCHours();
  buf[off++] = startDate.getUTCMinutes();
  buf[off++] = startDate.getUTCSeconds();

  // [9-14] End datetime (UTC)
  buf[off++] = toBcd(endDate.getUTCFullYear() - 2000);
  buf[off++] = endDate.getUTCMonth() + 1;
  buf[off++] = endDate.getUTCDate();
  buf[off++] = endDate.getUTCHours();
  buf[off++] = endDate.getUTCMinutes();
  buf[off++] = endDate.getUTCSeconds();

  // [15-19] Reserved
  for (let i = 0; i < 5; i++) buf[off++] = 0x00;

  // [20] Use count: unlimited
  buf[off++] = 0x00;

  // [21] Password length
  buf[off++] = N;

  // [22~] Password digits (raw)
  for (const d of digits) buf[off++] = d;

  return buf.toString('hex').toUpperCase();
}

/**
 * unlock_method_delete Raw 바이트 빌드
 */
function buildDeleteRaw(keyIndex) {
  const buf = Buffer.alloc(3);
  buf[0] = 0x00;
  buf[1] = keyIndex & 0xFF;
  buf[2] = 0xFF;   // use count 0xFF = expired (삭제)
  return buf.toString('hex').toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// 도어락 기능 함수
// ─────────────────────────────────────────────────────────────

/**
 * 임시 비밀번호 등록 (jtmspro: commands API + unlock_method_create Raw DP)
 * @param {string} deviceId      - 도어락 Device ID
 * @param {string} name          - 비밀번호 이름 (예약자명, 로그용)
 * @param {string} password      - 6자리 숫자
 * @param {number} effectiveTime - 유효시작 (Unix 초)
 * @param {number} invalidTime   - 유효종료 (Unix 초)
 */
async function createTempPassword(deviceId, name, password, effectiveTime, invalidTime) {
  const did      = deviceId || DEFAULT_DEVICE;
  const methodId = Math.floor(Math.random() * 200) + 1;   // 1~200
  const rawHex   = buildCreateRaw(password, effectiveTime, invalidTime, methodId);

  console.log(`[Tuya] unlock_method_create  methodId=${methodId}  raw=${rawHex}`);

  // iot-03 경로(서브 디바이스용) 먼저 시도, 실패 시 구버전 경로 폴백
  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_create', value: rawHex }]
  });
  if (!data.success && data.code === 1108) {
    console.log('[Tuya] iot-03 경로 실패 → 구버전 경로 재시도');
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: rawHex }]
    });
  }

  if (data.simulated) {
    console.log(`[Tuya 시뮬] 임시 비번 등록: ${name} / ${password}#  methodId=${methodId}`);
    return { success: true, simulated: true, passwordId: `SIM-${methodId}` };
  }
  if (data.success) {
    console.log(`[Tuya] ✅ 임시 비번 등록 완료: ${name} / ${password}#  methodId=${methodId}`);
    // passwordId 에 methodId 저장 → 나중에 삭제할 때 사용
    return { ...data, result: { id: String(methodId) } };
  }
  return data;
}

/**
 * 임시 비밀번호 목록 조회
 * jtmspro 는 REST 목록 API 가 없으므로 device status 에서 읽음
 */
async function getTempPasswords(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  return tuyaRequest('GET', `/v1.0/devices/${did}/status`);
}

/**
 * 임시 비밀번호 삭제 (체크아웃 시)
 * passwordId 에 methodId(숫자 문자열) 저장되어 있어야 함
 */
async function deleteTempPassword(deviceId, passwordId) {
  const did = deviceId || DEFAULT_DEVICE;
  if (!passwordId || passwordId.startsWith('SIM-')) {
    const simId = passwordId ? parseInt(passwordId.replace('SIM-', '')) : 1;
    console.log('[Tuya 시뮬] 임시 비번 삭제:', passwordId);
    return { success: true, simulated: true };
  }

  const methodId = parseInt(passwordId, 10);
  if (isNaN(methodId)) {
    console.log('[Tuya] 삭제 스킵 — methodId 파싱 불가:', passwordId);
    return { success: true };
  }

  const rawHex = buildDeleteRaw(methodId);
  console.log(`[Tuya] unlock_method_delete  methodId=${methodId}  raw=${rawHex}`);

  const data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_delete', value: rawHex }]
  });
  if (data.success) console.log(`[Tuya] ✅ 임시 비번 삭제: methodId=${methodId}`);
  return data;
}

/**
 * 원격 해제 (관리자용)
 * jtmspro: unlock_remote (Integer 0) 또는 open_close (Boolean true)
 */
async function remoteUnlock(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  if (!ACCESS_ID) {
    console.log('[Tuya 시뮬] 원격 해제 시뮬레이션');
    return { success: true, simulated: true };
  }

  // unlock_remote = 0 으로 원격 해제 시도
  let data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
    commands: [{ code: 'unlock_remote', value: 0 }]
  });
  if (data.success) {
    console.log(`[Tuya] ✅ 원격 해제 완료 (unlock_remote): ${did}`);
    return data;
  }

  // 실패 시 open_close 로 폴백
  console.log('[Tuya] unlock_remote 실패, open_close 시도...');
  data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
    commands: [{ code: 'open_close', value: true }]
  });
  if (data.success) console.log(`[Tuya] ✅ 원격 해제 완료 (open_close): ${did}`);
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
  tuyaRequest,
};
