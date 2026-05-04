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

/**
 * 변형 V2: Type=0x03 (비밀번호 타입), 같은 구조 - keypad 명시
 */
function buildCreateRawV2_TypePwd(password, effectiveTime, invalidTime, keyIndex) {
  const startDate = new Date(effectiveTime * 1000);
  const endDate   = new Date(invalidTime   * 1000);
  const digits    = password.split('').map(d => parseInt(d, 10));
  const N         = digits.length;
  const buf       = Buffer.alloc(22 + N);
  let off = 0;
  const toBcd = v => ((Math.floor(v / 10) << 4) | (v % 10));
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x03;  // ★ Type = 0x03 = 비밀번호(keypad password)
  buf[off++] = toBcd(startDate.getUTCFullYear() - 2000);
  buf[off++] = startDate.getUTCMonth() + 1;
  buf[off++] = startDate.getUTCDate();
  buf[off++] = startDate.getUTCHours();
  buf[off++] = startDate.getUTCMinutes();
  buf[off++] = startDate.getUTCSeconds();
  buf[off++] = toBcd(endDate.getUTCFullYear() - 2000);
  buf[off++] = endDate.getUTCMonth() + 1;
  buf[off++] = endDate.getUTCDate();
  buf[off++] = endDate.getUTCHours();
  buf[off++] = endDate.getUTCMinutes();
  buf[off++] = endDate.getUTCSeconds();
  for (let i = 0; i < 5; i++) buf[off++] = 0x00;
  buf[off++] = 0x00;
  buf[off++] = N;
  for (const d of digits) buf[off++] = d + 0x30;  // ASCII
  return buf.toString('hex').toUpperCase();
}

/**
 * 변형 V3: 짧은 포맷 [type][idx][len][ASCII][4B start BE][4B end BE]
 */
function buildCreateRawV3_Short(password, effectiveTime, invalidTime, keyIndex) {
  const N = password.length;
  const buf = Buffer.alloc(3 + N + 8);
  let off = 0;
  buf[off++] = 0x03;  // type=password
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = N;
  for (const d of password) buf[off++] = d.charCodeAt(0);  // ASCII
  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off); off += 4;
  return buf.toString('hex').toUpperCase();
}

/**
 * ★ Lockpro H5000 실제 포맷 (Tuya 앱 패킷 캡처로 발견) ★
 * 총 21+N 바이트
 *   [0]    0x03         = 작업: 생성
 *   [1]    0xE4         = 서브타입(검증된 값)
 *   [2-3]  0x00 keyIdx  = 슬롯 (BE 16bit)
 *   [4-5]  0x00 0x00    = 예약
 *   [6-9]  start (4B BE Unix sec)
 *   [10-13] end   (4B BE Unix sec)
 *   [14-20] 0x00 × 7    = 예약
 *   [21+]  ASCII 비번
 */
function buildCreateRawSafe(password, effectiveTime, invalidTime, keyIndex = 1) {
  const N = password.length;
  const buf = Buffer.alloc(21 + N);
  let off = 0;

  buf[off++] = 0x03;
  buf[off++] = 0xE4;
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x00;
  buf[off++] = 0x00;

  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off);   off += 4;

  for (let i = 0; i < 7; i++) buf[off++] = 0x00;

  for (const ch of password) buf[off++] = ch.charCodeAt(0);

  return buf.toString('hex').toUpperCase();
}

/**
 * 변형 V4: Tuya 표준 [type][schedule][idx][len][ASCII][4B start BE][4B end BE]
 */
function buildCreateRawV4_TuyaStd(password, effectiveTime, invalidTime, keyIndex) {
  const N = password.length;
  const buf = Buffer.alloc(4 + N + 8);
  let off = 0;
  buf[off++] = 0x03;  // type = password
  buf[off++] = 0x01;  // schedule = time-bound
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = N;
  for (const d of password) buf[off++] = d.charCodeAt(0);  // ASCII
  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off); off += 4;
  return buf.toString('hex').toUpperCase();
}

