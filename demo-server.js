/**
 * 스마트스테이 데모 서버
 * DB / 투야 / 토스페이먼츠 / SMS 없이 바로 실행 가능
 * 실행: node demo-server.js
 */

// .env 로드 (있으면 실결제 키 사용)
try { require('dotenv').config(); } catch(e) {}

const express = require('express');
const cors    = require('cors');
const https   = require('https');
const { v4: uuidv4 } = require('uuid');

// 문자/카카오 알림 서비스 로드
let sendDoorCode = null;
try {
  sendDoorCode = require('./src/services/notificationService').sendDoorCode;
  console.log('📱 알림 서비스 로드됨');
} catch(e) {
  console.log('⚠️  알림 서비스 로드 실패 (콘솔 출력으로 대체):', e.message);
}

// Tuya 도어락 연동 로드
const tuya = require('./tuya');

const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || '';
const IS_REAL_PAYMENT = TOSS_SECRET_KEY && !TOSS_SECRET_KEY.includes('여기에');

/* 토스 서버측 결제 승인 함수 */
function tossConfirm(paymentKey, orderId, amount) {
  return new Promise((resolve, reject) => {
    const body   = JSON.stringify({ paymentKey, orderId, amount });
    const auth   = Buffer.from(TOSS_SECRET_KEY + ':').toString('base64');
    const opts   = {
      hostname: 'api.tosspayments.com',
      path: '/v1/payments/confirm',
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (res.statusCode === 200) resolve(json);
        else reject(new Error(json.message || '토스 결제 승인 실패'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ─── 인메모리 데이터 ────────────────────────────────────────

const ROOMS = [
  {
    id: 'room-101',
    name: '101호 · 스탠다드',
    description: '깔끔하고 아늑한 스탠다드 객실. 퀸사이즈 침대와 개인 욕실 완비.',
    price: 70000,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    images: [],
    amenities: ['Wi-Fi', '에어컨', 'TV', '냉장고', '드라이기'],
    tuyaDeviceId: process.env.TUYA_DEVICE_ID || 'DEMO-DEVICE-101'
  },
  {
    id: 'room-201',
    name: '201호 · 디럭스',
    description: '넓은 공간과 욕조가 있는 디럭스 객실. 킹사이즈 침대 제공.',
    price: 100000,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    images: [],
    amenities: ['Wi-Fi', '에어컨', 'TV', '냉장고', '욕조', '드라이기', '전기포트'],
    tuyaDeviceId: process.env.TUYA_DEVICE_ID || 'DEMO-DEVICE-201'
  },
  {
    id: 'room-301',
    name: '301호 · 프리미엄',
    description: '최상층 파노라마 뷰의 프리미엄 스위트. 별도 거실 공간 포함.',
    price: 150000,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    images: [],
    amenities: ['Wi-Fi', '에어컨', 'TV', '냉장고', '욕조', '테라스', '미니바', '드라이기'],
    tuyaDeviceId: process.env.TUYA_DEVICE_ID || 'DEMO-DEVICE-301'
  }
];

// 예약 저장소 (인메모리)
const reservations = [];
const payments     = [];

// ─── 헬퍼 ───────────────────────────────────────────────────

function generateDoorCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateOrderId() {
  return 'DEMO-' + uuidv4().replace(/-/g, '').substring(0, 16).toUpperCase();
}

function hasConflict(roomId, checkIn, checkOut, excludeId = null) {
  return reservations.some(r =>
    r.roomId === roomId &&
    r.id !== excludeId &&
    ['paid', 'checked_in'].includes(r.status) &&
    new Date(r.checkIn) < new Date(checkOut) &&
    new Date(r.checkOut) > new Date(checkIn)
  );
}

// ─── 객실 API ───────────────────────────────────────────────

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: ROOMS.map(({ tuyaDeviceId, ...r }) => r) });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = ROOMS.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: '객실 없음' });
  const { tuyaDeviceId, ...safe } = room;
  res.json({ room: safe });
});

app.get('/api/rooms/:id/availability', (req, res) => {
  const { checkIn, checkOut } = req.query;
  const conflict = hasConflict(req.params.id, checkIn, checkOut);
  res.json({ available: !conflict });
});

// ─── 예약 API ───────────────────────────────────────────────

app.post('/api/reservations', (req, res) => {
  const { roomId, guestName, guestPhone, notifyMethod, checkIn, checkOut } = req.body;

  if (!roomId || !guestName || !guestPhone || !checkIn || !checkOut) {
    return res.status(400).json({ error: '필수 정보 누락' });
  }

  const room = ROOMS.find(r => r.id === roomId);
  if (!room) return res.status(404).json({ error: '객실 없음' });

  if (hasConflict(roomId, checkIn, checkOut)) {
    return res.status(409).json({ error: '해당 날짜에 이미 예약이 있습니다.' });
  }

  const nights     = Math.max(1, Math.ceil((new Date(checkOut) - new Date(checkIn)) / 86400000));
  const totalPrice = room.price * nights;
  const orderId    = generateOrderId();
  const id         = uuidv4();

  const reservation = {
    id, roomId, guestName, guestPhone,
    notifyMethod: notifyMethod || 'sms',
    checkIn, checkOut, totalPrice,
    status: 'pending',
    doorCode: null,
    createdAt: new Date().toISOString()
  };

  reservations.push(reservation);
  payments.push({ orderId, reservationId: id, amount: totalPrice, status: 'pending' });

  res.status(201).json({
    reservation: {
      id,
      orderId,
      amount: totalPrice,
      roomName: room.name,
      checkIn,
      checkOut,
      guestName,
      guestPhone
    }
  });
});

