const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const prisma = require('../config/prisma');
const { createTempPassword } = require('../services/tuyaService');
const { sendDoorCode } = require('../services/notificationService');

// 예약 생성
router.post('/', async (req, res, next) => {
  try {
    const { roomId, guestName, guestPhone, notifyMethod, checkIn, checkOut } = req.body;

    if (!roomId || !guestName || !guestPhone || !checkIn || !checkOut) {
      return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    const room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room) return res.status(404).json({ error: '객실을 찾을 수 없습니다.' });

    // 예약 충돌 확인
    const conflict = await prisma.reservation.findFirst({
      where: {
        roomId,
        status: { in: ['paid', 'checked_in'] },
        AND: [
          { checkIn: { lt: new Date(checkOut) } },
          { checkOut: { gt: new Date(checkIn) } }
        ]
      }
    });
    if (conflict) return res.status(409).json({ error: '해당 날짜에 이미 예약이 있습니다.' });

    // 숙박 일수 계산
    const nights = Math.ceil(
      (new Date(checkOut) - new Date(checkIn)) / (1000 * 60 * 60 * 24)
    );
    const totalPrice = room.price * nights;

    // 예약 + 결제 레코드 생성
    const orderId = `ORDER-${uuidv4().replace(/-/g, '').substring(0, 20)}`;
    const reservation = await prisma.reservation.create({
      data: {
        roomId,
        guestName,
        guestPhone,
        notifyMethod: notifyMethod || 'sms',
        checkIn: new Date(checkIn),
        checkOut: new Date(checkOut),
        totalPrice,
        status: 'pending',
        payment: {
          create: {
            orderId,
            amount: totalPrice,
            status: 'pending'
          }
        }
      },
      include: { room: true, payment: true }
    });

    res.status(201).json({
      reservation: {
        id: reservation.id,
        orderId: reservation.payment.orderId,
        amount: reservation.totalPrice,
        roomName: reservation.room.name,
        checkIn: reservation.checkIn,
        checkOut: reservation.checkOut,
        guestName: reservation.guestName
      }
    });
  } catch (err) {
    next(err);
  }
});

// 예약 조회 (핸드폰번호로)
router.get('/my', async (req, res, next) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: '전화번호가 필요합니다.' });

    const reservations = await prisma.reservation.findMany({
      where: { guestPhone: phone },
      include: { room: { select: { name: true, images: true } }, payment: true },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      reservations: reservations.map(r => ({
        id: r.id,
        roomName: r.room.name,
        roomImage: r.room.images[0],
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        totalPrice: r.totalPrice,
        status: r.status,
        doorCode: r.status === 'paid' || r.status === 'checked_in' ? r.doorCode : null,
        paymentStatus: r.payment?.status
      }))
    });
  } catch (err) {
    next(err);
  }
});

// 도어락 코드 재전송
router.post('/:id/resend-code', async (req, res, next) => {
  try {
    const reservation = await prisma.reservation.findUnique({
      where: { id: req.params.id },
      include: { room: true }
    });
    if (!reservation) return res.status(404).json({ error: '예약을 찾을 수 없습니다.' });
    if (!reservation.doorCode) return res.status(400).json({ error: '도어락 코드가 없습니다.' });

    await sendDoorCode({
      phone: reservation.guestPhone,
      notifyMethod: reservation.notifyMethod,
      guestName: reservation.guestName,
      roomName: reservation.room.name,
      doorCode: reservation.doorCode,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut
    });

    res.json({ success: true, message: '코드를 재전송했습니다.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