/**
 * 모든 변형 동시 테스트
 */
async function testAllFormats(deviceId, password, baseSlot) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const eff = now - 86400;
  const inv = now + 7 * 86400;

  const variants = [
    { name: 'V0_original',    hex: buildCreateRaw(password, eff, inv, baseSlot)         },
    { name: 'V2_typePwd',     hex: buildCreateRawV2_TypePwd(password, eff, inv, baseSlot+1) },
    { name: 'V3_short',       hex: buildCreateRawV3_Short(password, eff, inv, baseSlot+2)   },
    { name: 'V4_tuyaStd',     hex: buildCreateRawV4_TuyaStd(password, eff, inv, baseSlot+3) },
  ];

  const results = {};
  for (const v of variants) {
    const r = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: v.hex }]
    });
    results[v.name] = { hex: v.hex, result: r };
    console.log(`[Tuya 진단] ${v.name}: hex=${v.hex} success=${r.success}`);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// ★★★ Tuya Smart Lock 전용 API (ticket 기반 AES 암호화) ★★★
// Raw DP 방식이 아닌 Tuya 공식 스마트락 API 사용
// 출처: developer.tuya.com/en/docs/cloud/doorlock-api-password
// ─────────────────────────────────────────────────────────────

/**
 * 1단계: 비밀번호 티켓 발급
 * POST /v1.0/devices/{did}/door-lock/password-ticket
 * → ticket_id, ticket_key 반환
 */
async function getPasswordTicket(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  // iot-03 경로(서브디바이스)와 레거시 경로 모두 시도
  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/door-lock/password-ticket`, {});
  if (!data.success) {
    console.log(`[Tuya] iot-03 티켓 발급 실패(code=${data.code}) → 레거시 경로`);
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/door-lock/password-ticket`, {});
  }
  return data;
}

/**
 * 2단계: ticket_key 복호화
 * ticket_key는 ACCESS_SECRET 앞 16바이트로 AES-128-ECB 암호화된 값
 * 주의: key를 HEX가 아닌 UTF-8(ASCII) 문자열로 해석해야 함
 */
/**
 * ticket_key 복호화 → 원시 Buffer 반환 (문자열 변환 금지)
 * 32바이트 반환 → 호출자가 AES-256 또는 앞 16바이트만 AES-128로 사용
 */
function decryptTicketKey(ticketKey) {
  const key = Buffer.from(ACCESS_SECRET.substring(0, 16), 'utf8');
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, '');
  decipher.setAutoPadding(false);
  const encrypted = Buffer.from(ticketKey, 'hex');
  return Buffer.concat([decipher.update(encrypted), decipher.final()]); // raw Buffer
}

/**
 * 비밀번호 AES 암호화
 * @param {string} password
 * @param {Buffer} decryptedKeyBuf - decryptTicketKey() 반환값 (32바이트)
 */
function encryptPassword(password, decryptedKeyBuf) {
  const buf  = Buffer.isBuffer(decryptedKeyBuf)
    ? decryptedKeyBuf
    : Buffer.from(decryptedKeyBuf, 'utf8');
  // 32바이트 → AES-256, 16바이트 → AES-128
  const algo = buf.length >= 32 ? 'aes-256-ecb' : 'aes-128-ecb';
  const key  = buf.length >= 32 ? buf.slice(0, 32) : buf.slice(0, 16);
  const cipher = crypto.createCipheriv(algo, key, '');
  cipher.setAutoPadding(true);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(password, 'utf8')), cipher.final()]);
  return encrypted.toString('hex').toUpperCase();
}

/**
 * 4단계: Smart Lock 전용 API로 임시 비밀번호 등록
 * POST /v1.0/devices/{did}/door-lock/temp-passwords
 */