app.get('/api/reservations/my', (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: '전화번호 필요' });

  const list = reservations
    .filter(r => r.guestPhone === phone.replace(/-/g, ''))
    .map(r => {
      const room = ROOMS.find(rm => rm.id === r.roomId);
      return {
        id: r.id,
        roomName: room?.name || r.roomId,
        roomImage: null,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        totalPrice: r.totalPrice,
        status: r.status,
        doorCode: ['paid', 'checked_in'].includes(r.status) ? r.doorCode : null,
        paymentStatus: payments.find(p => p.reservationId === r.id)?.status || 'pending'
      };
    })
    .sort((a, b) => new Date(b.checkIn) - new Date(a.checkIn));

  res.json({ reservations: list });
});

app.post('/api/reservations/:id/resend-code', (req, res) => {
  const r = reservations.find(r => r.id === req.params.id);
  if (!r || !r.doorCode) return res.status(400).json({ error: '코드 없음' });
  console.log(`[데모] 코드 재전송: ${r.guestPhone} → ${r.doorCode}#`);
  res.json({ success: true });
});

// ─── 결제 API (데모: 즉시 승인 / 실결제: 토스 API 호출) ─────

app.post('/api/payments/confirm', async (req, res) => {
  const { paymentKey, orderId, amount } = req.body;

  const payment = payments.find(p => p.orderId === orderId);
  if (!payment) return res.status(404).json({ error: '주문 없음' });

  const reservation = reservations.find(r => r.id === payment.reservationId);
  if (!reservation) return res.status(404).json({ error: '예약 없음' });

  // ── 금액 검증 ──
  if (Number(amount) !== payment.amount) {
    return res.status(400).json({ error: '결제 금액 불일치' });
  }

  let method = '카드 (데모)';

  // ── 실결제 모드: 토스 승인 API 호출 ──
  if (IS_REAL_PAYMENT && paymentKey && !paymentKey.startsWith('DEMO-')) {
    try {
      const tossResult = await tossConfirm(paymentKey, orderId, amount);
      method = tossResult.method || '토스페이먼츠';
      console.log(`\n[토스] ✅ 결제 승인 완료!`);
      console.log(`  paymentKey: ${paymentKey.substring(0,20)}...`);
      console.log(`  금액: ${amount.toLocaleString()}원`);
      console.log(`  수단: ${method}\n`);
    } catch (err) {
      console.error('[토스] 결제 승인 실패:', err.message);
      return res.status(400).json({ error: '결제 승인 실패: ' + err.message });
    }
  }

  const room = ROOMS.find(r => r.id === reservation.roomId);
  const doorCode = generateDoorCode();

  // 상태 업데이트
  payment.status       = 'done';
  reservation.status   = 'paid';
  reservation.doorCode = doorCode;

  console.log(`\n[스마트스테이] ✅ 예약 확정!`);
  console.log(`  예약자: ${reservation.guestName}`);
  console.log(`  객실: ${room?.name}`);
  console.log(`  도어락 비번: ${doorCode}#`);
  console.log(`  전달방법: ${reservation.notifyMethod} → ${reservation.guestPhone}\n`);

  // 🔐 Tuya 임시 비밀번호 등록 시도 (현재 H5000 펌웨어 호환 이슈로 자동 등록 불가)
  // → 호스트가 Tuya 앱에서 수동 등록하는 하이브리드 방식
  reservation.doorCodeRegistered     = false;            // 호스트가 등록 후 true 처리
  reservation.doorCodeRegisteredAt   = null;
  reservation.needsManualDoorRegister = true;

  try {
    const checkInTs  = Math.floor(new Date(reservation.checkIn).getTime()  / 1000);
    const checkOutTs = Math.floor(new Date(reservation.checkOut).getTime() / 1000);
    const tuyaResult = await tuya.createTempPassword(
      room?.tuyaDeviceId, reservation.guestName, doorCode, checkInTs, checkOutTs
    );
    // 시뮬레이션 모드(키 없음)는 자동 완료 처리
    if (tuyaResult.simulated) {
      reservation.doorCodeRegistered     = true;
      reservation.doorCodeRegisteredAt   = new Date().toISOString();
      reservation.needsManualDoorRegister = false;
      reservation.tuyaPasswordId         = tuyaResult.passwordId || null;
    }
    // (실연동은 현재 success 응답이 와도 keypad 미반영 → 수동 등록 유지)
  } catch (err) {
    console.error('[Tuya] API 호출 실패:', err.message);
  }

  // 호스트용 콘솔 알림
  if (reservation.needsManualDoorRegister) {
    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│  🔔 호스트 작업 필요 — Tuya 앱 수동 등록   │');
    console.log('├─────────────────────────────────────────────┤');
    console.log(`│  객실:      ${room?.name}`);
    console.log(`│  예약자:    ${reservation.guestName}`);
    console.log(`│  비밀번호:  ${doorCode}#`);
    console.log(`│  체크인:    ${reservation.checkIn}`);
    console.log(`│  체크아웃:  ${reservation.checkOut}`);
    console.log('└─────────────────────────────────────────────┘\n');
  }

  // 📱 문자 / 카카오 알림 발송
  if (sendDoorCode) {
    sendDoorCode({
      phone:         reservation.guestPhone,
      notifyMethod:  reservation.notifyMethod || 'sms',
      guestName:     reservation.guestName,
      roomName:      room?.name || reservation.roomId,
      doorCode,
      checkIn:       reservation.checkIn,
      checkOut:      reservation.checkOut,
    }).then(r => {
      if (r?.simulated) {
        console.log(`  [시뮬레이션] 키 미설정 — 실제 문자 미발송`);
      } else {
        console.log(`  [알림] ✅ ${reservation.notifyMethod === 'kakao' ? '카카오' : 'SMS'} 발송 완료`);
      }
    }).catch(err => {
      console.error(`  [알림] ❌ 발송 실패:`, err.message);
    });
  }

  res.json({
    success:       true,
    reservationId: reservation.id,
    doorCode,
    roomName:      room?.name,
    checkIn:       reservation.checkIn,
    checkOut:      reservation.checkOut,
    guestName:     reservation.guestName,
    method
  });
});

