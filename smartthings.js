/**
 * SmartThings REST API 연동 모듈
 * Lockpro H5000 Zigbee 도어락 — Edge Driver 기반 비밀번호 관리
 *
 * 환경변수:
 *   SMARTTHINGS_TOKEN      — SmartThings Personal Access Token
 *   SMARTTHINGS_DEVICE_ID  — 기본 도어락 Device ID (SmartThings 앱에서 확인)
 *
 * SmartThings API 공식 문서:
 *   https://developer.smartthings.com/docs/api/public
 */

const https = require('https');

const ST_HOST    = 'api.smartthings.com';
const ST_BASE    = '/v1';
const ST_TOKEN   = process.env.SMARTTHINGS_TOKEN   || '';
const ST_DEVICE  = process.env.SMARTTHINGS_DEVICE_ID || '';

// ── 연동 활성화 여부 ─────────────────────────────────────────
function isSmartThingsEnabled() {
  return !!(ST_TOKEN && ST_TOKEN.length > 10 && ST_DEVICE);
}

// ── 공통 REST 요청 ───────────────────────────────────────────
function stRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';

    const opts = {
      hostname: ST_HOST,
      path:     ST_BASE + path,
      method,
      headers: {
        'Authorization': 'Bearer ' + ST_TOKEN,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {})
      }
    };

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`SmartThings API ${res.statusCode}: ${JSON.stringify(json)}`));
          }
        } catch (e) {
          reject(new Error('SmartThings 응답 파싱 실패: ' + data.substring(0, 200)));
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── 디바이스 명령 전송 공통 함수 ─────────────────────────────
function sendCommand(deviceId, capability, command, args) {
  const did = deviceId || ST_DEVICE;
  const body = {
    commands: [{
      component:  'main',
      capability,
      command,
      ...(args !== undefined ? { arguments: args } : {})
    }]
  };
  return stRequest('POST', `/devices/${did}/commands`, body);
}

// ──────────────────────────────────────────────────────────────
//  도어락 비밀번호 관리
// ──────────────────────────────────────────────────────────────

/**
 * 비밀번호 등록 (체크인 시 호출)
 * SmartThings lockCodes.setCode(slot, pin, name)
 *
 * @param {string} deviceId   - SmartThings Device ID (빈값이면 환경변수 사용)
 * @param {number} slot       - 슬롯 번호 1~100
 * @param {string} pin        - 숫자 비밀번호 (4~8자리)
 * @param {string} name       - 코드 이름 (예: "홍길동")
 */
async function setCode(deviceId, slot, pin, name) {
  if (!isSmartThingsEnabled()) {
    console.log(`[ST-SIM] setCode: slot=${slot}, pin=${pin}, name=${name}`);
    return { simulated: true, slot, pin };
  }

  console.log(`[SmartThings] 🔐 비번 등록: slot=${slot}, pin=${pin}, name=${name}`);
  const result = await sendCommand(
    deviceId,
    'lockCodes',
    'setCode',
    [slot, pin, name]
  );
  console.log(`[SmartThings] ✅ setCode 완료: slot=${slot}`);
  return result;
}

/**
 * 비밀번호 삭제 (체크아웃 시 호출)
 * SmartThings lockCodes.deleteCode(slot)
 *
 * @param {string} deviceId   - SmartThings Device ID
 * @param {number} slot       - 삭제할 슬롯 번호
 */
async function deleteCode(deviceId, slot) {
  if (!isSmartThingsEnabled()) {
    console.log(`[ST-SIM] deleteCode: slot=${slot}`);
    return { simulated: true, slot };
  }

  console.log(`[SmartThings] 🗑️ 비번 삭제: slot=${slot}`);
  const result = await sendCommand(deviceId, 'lockCodes', 'deleteCode', [slot]);
  console.log(`[SmartThings] ✅ deleteCode 완료: slot=${slot}`);
  return result;
}

// ──────────────────────────────────────────────────────────────
//  원격 잠금 / 해제
// ──────────────────────────────────────────────────────────────

async function remoteLock(deviceId) {
  if (!isSmartThingsEnabled()) {
    return { simulated: true, action: 'lock' };
  }
  return sendCommand(deviceId, 'lock', 'lock');
}

async function remoteUnlock(deviceId) {
  if (!isSmartThingsEnabled()) {
    return { simulated: true, action: 'unlock' };
  }
  return sendCommand(deviceId, 'lock', 'unlock');
}

// ──────────────────────────────────────────────────────────────
//  기기 상태 조회
// ──────────────────────────────────────────────────────────────

async function getDeviceStatus(deviceId) {
  if (!isSmartThingsEnabled()) {
    return {
      simulated: true,
      lock:      { lock: { value: 'locked' } },
      battery:   { battery: { value: 85 } },
      lockCodes: { lockCodes: { value: {} } }
    };
  }

  const did = deviceId || ST_DEVICE;
  const data = await stRequest('GET', `/devices/${did}/status`);
  return data?.components?.main || data;
}

/**
 * 기기 정보 조회 (이름, 온라인 여부 등)
 */
async function getDeviceInfo(deviceId) {
  if (!isSmartThingsEnabled()) {
    return { simulated: true, deviceId: deviceId || ST_DEVICE };
  }
  const did = deviceId || ST_DEVICE;
  return stRequest('GET', `/devices/${did}`);
}

/**
 * 현재 등록된 코드 목록 조회 (lockCodes capability)
 */
async function getLockCodes(deviceId) {
  if (!isSmartThingsEnabled()) {
    return { simulated: true, codes: {} };
  }

  const did = deviceId || ST_DEVICE;
  const data = await stRequest('GET', `/devices/${did}/components/main/capabilities/lockCodes/status`);
  return data?.lockCodes?.value || {};
}

// ──────────────────────────────────────────────────────────────
//  슬롯 자동 배정 유틸
// ──────────────────────────────────────────────────────────────

/**
 * 예약 ID에서 슬롯 번호 결정 (1~99 순환)
 * UUID 마지막 4자리 hex → 1~99
 */
function reservationToSlot(reservationId) {
  const hex = (reservationId || '').replace(/-/g, '').slice(-4);
  const num = parseInt(hex, 16) || 0;
  return (num % 99) + 1;  // 1~99
}

// ──────────────────────────────────────────────────────────────
//  exports
// ──────────────────────────────────────────────────────────────

module.exports = {
  isSmartThingsEnabled,
  setCode,
  deleteCode,
  remoteLock,
  remoteUnlock,
  getDeviceStatus,
  getDeviceInfo,
  getLockCodes,
  reservationToSlot,
  stRequest,
};
