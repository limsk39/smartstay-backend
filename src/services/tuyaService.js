/**
 * 투야 IoT API 서비스
 * 락프로 H5000 (Tuya Zigbee 허브) 연동
 *
 * 지원 기능:
 *  - 액세스 토큰 자동 갱신
 *  - 임시 비밀번호 생성 (체크인~체크아웃 유효)
 *  - 임시 비밀번호 삭제 (체크아웃 후 자동 삭제)
 *  - 도어락 상태 조회
 */

const axios = require('axios');
const crypto = require('crypto-js');
require('dotenv').config();

const BASE_URL      = process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com';
const CLIENT_ID     = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;

// 토큰 캐시
let accessToken    = null;
let tokenExpireAt  = null;

// ─────────────────────────────────────────────────────────────
// 서명 생성 (Tuya Open API HMAC-SHA256)
// ─────────────────────────────────────────────────────────────
function generateSign(method, path, body, timestamp, nonce, token = '') {
  const contentHash = crypto.SHA256(body ? JSON.stringify(body) : '').toString(crypto.enc.Hex);
  const stringToSign = [method, contentHash, '', path].join('\n');
  const signStr = CLIENT_ID + token + timestamp + nonce + stringToSign;
  return crypto.HmacSHA256(signStr, CLIENT_SECRET).toString(crypto.enc.Hex).toUpperCase();
}

// ─────────────────────────────────────────────────────────────
// 액세스 토큰 발급 (만료 1분 전 자동 갱신)
// ─────────────────────────────────────────────────────────────
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && tokenExpireAt && now < tokenExpireAt) {
    return accessToken;
  }

  const timestamp = String(now);
  const nonce     = Math.random().toString(36).substring(2);
  const path      = '/v1.0/token?grant_type=1';
  const sign      = generateSign('GET', path, null, timestamp, nonce);

  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      client_id:   CLIENT_ID,
      sign,
      t:           timestamp,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json'
    }
  });

  if (!res.data.success) {
    throw new Error(`투야 토큰 발급 실패 [${res.data.code}]: ${res.data.msg}`);
  }

  accessToken   = res.data.result.access_token;
  // expire_time 은 초 단위, 만료 1분 전에 갱신
  tokenExpireAt = now + (res.data.result.expire_time - 60) * 1000;
  return accessToken;
}

// ─────────────────────────────────────────────────────────────
// 공통 API 요청 래퍼
// ─────────────────────────────────────────────────────────────
async function tuyaRequest(method, path, body = null) {
  const token     = await getAccessToken();
  const timestamp = String(Date.now());
  const nonce     = Math.random().toString(36).substring(2);
  const sign      = generateSign(method, path, body, timestamp, nonce, token);

  const res = await axios({
    method,
    url:  `${BASE_URL}${path}`,
    data: body || undefined,
    headers: {
      client_id:    CLIENT_ID,
      access_token: token,
      sign,
      t:            timestamp,
      nonce,
      sign_method:  'HMAC-SHA256',
      'Content-Type': 'application/json'
    }
  });

  if (!res.data.success) {
    const errCode = res.data.code;
    const errMsg  = res.data.msg;
    throw Object.assign(
      new Error(`투야 API 오류 [${errCode}]: ${errMsg}`),
      { tuyaCode: errCode }
    );
  }

  return res.data.result;
}

// ─────────────────────────────────────────────────────────────
// 비밀번호 암호화 (티켓 방식 사용 시)
// 일부 투야 스마트락은 ticket_key 로 AES-128-ECB 암호화 필요
// ─────────────────────────────────────────────────────────────
function encryptWithTicketKey(password, ticketKey) {
  if (!ticketKey) return password;
  try {
    const key       = crypto.enc.Utf8.parse(ticketKey.substring(0, 16).padEnd(16, '0'));
    const encrypted = crypto.AES.encrypt(
      crypto.enc.Utf8.parse(password),
      key,
      { mode: crypto.mode.ECB, padding: crypto.pad.Pkcs7 }
    );
    return encrypted.toString();
  } catch {
    return password;  // 암호화 실패 시 평문 반환
  }
}

// ─────────────────────────────────────────────────────────────
// 6자리 랜덤 비밀번호 생성
// ─────────────────────────────────────────────────────────────
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─────────────────────────────────────────────────────────────
// 임시 비밀번호 생성 — H5000 티켓 방식 (권장)
// 흐름: 티켓 발급 → 비밀번호 암호화 → 임시 비번 등록
// ─────────────────────────────────────────────────────────────
async function createTempPasswordWithTicket(deviceId, checkIn, checkOut, guestName) {
  const startTime = Math.floor(new Date(checkIn).getTime()  / 1000);
  const endTime   = Math.floor(new Date(checkOut).getTime() / 1000);
  const rawCode   = generateCode();

  // 1) 티켓 발급
  const ticket = await tuyaRequest(
    'POST',
    `/v1.0/devices/${deviceId}/door-lock/password-ticket`,
    null
  );

  const ticketId  = ticket.ticket_id;
  const ticketKey = ticket.ticket_key;  // AES 암호화 키
  const encrypted = encryptWithTicketKey(rawCode, ticketKey);

  // 2) 임시 비밀번호 등록
  const result = await tuyaRequest(
    'POST',
    `/v1.0/devices/${deviceId}/door-lock/temp-password`,
    {
      ticket_id:      ticketId,
      password:       encrypted,
      effective_time: startTime,
      invalid_time:   endTime,
      name:           guestName,
      type:           0   // 0: 시간제한, 1: 상시
    }
  );

  return {
    password:    rawCode,           // 실제 고객에게 전달할 번호
    passwordId:  result.id || result,
    ticketId,
    validFrom:   checkIn,
    validUntil:  checkOut,
    method:      'ticket'
  };
}