app.post('/api/payments/fail', (req, res) => res.json({ success: true }));

// ─── 알림 API ───────────────────────────────────────────────

app.post('/api/notifications/test', (req, res) => {
  console.log(`[데모] 알림 테스트: ${req.body.method} → ${req.body.phone}`);
  res.json({ success: true });
});

// ─── 관리자 API ──────────────────────────────────────────────

const ADMIN_ID       = 'admin';
const ADMIN_PASSWORD = '1234';  // 실제 운영 시 변경 필요
const ADMIN_TOKEN    = 'smartstay-admin-token-2024';

// 관리자 인증 미들웨어
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: '인증 필요' });
  next();
}

// 관리자 로그인
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_ID && password === ADMIN_PASSWORD) {
    res.json({ success: true, token: ADMIN_TOKEN, username: ADMIN_ID });
  } else {
    res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다.' });
  }
});

// 관리자 토큰 확인
app.get('/api/admin/me', adminAuth, (req, res) => {
  res.json({ success: true, username: ADMIN_ID });
});

// 관리자 전용 객실 목록 (tuyaDeviceId 포함)
app.get('/api/admin/rooms', adminAuth, (req, res) => {
  res.json({ rooms: ROOMS });
});

// 객실 추가
app.post('/api/admin/rooms', adminAuth, (req, res) => {
  const { name, description, price, checkInTime, checkOutTime, amenities, tuyaDeviceId } = req.body;
  if (!name || !price) return res.status(400).json({ error: '객실명과 요금은 필수입니다.' });

  const newRoom = {
    id:           'room-' + uuidv4().substring(0, 8),
    name,
    description:  description || '',
    price:        Number(price),
    checkInTime:  checkInTime  || '15:00',
    checkOutTime: checkOutTime || '11:00',
    images:       [],
    amenities:    amenities || [],
    tuyaDeviceId: tuyaDeviceId || ''
  };
  ROOMS.push(newRoom);
  console.log(`[관리자] 객실 추가: ${newRoom.name}`);
  res.status(201).json({ room: newRoom });
});

// 객실 수정
app.put('/api/admin/rooms/:id', adminAuth, (req, res) => {
  const idx = ROOMS.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '객실 없음' });

  const { name, description, price, checkInTime, checkOutTime, amenities, tuyaDeviceId } = req.body;
  ROOMS[idx] = {
    ...ROOMS[idx],
    ...(name         && { name }),
    ...(description  !== undefined && { description }),
    ...(price        && { price: Number(price) }),
    ...(checkInTime  && { checkInTime }),
    ...(checkOutTime && { checkOutTime }),
    ...(amenities    && { amenities }),
    ...(tuyaDeviceId !== undefined && { tuyaDeviceId })
  };
  console.log(`[관리자] 객실 수정: ${ROOMS[idx].name}`);
  res.json({ room: ROOMS[idx] });
});

