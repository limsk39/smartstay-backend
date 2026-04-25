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

  // 🔐 Tuya 임시 비밀번호 등록 (체크인~체크아웃 기간)
  try {
    const checkInTs  = Math.floor(new Date(reservation.checkIn).getTime()  / 1000);
    const checkOutTs = Math.floor(new Date(reservation.checkOut).getTime() / 1000);
    const tuyaResult = await tuya.createTempPassword(
      room?.tuyaDeviceId,
      reservation.guestName,
      doorCode,
      checkInTs,
      checkOutTs
    );
    if (tuyaResult.success && !tuyaResult.simulated) {
      reservation.tuyaPasswordId = tuyaResult.result?.id;
      console.log(`[Tuya] 🔑 도어락 임시 비번 등록 완료 (${doorCode}#)`);
    }
  } catch (err) {
    console.error('[Tuya] 임시 비번 등록 실패:', err.message);
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
    return { ...r, roomName: room?.name || r.roomId, paymentStatus: payment?.status };
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

// 제품 스펙 조회 (product ID로)
app.get('/api/diag/tuya/product-functions', async (req, res) => {
  try {
    const pid = req.query.pid || 'az16629743642179xB5K';
    const [r1, r2] = await Promise.all([
      tuya.tuyaRequest('GET', `/v1.0/iot-03/products/${pid}/functions`),
      tuya.tuyaRequest('GET', `/v1.0/devices/${process.env.TUYA_DEVICE_ID}/information`),
    ]);
    res.json({ product_functions: r1, device_info: r2 });
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