async function createTempPasswordSmartLock(deviceId, name, password, effectiveTime, invalidTime) {
  const did = deviceId || DEFAULT_DEVICE;

  // ── 티켓 발급 ──────────────────────────────────────────────
  console.log(`[Tuya SmartLock] 티켓 발급 요청  did=${did}`);
  const ticketData = await getPasswordTicket(did);
  if (!ticketData.success) {
    console.error('[Tuya SmartLock] ❌ 티켓 발급 실패:', JSON.stringify(ticketData));
    return ticketData;
  }
  const { ticket_id, ticket_key } = ticketData.result;
  console.log(`[Tuya SmartLock] ✅ 티켓 발급: ticket_id=${ticket_id}`);

  // ── ticket_key 복호화 ───────────────────────────────────────
  let decryptedKey;
  try {
    decryptedKey = decryptTicketKey(ticket_key);
    console.log(`[Tuya SmartLock] 복호화 키 길이: ${decryptedKey.length}`);
  } catch (e) {
    console.error('[Tuya SmartLock] ❌ ticket_key 복호화 실패:', e.message);
    return { success: false, error: e.message };
  }

  // ── 비밀번호 AES 암호화 ─────────────────────────────────────
  let encryptedPwd;
  try {
    encryptedPwd = encryptPassword(password, decryptedKey);
    console.log(`[Tuya SmartLock] 암호화된 비번: ${encryptedPwd}`);
  } catch (e) {
    console.error('[Tuya SmartLock] ❌ 비번 암호화 실패:', e.message);
    return { success: false, error: e.message };
  }

  // ── 임시 비번 등록 ──────────────────────────────────────────
  const body = {
    ticket_id,
    password: encryptedPwd,
    name:           name || 'Guest',
    effective_time: effectiveTime,
    invalid_time:   invalidTime,
    password_type:  'ticket',
  };
  console.log(`[Tuya SmartLock] 임시 비번 등록 요청:`, JSON.stringify(body));

  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/door-lock/temp-passwords`, body);
  if (!data.success) {
    console.log(`[Tuya SmartLock] iot-03 실패(code=${data.code}) → 레거시`);
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/door-lock/temp-passwords`, body);
  }

  if (data.success) {
    console.log(`[Tuya SmartLock] ✅ 등록 완료: ${name} / ${password}#`);
  } else {
    console.error('[Tuya SmartLock] ❌ 등록 실패:', JSON.stringify(data));
  }
  return data;
}

// ─────────────────────────────────────────────────────────────
// 도어락 기능 함수
// ─────────────────────────────────────────────────────────────

/**
 * ★ 임시 비밀번호 등록 — 3단계 폴백 전략 ★
 *
 * 1순위: Tuya v2.0 스마트락 전용 API (가장 고수준, 포맷 자동 처리)
 * 2순위: v1.0 unlock_method_create + V5 포맷 (길이 바이트 포함 수정판)
 * 3순위: v1.0 unlock_method_create + 구 포맷 (하위 호환)
 */