// 객실 삭제
app.delete('/api/admin/rooms/:id', adminAuth, (req, res) => {
  const idx = ROOMS.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '객실 없음' });
  const deleted = ROOMS.splice(idx, 1)[0];
  console.log(`[관리자] 객실 삭제: ${deleted.name}`);
  res.json({ success: true });
});

// 관리자 전용 예약 전체 목록
app.get('/api/admin/reservations', adminAuth, (req, res) => {
  const { status } = req.query;
  let list = reservations.map(r => {
    const room    = ROOMS.find(rm => rm.id === r.roomId);
    const payment = payments.find(p => p.reservationId === r.id);
    return {
      ...r,
      roomName:      room?.name || r.roomId,
      tuyaDeviceId:  room?.tuyaDeviceId,
      paymentStatus: payment?.status,
      // 호스트가 한눈에 보도록 도어락 등록 상태 노출
      doorCodeRegistered:      r.doorCodeRegistered === true,
      needsManualDoorRegister: r.needsManualDoorRegister === true,
    };
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (status) list = list.filter(r => r.status === status);
  res.json({ reservations: list });
});

// 관리자: 예약 상태 변경
app.patch('/api/admin/reservations/:id/status', adminAuth, (req, res) => {
  const reservation = reservations.find(r => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: '예약 없음' });

  const { status } = req.body;
  const validStatuses = ['pending', 'confirmed', 'checkin', 'checkout', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: '유효하지 않은 상태' });
  }

  reservation.status = status;
  console.log(`[관리자] 예약 상태 변경: ${reservation.guestName} → ${status}`);
  res.json({ success: true, reservation });
});

// ─── 관리자: 도어락 원격 제어 ────────────────────────────────