// ─────────────────────────────────────────────────────────────
// 임시 비밀번호 생성 — 직접 방식 (티켓 미지원 모델 폴백)
// ─────────────────────────────────────────────────────────────
async function createTempPasswordDirect(deviceId, checkIn, checkOut, guestName) {
  const startTime = Math.floor(new Date(checkIn).getTime()  / 1000);
  const endTime   = Math.floor(new Date(checkOut).getTime() / 1000);
  const rawCode   = generateCode();

  const result = await tuyaRequest(
    'POST',
    `/v1.0/devices/${deviceId}/door-lock/temp-password`,
    {
      name:           guestName,
      password:       rawCode,
      effective_time: startTime,
      invalid_time:   endTime,
      type:           0
    }
  );

  return {
    password:   rawCode,
    passwordId: result.id || result,
    validFrom:  checkIn,
    validUntil: checkOut,
    method:     'direct'
  };
}

// ─────────────────────────────────────────────────────────────
// 임시 비밀번호 생성 (외부 호출용 — 자동 폴백)
// ─────────────────────────────────────────────────────────────
async function createTempPassword(deviceId, checkIn, checkOut, guestName) {
  // 먼저 티켓 방식 시도, 실패하면 직접 방식으로 폴백
  try {
    const result = await createTempPasswordWithTicket(deviceId, checkIn, checkOut, guestName);
    console.log(`[Tuya] 임시 비밀번호 생성 성공 (티켓방식): ${result.password} → ${deviceId}`);
    return result;
  } catch (ticketErr) {
    console.warn(`[Tuya] 티켓 방식 실패 (${ticketErr.tuyaCode || ticketErr.message}), 직접 방식 시도...`);
    try {
      const result = await createTempPasswordDirect(deviceId, checkIn, checkOut, guestName);
      console.log(`[Tuya] 임시 비밀번호 생성 성공 (직접방식): ${result.password} → ${deviceId}`);
      return result;
    } catch (directErr) {
      console.error(`[Tuya] 임시 비밀번호 생성 실패:`, directErr.message);
      // 최후 수단: 코드만 생성 (도어락 등록은 수동 필요 — 운영자에게 알림 필요)
      const fallbackCode = generateCode();
      console.error(`[Tuya] ⚠️  폴백 코드 사용 — 운영자 수동 등록 필요: ${fallbackCode}`);
      return {
        password:   fallbackCode,
        passwordId: null,
        validFrom:  checkIn,
        validUntil: checkOut,
        method:     'fallback',
        error:      directErr.message
      };
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 임시 비밀번호 삭제 (체크아웃 후 자동 삭제 스케줄러에서 호출)
// ─────────────────────────────────────────────────────────────
async function deleteTempPassword(deviceId, passwordId) {
  if (!passwordId) {
    console.warn('[Tuya] passwordId 없음 — 삭제 건너뜀');
    return false;
  }
  try {
    await tuyaRequest(
      'DELETE',
      `/v1.0/devices/${deviceId}/door-lock/temp-password/${passwordId}`
    );
    console.log(`[Tuya] 임시 비밀번호 삭제 완료: ${passwordId}`);
    return true;
  } catch (err) {
    console.error(`[Tuya] 임시 비밀번호 삭제 실패 [${err.tuyaCode}]:`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────
// 등록된 임시 비밀번호 목록 조회
// ─────────────────────────────────────────────────────────────
async function listTempPasswords(deviceId) {
  try {
    return await tuyaRequest('GET', `/v1.0/devices/${deviceId}/door-lock/temp-password`);
  } catch (err) {
    console.error('[Tuya] 임시 비밀번호 목록 조회 실패:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// 도어락 상태 조회 (온라인 여부, 잠금 상태 등)
// ─────────────────────────────────────────────────────────────
async function getDeviceStatus(deviceId) {
  try {
    const statusList = await tuyaRequest('GET', `/v1.0/devices/${deviceId}/status`);
    // DP 코드별로 객체화
    const status = {};
    (statusList || []).forEach(dp => { status[dp.code] = dp.value; });
    return status;
    // 주요 DP 코드 (H5000 기준):
    // door_lock_state: "unlock" | "lock"
    // battery_percentage: 0~100
    // alarm_lock: 경보 상태
  } catch (err) {
    console.error('[Tuya] 도어락 상태 조회 실패:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// 디바이스 온라인 상태 확인
// ─────────────────────────────────────────────────────────────
async function isDeviceOnline(deviceId) {
  try {
    const info = await tuyaRequest('GET', `/v1.0/devices/${deviceId}`);
    return info?.online === true;
  } catch {
    return false;
  }
}

module.exports = {
  createTempPassword,
  deleteTempPassword,
  listTempPasswords,
  getDeviceStatus,
  isDeviceOnline
};