async function createTempPassword(deviceId, name, password, effectiveTime, invalidTime) {
  const did      = deviceId || DEFAULT_DEVICE;
  const methodId = Math.floor(Math.random() * 200) + 1;

  // ─── 1순위: Smart Lock 전용 API (ticket + AES 암호화) ───────
  try {
    console.log(`[Tuya] 1순위: SmartLock API 시도  pwd=${password}`);
    const slData = await createTempPasswordSmartLock(did, name, password, effectiveTime, invalidTime);
    if (slData.success) {
      console.log(`[Tuya] ✅ SmartLock API 성공: ${name} / ${password}#`);
      return { ...slData, doorCode: password, result: { id: String(slData.result?.id || methodId) } };
    }
    console.log(`[Tuya] SmartLock API 실패 (code=${slData.code}) → 2순위로`);
  } catch (e) {
    console.log('[Tuya] SmartLock API 오류 → 2순위로:', e.message);
  }

  // ─── 2순위: v1.0 unlock_method_create + V5 포맷 (길이 바이트 포함) ──
  const rawHexV5 = buildCreateRawV5_WithLen(password, effectiveTime, invalidTime, methodId);
  console.log(`[Tuya] 2순위: V5 포맷  methodId=${methodId}  raw=${rawHexV5}`);
  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_create', value: rawHexV5 }]
  });
  if (!data.success && data.code === 1108) {
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: rawHexV5 }]
    });
  }
  if (data.success) {
    console.log(`[Tuya] ✅ V5 포맷 성공: ${name} / ${password}#  methodId=${methodId}`);
    return { ...data, result: { id: String(methodId) } };
  }
  console.log(`[Tuya] V5 포맷 실패 (code=${data.code}) → 3순위로`);

  // ─── 3순위: v1.0 + 구 포맷 (하위 호환) ───────────────────────
  const rawHexV0 = buildCreateRaw(password, effectiveTime, invalidTime, methodId);
  console.log(`[Tuya] 3순위: V0 구포맷  methodId=${methodId}  raw=${rawHexV0}`);
  let data0 = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_create', value: rawHexV0 }]
  });
  if (!data0.success && data0.code === 1108) {
    data0 = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: rawHexV0 }]
    });
  }

  if (data0.simulated) {
    console.log(`[Tuya 시뮬] 임시 비번 등록: ${name} / ${password}#  methodId=${methodId}`);
    return { success: true, simulated: true, passwordId: `SIM-${methodId}` };
  }
  if (data0.success) {
    console.log(`[Tuya] ✅ V0 구포맷 성공: ${name} / ${password}#  methodId=${methodId}`);
    return { ...data0, result: { id: String(methodId) } };
  }

  console.log(`[Tuya] ❌ 3순위까지 모두 실패: code=${data0.code}`);
  return data0;
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

/**
 * 기기 상세 정보 조회 (카테고리, 온라인 여부 등)
 */
async function getDeviceInfo(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  return tuyaRequest('GET', `/v1.0/devices/${did}`);
}

/**
 * Raw DP 빌드 (ASCII 숫자 버전: '1'=0x31, '2'=0x32 ...)
 * 일부 락 펌웨어가 ASCII 인코딩 기대하는 경우 사용
 */
function buildCreateRawASCII(password, effectiveTime, invalidTime, keyIndex) {
  const startDate = new Date(effectiveTime * 1000);
  const endDate   = new Date(invalidTime   * 1000);
  const digits    = password.split('').map(d => parseInt(d, 10));
  const N         = digits.length;
  const buf       = Buffer.alloc(22 + N);
  let off = 0;

  const toBcd = v => ((Math.floor(v / 10) << 4) | (v % 10));

  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x00;  // time-bound

  buf[off++] = toBcd(startDate.getUTCFullYear() - 2000);
  buf[off++] = startDate.getUTCMonth() + 1;
  buf[off++] = startDate.getUTCDate();
  buf[off++] = startDate.getUTCHours();
  buf[off++] = startDate.getUTCMinutes();
  buf[off++] = startDate.getUTCSeconds();

  buf[off++] = toBcd(endDate.getUTCFullYear() - 2000);
  buf[off++] = endDate.getUTCMonth() + 1;
  buf[off++] = endDate.getUTCDate();
  buf[off++] = endDate.getUTCHours();
  buf[off++] = endDate.getUTCMinutes();
  buf[off++] = endDate.getUTCSeconds();

  for (let i = 0; i < 5; i++) buf[off++] = 0x00;
  buf[off++] = 0x00;  // unlimited
  buf[off++] = N;     // password length

  // ★ ASCII 인코딩: '0'=0x30, '1'=0x31 ... '9'=0x39
  for (const d of digits) buf[off++] = d + 0x30;

  return buf.toString('hex').toUpperCase();
}

