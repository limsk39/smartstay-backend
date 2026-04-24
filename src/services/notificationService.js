/**
 * notificationService.js
 * ─────────────────────────────────────────────────────────
 * 솔라피(CoolSMS) SDK 하나로 SMS + 카카오 알림톡 모두 처리
 *
 * .env 설정에 따라 자동으로 동작:
 *   키 없음            → 콘솔 시뮬레이션 (개발용)
 *   COOLSMS_* 만 있음  → SMS 발송
 *   KAKAO_PFID 도 있음 → 카카오 알림톡 발송 (실패 시 SMS 폴백)
 * ─────────────────────────────────────────────────────────
 */
require('dotenv').config();
const coolsms = require('coolsms-node-sdk').default;

/* ── 클라이언트 초기화 ── */
const API_KEY    = process.env.COOLSMS_API_KEY    || '';
const API_SECRET = process.env.COOLSMS_API_SECRET || '';
const FROM_NUM   = process.env.COOLSMS_FROM_NUMBER || '';

// 카카오 알림톡에 필요한 값
const KAKAO_PFID        = process.env.KAKAO_PFID        || '';  // KA01PF...
const KAKAO_TEMPLATE_ID = process.env.KAKAO_TEMPLATE_ID || '';  // KA01TP...

const hasKeys   = API_KEY && API_SECRET && FROM_NUM;
const hasKakao  = hasKeys && KAKAO_PFID && KAKAO_TEMPLATE_ID;

let client = null;
if (hasKeys) {
  client = new coolsms(API_KEY, API_SECRET);
  console.log(`[알림] CoolSMS 초기화 완료 | 카카오: ${hasKakao ? '✅' : '❌ (SMS만 발송)'}`);
} else {
  console.log('[알림] CoolSMS 키 없음 → 콘솔 시뮬레이션 모드');
}

/* ── 메시지 본문 ── */
function buildMessage({ guestName, roomName, doorCode, checkIn, checkOut }) {
  return (
    `[스마트스테이] 예약 확정 안내\n\n` +
    `${guestName}님, 예약이 확정되었습니다.\n\n` +
    `■ 객실: ${roomName}\n` +
    `■ 체크인: ${checkIn}\n` +
    `■ 체크아웃: ${checkOut}\n` +
    `■ 도어락 비밀번호: ${doorCode}#\n\n` +
    `비밀번호는 체크아웃 후 자동 삭제됩니다.\n` +
    `감사합니다. 🏨`
  );
}

/* ── SMS 발송 ── */
async function sendSMS(to, vars) {
  const phone = to.replace(/-/g, '');
  const text  = buildMessage(vars);

  if (!client) {
    console.log('\n[SMS 시뮬레이션 📱]');
    console.log(`  수신: ${phone}`);
    console.log(`  내용:\n${text}\n`);
    return { success: true, simulated: true };
  }

  const result = await client.sendOne({ to: phone, from: FROM_NUM, text });
  console.log(`[SMS] ✅ 발송 완료 → ${phone}`);
  return { success: true, result };
}

/* ── 카카오 알림톡 발송 ── */
async function sendKakao(to, vars) {
  const phone = to.replace(/-/g, '');

  if (!client) {
    console.log('\n[카카오 시뮬레이션 💛]');
    console.log(`  수신: ${phone}`);
    console.log(`  내용:\n${buildMessage(vars)}\n`);
    return { success: true, simulated: true };
  }

  if (!hasKakao) {
    console.log('[카카오] KAKAO_PFID / KAKAO_TEMPLATE_ID 미설정 → SMS로 대체 발송');
    return sendSMS(to, vars);
  }

  try {
    // 솔라피 SDK로 카카오 알림톡 발송
    const result = await client.sendOne({
      to:   phone,
      from: FROM_NUM,
      kakaoOptions: {
        pfId:       KAKAO_PFID,
        templateId: KAKAO_TEMPLATE_ID,
        // 템플릿의 변수명과 반드시 일치해야 합니다
        variables: {
          '#{이름}':     vars.guestName,
          '#{객실명}':   vars.roomName,
          '#{체크인}':   vars.checkIn,
          '#{체크아웃}': vars.checkOut,
          '#{비밀번호}': vars.doorCode,
        },
      },
    });
    console.log(`[카카오] ✅ 알림톡 발송 완료 → ${phone}`);
    return { success: true, result };
  } catch (err) {
    console.error(`[카카오] ❌ 알림톡 실패 (${err.message}) → SMS로 폴백`);
    return sendSMS(to, vars);  // 카카오 실패 시 자동으로 문자 발송
  }
}

/* ── 날짜 포맷 ── */
function fmt(dt) {
  return new Date(dt).toLocaleString('ko-KR', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

/* ── 통합 발송 (외부에서 호출하는 함수) ── */
async function sendDoorCode({ phone, notifyMethod, guestName, roomName, doorCode, checkIn, checkOut }) {
  const vars = {
    guestName,
    roomName,
    doorCode,
    checkIn:  fmt(checkIn),
    checkOut: fmt(checkOut),
  };

  if (notifyMethod === 'kakao') {
    return sendKakao(phone, vars);
  } else {
    return sendSMS(phone, vars);
  }
}

module.exports = { sendDoorCode, sendSMS, sendKakao };