// 원격 잠금 해제
app.post('/api/admin/rooms/:id/unlock', adminAuth, async (req, res) => {
  const room = ROOMS.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: '객실 없음' });

  try {
    const result = await tuya.remoteUnlock(room.tuyaDeviceId);
    if (result.simulated) {
      return res.json({ success: true, simulated: true, message: '시뮬레이션: 잠금 해제됨' });
    }
    res.json({ success: result.success, message: '도어락 해제됨' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 도어락 상태 확인
app.get('/api/admin/rooms/:id/door-status', adminAuth, async (req, res) => {
  const room = ROOMS.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: '객실 없음' });

  try {
    const result = await tuya.getDeviceStatus(room.tuyaDeviceId);
    res.json({ success: true, status: result.result, tuyaEnabled: tuya.isTuyaEnabled() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 임시 비밀번호 목록 조회
app.get('/api/admin/rooms/:id/temp-passwords', adminAuth, async (req, res) => {
  const room = ROOMS.find(r => r.id === req.params.id);
  if (!room) return res.status(404).json({ error: '객실 없음' });

  try {
    const result = await tuya.getTempPasswords(room.tuyaDeviceId);
    res.json({ success: true, passwords: result.result || [], tuyaEnabled: tuya.isTuyaEnabled() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 체크아웃 시 임시 비밀번호 삭제
app.post('/api/admin/reservations/:id/checkout', adminAuth, async (req, res) => {
  const reservation = reservations.find(r => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: '예약 없음' });

  const room = ROOMS.find(r => r.id === reservation.roomId);
  reservation.status = 'checked_out';

  // Tuya 임시 비번 삭제
  if (reservation.tuyaPasswordId) {
    try {
      await tuya.deleteTempPassword(room?.tuyaDeviceId, reservation.tuyaPasswordId);
      reservation.tuyaPasswordId = null;
      console.log(`[Tuya] 🗑️ 체크아웃 임시 비번 삭제: ${reservation.guestName}`);
    } catch (err) {
      console.error('[Tuya] 임시 비번 삭제 실패:', err.message);
    }
  }

  res.json({ success: true, reservation });
});

// Tuya 연동 상태 확인
app.get('/api/admin/tuya/status', adminAuth, (req, res) => {
  res.json({
    enabled:  tuya.isTuyaEnabled(),
    deviceId: process.env.TUYA_DEVICE_ID ? '설정됨' : '미설정',
    message:  tuya.isTuyaEnabled() ? '✅ Tuya 도어락 연동 활성화' : '⚠️ 환경변수 미설정 (시뮬레이션 모드)',
  });
});

// ─── 도어락 수동 등록 관리 ──────────────────────────────────

// 도어락 등록 대기 목록 (호스트가 Tuya 앱에서 등록해야 할 예약)
app.get('/api/admin/door-codes/pending', adminAuth, (req, res) => {
  const pending = reservations
    .filter(r =>
      ['paid', 'confirmed', 'checkin'].includes(r.status) &&
      r.needsManualDoorRegister === true &&
      !r.doorCodeRegistered
    )
    .map(r => {
      const room = ROOMS.find(rm => rm.id === r.roomId);
      return {
        reservationId: r.id,
        guestName:     r.guestName,
        guestPhone:    r.guestPhone,
        roomId:        r.roomId,
        roomName:      room?.name || r.roomId,
        tuyaDeviceId:  room?.tuyaDeviceId,
        doorCode:      r.doorCode,
        checkIn:       r.checkIn,
        checkOut:      r.checkOut,
        createdAt:     r.createdAt,
      };
    })
    .sort((a, b) => new Date(a.checkIn) - new Date(b.checkIn));

  res.json({ count: pending.length, pending });
});

// 도어락 등록 완료 처리 (호스트가 Tuya 앱에서 등록 후 클릭)
app.post('/api/admin/reservations/:id/mark-door-registered', adminAuth, (req, res) => {
  const reservation = reservations.find(r => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: '예약 없음' });

  reservation.doorCodeRegistered     = true;
  reservation.doorCodeRegisteredAt   = new Date().toISOString();
  reservation.needsManualDoorRegister = false;

  console.log(`[관리자] ✅ 도어락 등록 완료 처리: ${reservation.guestName} (${reservation.doorCode}#)`);
  res.json({ success: true, reservation });
});

// 도어락 등록 완료 취소 (실수로 처리한 경우)
app.post('/api/admin/reservations/:id/unmark-door-registered', adminAuth, (req, res) => {
  const reservation = reservations.find(r => r.id === req.params.id);
  if (!reservation) return res.status(404).json({ error: '예약 없음' });

  reservation.doorCodeRegistered     = false;
  reservation.doorCodeRegisteredAt   = null;
  reservation.needsManualDoorRegister = true;

  res.json({ success: true, reservation });
});

// 장치 DP 함수 스펙 조회 (진단용 — 인증 없음)
app.get('/api/diag/tuya/functions', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const data = await tuya.tuyaRequest('GET', `/v1.0/devices/${did}/functions`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 장치 스펙 상세 조회 (진단용 — 인증 없음)
app.get('/api/diag/tuya/specification', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const data = await tuya.tuyaRequest('GET', `/v1.0/devices/${did}/specification`);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #1: 두 기기 모두 상세 정보 조회 ──────────────
// 확인사항: online 여부, 카테고리(jtmspro vs ble_gw), 이름
app.get('/api/diag/tuya/device-info', async (req, res) => {
  try {
    const did   = process.env.TUYA_DEVICE_ID;
    const gwDid = process.env.TUYA_GATEWAY_ID;

    const [lockInfo, gwInfo] = await Promise.all([
      tuya.tuyaRequest('GET', `/v1.0/devices/${did}`),
      gwDid ? tuya.tuyaRequest('GET', `/v1.0/devices/${gwDid}`) : Promise.resolve({ skipped: true })
    ]);

    const summarize = (info, label, id) => ({
      label,
      id,
      name:     info.result?.name,
      category: info.result?.category,         // jtmspro=도어락, ble_gw 등=게이트웨이
      online:   info.result?.online,
      sub:      info.result?.sub,              // true=서브기기(도어락), false=독립기기
      raw:      info
    });

    res.json({
      TUYA_DEVICE_ID_info:   summarize(lockInfo,  'TUYA_DEVICE_ID',  did),
      TUYA_GATEWAY_ID_info:  summarize(gwInfo,    'TUYA_GATEWAY_ID', gwDid || '(미설정)'),
      hint: 'category가 jtmspro이고 online=true인 쪽이 도어락입니다.'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #2: 광범위 시간 + 비번 123456 직접 등록 ───────
// 시간대/시계 오차를 완전 제거. 도어락에서 123456# 입력해보세요.
app.get('/api/diag/tuya/test-direct', async (req, res) => {
  try {
    const did   = process.env.TUYA_DEVICE_ID;
    const gwDid = process.env.TUYA_GATEWAY_ID;
    const password = req.query.pwd || '123456';
    const keyIndex = parseInt(req.query.slot || '1', 10);

    // ① TUYA_DEVICE_ID로 시도
    const r1 = await tuya.testCreatePassword(did, password, keyIndex);

    // ② TUYA_GATEWAY_ID로도 시도 (ID가 뒤바뀐 경우 대비)
    let r2 = null;
    if (gwDid && gwDid !== did) {
      r2 = await tuya.testCreatePassword(gwDid, password, keyIndex + 1);
    }

    res.json({
      instruction: `도어락 키패드에서 [${password}#] 를 눌러보세요 (슬롯 ${keyIndex})`,
      test_DEVICE_ID:  { deviceId: did,   ...r1 },
      test_GATEWAY_ID: r2 ? { deviceId: gwDid, ...r2 } : '(TUYA_GATEWAY_ID 없음)',
      time_window: '현재±7일 (시간대 오차 무관)',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #3: 기기 온라인 상태 실시간 확인 ──────────────
app.get('/api/diag/tuya/online', async (req, res) => {
  try {
    const did   = process.env.TUYA_DEVICE_ID;
    const gwDid = process.env.TUYA_GATEWAY_ID;

    const [s1, s2] = await Promise.all([
      tuya.tuyaRequest('GET', `/v1.0/devices/${did}/status`),
      gwDid ? tuya.tuyaRequest('GET', `/v1.0/devices/${gwDid}/status`) : Promise.resolve(null)
    ]);

    res.json({
      TUYA_DEVICE_ID:  { id: did,   status: s1.result },
      TUYA_GATEWAY_ID: { id: gwDid, status: s2?.result || '(미설정)' }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #4: BCD/일반 인코딩 차이가 없는 클린 테스트 ──
// 2026-01-01 ~ 2026-09-09 사용 → 월(1,9)/일(1,9) 모두 한 자리
// → BCD 인코딩이나 일반 hex나 바이트값이 동일 → 인코딩 의심 제거
// 비번 654321 슬롯3 / 비번 987654 슬롯4 (ASCII도 병행)
app.get('/api/diag/tuya/test-clean', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    // 2026-01-01T00:00:00Z  ← BCD/plain 인코딩 완전 동일
    const effectiveTime = 1767225600;
    // 2026-09-09T00:00:00Z  ← BCD/plain 인코딩 완전 동일
    const invalidTime   = 1788912000;

    // ① 현재 방식 (raw digits): 654321, 슬롯 3
    const r1 = await tuya.testCreatePassword(did, '654321', 3, effectiveTime, invalidTime);

    // ② ASCII 방식 (0x31~0x39): 같은 비번, 슬롯 4
    const r2 = await tuya.testCreatePasswordASCII(did, '654321', 4, effectiveTime, invalidTime);

    res.json({
      note: '2026-01-01 ~ 2026-09-09 (BCD=plain 인코딩 동일 날짜)',
      raw_digits: {
        instruction: '도어락에서 [654321#] 눌러보세요 (슬롯3)',
        rawHex: r1.rawHex,
        result: r1.result
      },
      ascii_digits: {
        instruction: '위 슬롯3 실패 시 도어락에서 [654321#] (슬롯4, ASCII인코딩)',
        rawHex: r2.rawHex,
        result: r2.result
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #5: remote_no_pd_setkey DP로 시도 ────────────
// unlock_method_create 가 계속 실패 → 이 DP 가 실제 키패드 비번용일 수 있음
app.get('/api/diag/tuya/test-nopd', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const now = Math.floor(Date.now() / 1000);
    const start = now - 86400;           // 어제
    const end   = now + 7 * 86400;      // 7일 후

    // 4바이트 Big-Endian 헬퍼
    const b4be = v => v.toString(16).padStart(8,'0').toUpperCase();
    // 4바이트 Little-Endian 헬퍼
    const b4le = v => {
      const b = Buffer.allocUnsafe(4); b.writeUInt32LE(v); return b.toString('hex').toUpperCase();
    };

    // 포맷 A: op(01)+len(06)+ASCII("123456")+start(4B BE)+end(4B BE)
    const fmtA = '01' + '06' + '313233343536' + b4be(start) + b4be(end);
    // 포맷 B: op(01)+len(06)+ASCII+start(4B LE)+end(4B LE)
    const fmtB = '01' + '06' + '313233343536' + b4le(start) + b4le(end);
    // 포맷 C: String 방식 — "123456" 을 문자열로 그냥 전달
    const fmtC = '123456';
    // 포맷 D: keyIndex(01)+len(06)+raw digits
    const fmtD = '01' + '06' + '010203040506';

    const send = (path, value) =>
      tuya.tuyaRequest('POST', path, { commands: [{ code: 'remote_no_pd_setkey', value }] });

    const [rA_iot, rA_leg, rB_iot, rC_iot, rD_iot] = await Promise.all([
      send(`/v1.0/iot-03/devices/${did}/commands`, fmtA),
      send(`/v1.0/devices/${did}/commands`,         fmtA),
      send(`/v1.0/iot-03/devices/${did}/commands`, fmtB),
      send(`/v1.0/iot-03/devices/${did}/commands`, fmtC),
      send(`/v1.0/iot-03/devices/${did}/commands`, fmtD),
    ]);

    res.json({
      instruction: 'API success 후 도어락에서 [123456#] 눌러보세요',
      A_BE_iot03:  { hex: fmtA, result: rA_iot },
      A_BE_legacy: { hex: fmtA, result: rA_leg },
      B_LE_iot03:  { hex: fmtB, result: rB_iot },
      C_string:    { value: fmtC, result: rC_iot },
      D_raw:       { hex: fmtD, result: rD_iot },
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #6: DP 전체 스펙 (타입/형식 확인) ─────────────
app.get('/api/diag/tuya/spec-detail', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const [spec, func] = await Promise.all([
      tuya.tuyaRequest('GET', `/v1.0/devices/${did}/specification`),
      tuya.tuyaRequest('GET', `/v1.0/devices/${did}/functions`),
    ]);
    // remote_no_pd_setkey / unlock_method_create 만 추출
    const interesting = ['remote_no_pd_setkey','unlock_method_create','unlock_method_delete','unlock_temporary'];
    const filter = (arr) => (arr||[]).filter(d => interesting.includes(d.code));
    res.json({
      specification_dps: filter(spec.result?.status).concat(filter(spec.result?.functions)),
      function_dps:      filter(func.result?.functions),
      raw_spec: spec,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #7: 원격 열기 직접 테스트 (인증 없음) ─────────
app.get('/api/diag/tuya/unlock-now', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const [r1, r2, r3, r4] = await Promise.all([
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, { commands: [{ code: 'unlock_remote', value: 0 }] }),
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, { commands: [{ code: 'open_close', value: true }] }),
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, { commands: [{ code: 'lock_motor_state', value: false }] }),
      tuya.tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, { commands: [{ code: 'unlock_remote', value: 0 }] }),
    ]);
    res.json({
      message: '문이 열리면 성공!',
      unlock_remote_legacy: r1, open_close_legacy: r2,
      lock_motor_false_legacy: r3, unlock_remote_iot03: r4,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── 핵심 진단 #8: lock_motor_state = TRUE 로 열기 시도 ──────
// false가 success였지만 안 열렸음 → true가 "열기" 신호일 수 있음
app.get('/api/diag/tuya/motor-unlock', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;

    // true / "unlock" / 1 등 여러 값 시도
    const [r1, r2, r3, r4] = await Promise.all([
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
        commands: [{ code: 'lock_motor_state', value: true }]
      }),
      tuya.tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
        commands: [{ code: 'lock_motor_state', value: true }]
      }),
      // lock_motor_state 가 문자열 enum 일 수 있음: "unlock"
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
        commands: [{ code: 'lock_motor_state', value: 'unlock' }]
      }).catch(e => ({ error: e.message })),
      // reverse 시도
      tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
        commands: [{ code: 'lock_motor_state', value: 'reverse' }]
      }).catch(e => ({ error: e.message })),
    ]);

    res.json({
      message: '지금 문이 열리면 성공! lock_motor_state=true 가 열기 신호입니다',
      motor_true_legacy: r1,
      motor_true_iot03:  r2,
      motor_unlock_str:  r3,
      motor_reverse_str: r4,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── 핵심 진단 #9: 4가지 포맷 변형 동시 테스트 ──────────────
// V0=현재(Type 0x00) / V2=Type 0x03(비번)+ASCII / V3=짧은포맷 / V4=Tuya표준
app.get('/api/diag/tuya/test-formats', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const password = req.query.pwd || '999111';
    const baseSlot = parseInt(req.query.slot || '10', 10);

    const results = await tuya.testAllFormats(did, password, baseSlot);

    res.json({
      instruction: `4가지 포맷으로 비번 ${password} 등록. 도어락에서 [${password}#] 시도 → 열리면 어떤 V가 맞는지 디바이스 로그에서 확인`,
      results,
      note: 'Tuya Developer Platform → Device Logs 에서 V0/V2/V3/V4 중 어느 것이 Report 응답을 받았는지 확인하세요',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #12: ★ unlock_method_create 단독 + 새 포맷 ★
// "Creat Temporary Password" 라벨을 받기 위한 시도
app.get('/api/diag/tuya/test-umc', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const password = req.query.pwd || '258369';
    const slot = parseInt(req.query.slot || '1', 10);
    const now = Math.floor(Date.now() / 1000);
    const start = now;
    const end = now + 24 * 3600;

    const tuyaModule = require('./tuya');
    const hexValue = tuyaModule.buildCreateRawSafe(password, start, end, slot);

    // unlock_method_create 만 시도
    const r1 = await tuya.tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: hexValue }]
    });
    const r2 = await tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'unlock_method_create', value: hexValue }]
    });

    res.json({
      instruction: `★ 도어락에서 [${password}#] 시도! unlock_method_create + 새포맷`,
      password, slot, hexValue,
      iot03_result: r1,
      legacy_result: r2,
      check: 'Tuya 디바이스 로그에서 라벨이 "Creat Temporary Password" 인지 확인',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #11: ★ 슬롯 1 고정 + remote_no_pd_setkey 만 ★
// AHE4 응답이 에러 추정 → 슬롯 1로 고정해서 시도
app.get('/api/diag/tuya/test-slot1', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const password = req.query.pwd || '147258';
    const slot = 1;  // ★ 앱이 쓰는 값 그대로
    const now = Math.floor(Date.now() / 1000);
    const start = now;
    const end = now + 24 * 3600;

    const tuyaModule = require('./tuya');
    const buildFn = tuyaModule.buildCreateRawSafe;
    const hexValue = buildFn(password, start, end, slot);

    // remote_no_pd_setkey 만 사용 (응답 받는 DP)
    const r1 = await tuya.tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
      commands: [{ code: 'remote_no_pd_setkey', value: hexValue }]
    });
    const r2 = await tuya.tuyaRequest('POST', `/v1.0/devices/${did}/commands`, {
      commands: [{ code: 'remote_no_pd_setkey', value: hexValue }]
    });

    res.json({
      instruction: `★ 도어락에서 [${password}#] 시도! 슬롯 1 + 진짜포맷`,
      password, slot,
      hexValue,
      compare_to_app: '앱 성공값: 03E40001000069F1C6D569F31...232311',
      our_value:     hexValue,
      iot03_result: r1,
      legacy_result: r2,
      next: 'Tuya 로그에서 Report 응답값 확인 — AAAB(=성공) 인지 다른값(=에러) 인지',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 핵심 진단 #10: ★ 실제 발견한 포맷으로 테스트 ★ ─────────
// Tuya 앱 패킷 캡처로 발견한 진짜 Lockpro H5000 포맷
// 21+N 바이트: 03 E4 00 01 00 00 [start BE] [end BE] [00×7] [ASCII pwd]
app.get('/api/diag/tuya/test-real', async (req, res) => {
  try {
    const did = process.env.TUYA_DEVICE_ID;
    const password = req.query.pwd || '789012';
    const slot = parseInt(req.query.slot || '5', 10);
    const now = Math.floor(Date.now() / 1000);
    const start = now;
    const end = now + 24 * 3600;

    const hexValue = require('./tuya').buildCreateRawSafe?.(password, start, end, slot)
      || tuya.testCreatePassword;  // fallback (안 쓰임)

    // tuya.js의 함수 직접 호출
    const tuyaModule = require('./tuya');

    // 여러 DP 코드 동시 시도
    const dpCodes = [
      'temp_password_create',
      'temp_password_set',
      'set_temp_password',
      'add_temp_pwd',
      'remote_no_pd_setkey',
      'unlock_method_create',
      'temp_pwd_set',
      'create_temp_password',
    ];

    // 실제 hex 값 생성
    const buildFn = tuyaModule.buildCreateRawSafe;
    let actualHex;
    if (typeof buildFn === 'function') {
      actualHex = buildFn(password, start, end, slot);
    } else {
      // tuya.js에서 export 안 됐으면 inline 구현
      const Buffer = require('buffer').Buffer;
      const N = password.length;
      const buf = Buffer.alloc(21 + N);
      let off = 0;
      buf[off++] = 0x03; buf[off++] = 0xE4;
      buf[off++] = 0x00; buf[off++] = slot & 0xFF;
      buf[off++] = 0x00; buf[off++] = 0x00;
      buf.writeUInt32BE(start, off); off += 4;
      buf.writeUInt32BE(end, off); off += 4;
      for (let i = 0; i < 7; i++) buf[off++] = 0x00;
      for (const ch of password) buf[off++] = ch.charCodeAt(0);
      actualHex = buf.toString('hex').toUpperCase();
    }

    const results = {};
    for (const code of dpCodes) {
      try {
        const r = await tuya.tuyaRequest('POST', `/v1.0/iot-03/devices/${did}/commands`, {
          commands: [{ code, value: actualHex }]
        });
        results[code] = { success: r.success, code: r.code, msg: r.msg };
      } catch (e) {
        results[code] = { error: e.message };
      }
    }

    res.json({
      instruction: `★ 도어락에서 [${password}#] 시도 → 열리면 어떤 code인지 디바이스 로그에서 확인!`,
      password,
      slot,
      hexValue: actualHex,
      hexLength: actualHex.length / 2 + ' bytes',
      decodedTimes: {
        start: new Date(start * 1000).toLocaleString('ko-KR'),
        end:   new Date(end * 1000).toLocaleString('ko-KR'),
      },
      attempted_dp_codes: results,
      next: 'Tuya 디바이스 로그에서 어떤 code가 Report 응답을 받았는지 확인',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 데모 전용: 현재 예약 현황 출력 ─────────────────────────

app.get('/api/demo/status', (req, res) => {
  res.json({
    rooms: ROOMS.length,
    reservations: reservations.length,
    paid: reservations.filter(r => r.status === 'paid').length,
    recentReservations: reservations.slice(-5).map(r => ({
      guestName: r.guestName,
      roomId:    r.roomId,
      status:    r.status,
      doorCode:  r.doorCode
    }))
  });
});

// ─── 실행 ────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  🏨 스마트스테이 서버 실행 중');
  console.log(`  http://localhost:${PORT}`);
  console.log('========================================');
  console.log('');
  console.log('  📦 샘플 객실: 3개 등록됨');
  console.log(`  💳 결제: ${IS_REAL_PAYMENT ? '✅ 토스페이먼츠 실결제 모드' : '🧪 데모 모드 (자동 승인)'}`);
  console.log(`  🔐 도어락: ${tuya.isTuyaEnabled() ? '✅ Tuya IoT 연동 (락프로 H5000)' : '🧪 시뮬레이션 모드 (TUYA 키 없음)'}`);
  console.log('  📱 SMS/카카오: 서버 콘솔에 출력');
  console.log('');
  console.log('  [데모 현황] http://localhost:3000/api/demo/status');
  console.log('========================================');
  console.log('');
});