/**
 * 광범위 시간 + 고정 keyIndex 로 임시 비번 직접 등록 (진단용)
 * @param {string} deviceId     - 대상 장치 ID
 * @param {string} password     - 테스트 비밀번호 (기본 "123456")
 * @param {number} keyIndex     - 비번 슬롯 번호 (기본 1)
 * @param {number} effectiveTime - 유효시작 Unix초 (기본 now-7days)
 * @param {number} invalidTime   - 유효종료 Unix초 (기본 now+7days)
 */
async function testCreatePassword(deviceId, password = '123456', keyIndex = 1,
                                  effectiveTime = null, invalidTime = null) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const eff = effectiveTime ?? (now - 7 * 86400);
  const inv = invalidTime   ?? (now + 7 * 86400);

  const rawHex = buildCreateRaw(password, eff, inv, keyIndex);
  console.log(`[Tuya 진단] unlock_method_create  did=${did}  keyIndex=${keyIndex}  pwd=${password}  raw=${rawHex}`);

  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_create', value: rawHex }]
  });
  if (!data.success && data.code === 1108) {
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: rawHex }]
    });
  }
  return { rawHex, effectiveTime: eff, invalidTime: inv, keyIndex, password, deviceId: did, result: data };
}

/**
 * ASCII 인코딩으로 임시 비번 등록 (진단용)
 */
async function testCreatePasswordASCII(deviceId, password = '654321', keyIndex = 4,
                                       effectiveTime = null, invalidTime = null) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const eff = effectiveTime ?? (now - 7 * 86400);
  const inv = invalidTime   ?? (now + 7 * 86400);

  const rawHex = buildCreateRawASCII(password, eff, inv, keyIndex);
  console.log(`[Tuya 진단-ASCII] unlock_method_create  did=${did}  keyIndex=${keyIndex}  pwd=${password}  raw=${rawHex}`);

  let data = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
    commands: [{ code: 'unlock_method_create', value: rawHex }]
  });
  if (!data.success && data.code === 1108) {
    data = await tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: rawHex }]
    });
  }
  return { rawHex, effectiveTime: eff, invalidTime: inv, keyIndex, password, deviceId: did, result: data };
}

// Tuya 설정 여부 확인
function isTuyaEnabled() {
  return !!(ACCESS_ID && ACCESS_SECRET && DEFAULT_DEVICE);
}

/**
 * byte 1 (0xE4) 변형 자동 탐색
 * 0xE0~0xEF 16가지 값으로 동일 포맷 명령 전송
 */
async function testByte1Variants(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const start = now;
  const end = now + 24 * 3600;

  const results = [];
  for (let i = 0; i < 16; i++) {
    const byte1 = 0xE0 + i;
    const slot = i + 1;
    // 비번: "21" + 4자리 슬롯번호 (210001 ~ 210016)
    const password = '21' + slot.toString().padStart(4, '0');

    const N = password.length;
    const buf = Buffer.alloc(21 + N);
    let off = 0;
    buf[off++] = 0x03;
    buf[off++] = byte1;        // ★ 변경
    buf[off++] = 0x00;
    buf[off++] = slot & 0xFF;  // 슬롯 1~16
    buf[off++] = 0x00;
    buf[off++] = 0x00;
    buf.writeUInt32BE(start, off); off += 4;
    buf.writeUInt32BE(end, off);   off += 4;
    for (let j = 0; j < 7; j++) buf[off++] = 0x00;
    for (const ch of password) buf[off++] = ch.charCodeAt(0);

    const hex = buf.toString('hex').toUpperCase();

    const r = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: hex }]
    });

    results.push({
      byte1: '0x' + byte1.toString(16).toUpperCase(),
      slot,
      password,
      keypadInput: password + '#',
      success: r.success,
      code: r.code,
    });

    // 락이 처리할 시간 (BLE 통신 안정화)
    await new Promise(res => setTimeout(res, 800));
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// ★★★ 신규 포맷 v5/v6 — 비밀번호 길이 바이트 추가 ★★★
// 기존 buildCreateRawSafe 의 [20]번 바이트가 0x00 이어서
// 도어락이 "비번 길이=0" 으로 해석 → 비번 무시 버그 수정
// ─────────────────────────────────────────────────────────────

