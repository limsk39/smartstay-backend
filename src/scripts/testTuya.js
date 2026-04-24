/**
 * 투야 API 연동 테스트 스크립트
 * 사용법: node src/scripts/testTuya.js
 *
 * 이 스크립트로 다음을 순서대로 테스트합니다:
 *  1. 투야 API 토큰 발급
 *  2. 디바이스 목록 조회 (디바이스 ID 확인)
 *  3. 도어락 상태 조회
 *  4. 임시 비밀번호 생성 테스트
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios = require('axios');
const crypto = require('crypto-js');

const CLIENT_ID     = process.env.TUYA_CLIENT_ID;
const CLIENT_SECRET = process.env.TUYA_CLIENT_SECRET;
const BASE_URL      = process.env.TUYA_BASE_URL || 'https://openapi.tuyaeu.com';

// ─── 서명 생성 ────────────────────────────────────────────────
function generateSign(method, path, body, timestamp, nonce, token = '') {
  const contentHash = crypto.SHA256(body ? JSON.stringify(body) : '').toString(crypto.enc.Hex);
  const stringToSign = [method, contentHash, '', path].join('\n');
  const signStr = CLIENT_ID + token + timestamp + nonce + stringToSign;
  return crypto.HmacSHA256(signStr, CLIENT_SECRET).toString(crypto.enc.Hex).toUpperCase();
}

// ─── 액세스 토큰 발급 ─────────────────────────────────────────
async function getAccessToken() {
  const timestamp = String(Date.now());
  const nonce = Math.random().toString(36).substring(2);
  const path = '/v1.0/token?grant_type=1';
  const sign = generateSign('GET', path, null, timestamp, nonce);

  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      client_id: CLIENT_ID,
      sign,
      t: timestamp,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json'
    }
  });

  if (!res.data.success) throw new Error('토큰 발급 실패: ' + JSON.stringify(res.data));
  return res.data.result.access_token;
}

// ─── 공통 요청 함수 ───────────────────────────────────────────
async function tuyaRequest(method, path, body = null, token) {
  const timestamp = String(Date.now());
  const nonce = Math.random().toString(36).substring(2);
  const sign = generateSign(method, path, body, timestamp, nonce, token);

  const res = await axios({
    method,
    url: `${BASE_URL}${path}`,
    data: body || undefined,
    headers: {
      client_id: CLIENT_ID,
      access_token: token,
      sign,
      t: timestamp,
      nonce,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json'
    }
  });

  return res.data;
}

// ─── 메인 테스트 ──────────────────────────────────────────────
async function main() {
  console.log('\n========================================');
  console.log('  투야 API 연동 테스트 시작');
  console.log('========================================\n');

  // 환경변수 확인
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('❌ .env 파일에 TUYA_CLIENT_ID, TUYA_CLIENT_SECRET 을 입력해주세요.');
    process.exit(1);
  }
  console.log(`📡 서버: ${BASE_URL}`);
  console.log(`🔑 Client ID: ${CLIENT_ID.substring(0, 8)}...`);

  // ── TEST 1: 토큰 발급 ─────────────────────────────────────
  console.log('\n[TEST 1] 액세스 토큰 발급 중...');
  let token;
  try {
    token = await getAccessToken();
    console.log('✅ 토큰 발급 성공:', token.substring(0, 20) + '...');
  } catch (err) {
    console.error('❌ 토큰 발급 실패:', err.message);
    console.log('\n💡 해결 방법:');
    console.log('  - Client ID / Secret 이 맞는지 확인');
    console.log('  - TUYA_BASE_URL 이 올바른지 확인 (한국: https://openapi.tuyaeu.com)');
    console.log('  - 투야 콘솔 → Cloud 프로젝트 → API 권한이 추가되어 있는지 확인');
    process.exit(1);
  }

  // ── TEST 2: 내 홈의 디바이스 목록 조회 ───────────────────
  console.log('\n[TEST 2] 등록된 디바이스 목록 조회 중...');
  try {
    // 방법 1: 사용자 UID로 디바이스 조회 (Smart Life 앱과 연동된 경우)
    const devicesRes = await tuyaRequest('GET', '/v1.0/iot-01/associated-users/devices', null, token);
    if (devicesRes.success && devicesRes.result?.devices?.length > 0) {
      console.log(`✅ 디바이스 ${devicesRes.result.devices.length}개 발견:\n`);
      devicesRes.result.devices.forEach((d, i) => {
        console.log(`  [${i + 1}] 이름: ${d.name}`);
        console.log(`      ID: ${d.id}   ← .env의 tuyaDeviceId에 입력`);
        console.log(`      카테고리: ${d.category} | 온라인: ${d.online ? '✅' : '❌'}`);
        console.log('');
      });
    } else {
      console.log('⚠️  디바이스 목록이 비어있습니다.');
      await tryAlternativeDeviceList(token);
    }
  } catch (err) {
    console.error('❌ 디바이스 목록 조회 실패:', err.response?.data || err.message);
    await tryAlternativeDeviceList(token);
  }

  // ── TEST 3: 특정 디바이스 ID가 있으면 상태 조회 ─────────
  const testDeviceId = process.env.TEST_DEVICE_ID;
  if (testDeviceId) {
    console.log(`\n[TEST 3] 도어락 상태 조회 (Device ID: ${testDeviceId})...`);
    try {
      const statusRes = await tuyaRequest('GET', `/v1.0/devices/${testDeviceId}`, null, token);
      if (statusRes.success) {
        const d = statusRes.result;
        console.log('✅ 디바이스 정보:');
        console.log(`  이름: ${d.name}`);
        console.log(`  온라인: ${d.online ? '✅ 온라인' : '❌ 오프라인'}`);
        console.log(`  카테고리: ${d.category}`);
        console.log(`  모델: ${d.model || '정보 없음'}`);

        // 도어락 DP 상태
        const dpRes = await tuyaRequest('GET', `/v1.0/devices/${testDeviceId}/status`, null, token);
        if (dpRes.success) {
          console.log('\n  도어락 상태:');
          dpRes.result.forEach(dp => {
            console.log(`    ${dp.code}: ${dp.value}`);
          });
        }
      }
    } catch (err) {
      console.error('❌ 디바이스 상태 조회 실패:', err.response?.data || err.message);
    }

    // ── TEST 4: 임시 비밀번호 생성 테스트 ─────────────────
    console.log(`\n[TEST 4] 임시 비밀번호 생성 테스트...`);
    try {
      // 방법 1: 티켓 방식 (일부 Tuya 스마트락 사용)
      console.log('  → 티켓 발급 시도...');
      const ticketRes = await tuyaRequest(
        'POST',
        `/v1.0/devices/${testDeviceId}/door-lock/password-ticket`,
        null,
        token
      );
      if (ticketRes.success) {
        const ticketId = ticketRes.result?.ticket_id;
        console.log(`  ✅ 티켓 발급 성공: ${ticketId}`);

        // 암호화된 비밀번호 생성 (투야 락 암호화 방식)
        const rawPassword = '123456';
        const encryptedPwd = encryptPassword(rawPassword, ticketRes.result?.ticket_key || '');

        const pwdRes = await tuyaRequest(
          'POST',
          `/v1.0/devices/${testDeviceId}/door-lock/temp-password`,
          {
            ticket_id: ticketId,
            password: encryptedPwd,
            effective_time: Math.floor(Date.now() / 1000),
            invalid_time: Math.floor(Date.now() / 1000) + 3600,  // 1시간 후
            name: '테스트_게스트',
            type: 0
          },
          token
        );
        if (pwdRes.success) {
          console.log('  ✅ 임시 비밀번호 생성 성공!');
          console.log(`     비밀번호 ID: ${pwdRes.result?.id || pwdRes.result}`);
          console.log(`     실제 비밀번호: ${rawPassword}#`);
        } else {
          console.log('  ⚠️  비밀번호 생성 응답:', JSON.stringify(pwdRes));
        }
      }
    } catch (ticketErr) {
      // 방법 2: 직접 방식
      console.log('  → 직접 방식으로 재시도...');
      try {
        const pwdRes = await tuyaRequest(
          'POST',
          `/v1.0/devices/${testDeviceId}/door-lock/temp-password`,
          {
            name: '테스트_게스트',
            password: '123456',
            effective_time: Math.floor(Date.now() / 1000),
            invalid_time: Math.floor(Date.now() / 1000) + 3600,
            type: 0
          },
          token
        );
        if (pwdRes.success) {
          console.log('  ✅ 임시 비밀번호 생성 성공 (직접 방식)!');
        } else {
          console.log('  ⚠️  응답:', JSON.stringify(pwdRes));
        }
      } catch (directErr) {
        console.error('  ❌ 임시 비밀번호 생성 실패:', directErr.response?.data || directErr.message);
        console.log('\n  💡 H5000 도어락 비밀번호 API 경로가 다를 수 있습니다.');
        console.log('     투야 콘솔 → API Explorer에서 아래 항목 확인:');
        console.log('     Smart Home → Device Management → Lock');
      }
    }
  } else {
    console.log('\n[TEST 3, 4] 건너뜀 — TEST_DEVICE_ID 가 설정되지 않음');
    console.log('  .env 또는 터미널에서 설정 후 재실행:');
    console.log('  TEST_DEVICE_ID=your_device_id node src/scripts/testTuya.js');
  }

  console.log('\n========================================');
  console.log('  테스트 완료');
  console.log('========================================\n');
}

// ─── 대안 디바이스 목록 조회 ──────────────────────────────────
async function tryAlternativeDeviceList(token) {
  console.log('  대안 방법으로 디바이스 조회 시도...');
  try {
    const res = await tuyaRequest('GET', '/v1.0/devices?page_size=50', null, token);
    if (res.success && res.result?.list?.length > 0) {
      console.log(`✅ 디바이스 ${res.result.list.length}개:\n`);
      res.result.list.forEach((d, i) => {
        console.log(`  [${i + 1}] ${d.name} | ID: ${d.id} | 온라인: ${d.online ? '✅' : '❌'}`);
      });
    } else {
      console.log('⚠️  디바이스 없음. 아래 확인사항:');
      console.log('  1. 투야 콘솔 → Cloud 프로젝트 → "Link Tuya App Account" 완료했는지');
      console.log('  2. Smart Life 앱에서 H5000 도어락이 추가되어 있는지');
      console.log('  3. 프로젝트 Data Center 가 디바이스와 같은 지역인지');
    }
  } catch (e) {
    console.error('  대안 조회도 실패:', e.response?.data || e.message);
  }
}

// ─── 투야 락 비밀번호 암호화 (일부 모델 필요) ────────────────
function encryptPassword(password, ticketKey) {
  if (!ticketKey) return password;
  try {
    const key = crypto.enc.Utf8.parse(ticketKey.substring(0, 16));
    const encrypted = crypto.AES.encrypt(password, key, {
      mode: crypto.mode.ECB,
      padding: crypto.pad.Pkcs7
    });
    return encrypted.toString();
  } catch (e) {
    return password;
  }
}

main().catch(err => {
  console.error('\n❌ 예상치 못한 오류:', err.message);
  process.exit(1);
});