/**
 * V5: 비밀번호 길이 바이트 포함 + ASCII 인코딩 (22+N 바이트)
 * [0]=03 [1]=E4 [2]=00 [3]=slot [4]=00 [5]=00
 * [6~9]=start BE [10~13]=end BE
 * [14~19]=00×6  [20]=len  [21+]=ASCII pwd
 */
function buildCreateRawV5_WithLen(password, effectiveTime, invalidTime, keyIndex = 1) {
  const N = password.length;
  const buf = Buffer.alloc(22 + N);
  let off = 0;
  buf[off++] = 0x03;
  buf[off++] = 0xE4;
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x00;
  buf[off++] = 0x00;
  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off);   off += 4;
  for (let i = 0; i < 6; i++) buf[off++] = 0x00;  // 6바이트 예약
  buf[off++] = N;                                   // ★ 비번 길이
  for (const ch of password) buf[off++] = ch.charCodeAt(0); // ASCII
  return buf.toString('hex').toUpperCase();
}

/**
 * V6: 비밀번호 길이 바이트 포함 + 원시 숫자(raw digit) 인코딩 (22+N 바이트)
 * ASCII 아닌 원시값: '1'→0x01, '2'→0x02, ..., '9'→0x09, '0'→0x00
 */
function buildCreateRawV6_RawDigit(password, effectiveTime, invalidTime, keyIndex = 1) {
  const N = password.length;
  const buf = Buffer.alloc(22 + N);
  let off = 0;
  buf[off++] = 0x03;
  buf[off++] = 0xE4;
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x00;
  buf[off++] = 0x00;
  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off);   off += 4;
  for (let i = 0; i < 6; i++) buf[off++] = 0x00;
  buf[off++] = N;                              // ★ 비번 길이
  for (const ch of password) buf[off++] = parseInt(ch, 10); // ★ 원시값
  return buf.toString('hex').toUpperCase();
}

/**
 * V7: 원시 숫자, 길이 바이트 없음 (기존 buildCreateRawSafe 와 같은 크기)
 * [20] 자리 = 원시 첫 자릿수 (길이 바이트 위치를 첫 digit 으로 덮어쓰는 우연 방지 확인용)
 */
function buildCreateRawV7_RawNoLen(password, effectiveTime, invalidTime, keyIndex = 1) {
  const N = password.length;
  const buf = Buffer.alloc(21 + N);
  let off = 0;
  buf[off++] = 0x03;
  buf[off++] = 0xE4;
  buf[off++] = 0x00;
  buf[off++] = keyIndex & 0xFF;
  buf[off++] = 0x00;
  buf[off++] = 0x00;
  buf.writeUInt32BE(effectiveTime, off); off += 4;
  buf.writeUInt32BE(invalidTime, off);   off += 4;
  for (let i = 0; i < 7; i++) buf[off++] = 0x00;
  for (const ch of password) buf[off++] = parseInt(ch, 10); // ★ 원시값 (ASCII 아님)
  return buf.toString('hex').toUpperCase();
}

/**
 * byte 0 스캔: 0x00~0x08, byte 1 = 0xE4 고정
 * 비번: 30[slot 4자리], 슬롯 30~38
 */
async function testByte0Variants(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const start = now;
  const end = now + 24 * 3600;
  const results = [];

  for (let i = 0; i <= 8; i++) {
    const byte0 = i;
    const slot  = 30 + i;
    const password = '30' + slot.toString().padStart(4, '0');
    const N = password.length;
    const buf = Buffer.alloc(22 + N);
    let off = 0;
    buf[off++] = byte0;          // ★ 변경 대상 (0x00~0x08)
    buf[off++] = 0xE4;           // byte 1 고정
    buf[off++] = 0x00;
    buf[off++] = slot & 0xFF;
    buf[off++] = 0x00;
    buf[off++] = 0x00;
    buf.writeUInt32BE(start, off); off += 4;
    buf.writeUInt32BE(end, off);   off += 4;
    for (let j = 0; j < 6; j++) buf[off++] = 0x00;
    buf[off++] = N;              // ★ 비번 길이 포함
    for (const ch of password) buf[off++] = ch.charCodeAt(0);
    const hex = buf.toString('hex').toUpperCase();

    const r = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: hex }]
    });
    results.push({
      byte0: '0x' + byte0.toString(16).padStart(2, '0').toUpperCase(),
      slot, password,
      keypadInput: password + '#',
      hex,
      success: r.success,
      code: r.code,
    });
    await new Promise(res => setTimeout(res, 800));
  }
  return results;
}

/**
 * 길이 바이트 포함 포맷 vs 원시 숫자 포맷 동시 테스트
 * 비번: 400001(V5) / 400002(V6) / 400003(V7)
 */
async function testWithLengthByte(deviceId) {
  const did = deviceId || DEFAULT_DEVICE;
  const now = Math.floor(Date.now() / 1000);
  const start = now;
  const end   = now + 24 * 3600;

  const tests = [
    { fn: buildCreateRawV5_WithLen,  label: 'V5_len+ascii',    pwd: '400001', slot: 41 },
    { fn: buildCreateRawV6_RawDigit, label: 'V6_len+rawdigit', pwd: '400002', slot: 42 },
    { fn: buildCreateRawV7_RawNoLen, label: 'V7_rawdigit_nolen', pwd: '400003', slot: 43 },
  ];

  const results = {};
  for (const t of tests) {
    const hex = t.fn(t.pwd, start, end, t.slot);
    // unlock_method_create 로 전송
    const r_umc = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: hex }]
    });
    // remote_no_pd_setkey 로도 전송
    const r_nopd = await tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'remote_no_pd_setkey', value: hex }]
    });
    results[t.label] = {
      hex, byteLen: hex.length / 2,
      pwd: t.pwd, slot: t.slot,
      keypadInput: t.pwd + '#',
      unlock_method_create: { success: r_umc.success, code: r_umc.code },
      remote_no_pd_setkey:  { success: r_nopd.success, code: r_nopd.code },
    };
    await new Promise(res => setTimeout(res, 500));
  }
  return results;
}

/**
 * 장치 로그 조회 (최근 24시간 명령 기록)
 */
async function getDeviceLogs(deviceId, size = 30) {
  const did      = deviceId || DEFAULT_DEVICE;
  const endTime  = Date.now();
  const startTime = endTime - 24 * 3600 * 1000;
  return tuyaRequest('GET',
    `/v1.0/devices/${did}/logs?event_types=6&start_row=0&size=${size}&start_time=${startTime}&end_time=${endTime}`
  );
}

module.exports = {
  createTempPassword,
  getTempPasswords,
  deleteTempPassword,
  remoteUnlock,
  getDeviceStatus,
  getDeviceInfo,
  testCreatePassword,
  testCreatePasswordASCII,
  testAllFormats,
  testByte1Variants,
  testByte0Variants,
  testWithLengthByte,
  getDeviceLogs,
  buildCreateRawSafe,
  buildCreateRawV5_WithLen,
  buildCreateRawV6_RawDigit,
  buildCreateRawV7_RawNoLen,
  // ★ Smart Lock 전용 API
  getPasswordTicket,
  decryptTicketKey,
  encryptPassword,
  createTempPasswordSmartLock,
  isTuyaEnabled,
  tuyaRequest,
};
