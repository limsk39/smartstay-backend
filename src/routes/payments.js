const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');
const { confirmPayment } = require('../services/paymentService');
const { createTempPassword } = require('../services/tuyaService');
const { sendDoorCode } = require('../services/notificationService');

// 결제 승인 (토스페이먼츠 콜백)
router.post('/confirm', async (req, res, next) => {
  try {
    const { paymentKey, orderId, amount } = req.body;

    if (!paymentKey || !orderId || !amount) {
      return res.status(400).json({ error: '결제 정보가 누락되었습니다.' });
    }

    // DB에서 주문 확인
    const payment = await prisma.payment.findUnique({
      where: { orderId },
      include: {
        reservation: {
          include: { room: true }
        }
      }
    });

    if (!payment) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });
    if (payment.amount !== Number(amount)) {
      return res.status(400).json({ error: '결제 금액이 일치하지 않습니다.' });
    }
    if (payment.status === 'done') {
      return res.json({ success: true, already: true });
    }

    // 토스페이먼츠 결제 승인
    const tossResult = await confirmPayment(paymentKey, orderId, amount);

    // 투야 임시 비밀번호 생성
    const { reservation } = payment;
    let doorCode       = null;
    let doorPasswordId = null;

    try {
      const doorResult = await createTempPassword(
        reservation.room.tuyaDeviceId,
        reservation.checkIn,
        reservation.checkOut,
        reservation.guestName
      );
      doorCode       = doorResult.password;
      doorPasswordId = doorResult.passwordId || null;
    } catch (doorError) {
      console.error('도어락 비밀번호 생성 실패:', doorError);
      // 도어락 실패해도 예약은 완료 처리
      doorCode = Math.floor(100000 + Math.random() * 900000).toString();
    }

    // DB 업데이트 (트랜잭션)
    await prisma.$transaction([
      prisma.payment.update({
        where: { orderId },
        data: {
          paymentKey,
          status: 'done',
          method: tossResult.method,
          paidAt: new Date()
        }
      }),
      prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'paid',
          doorCode,
          doorPasswordId,
          doorCodeSentAt: new Date()
        }
      })
    ]);

    // 알림 전송 (비동기)
    sendDoorCode({
      phone: reservation.guestPhone,
      notifyMethod: reservation.notifyMethod,
      guestName: reservation.guestName,
      roomName: reservation.room.name,
      doorCode,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut
    }).catch(err => console.error('알림 전송 오류:', err));

    res.json({
      success: true,
      reservationId: reservation.id,
      doorCode,
      roomName: reservation.room.name,
      checkIn: reservation.checkIn,
      checkOut: reservation.checkOut,
      guestName: reservation.guestName,
      method: tossResult.method
    });
  } catch (err) {
    // 결제 실패 처리
    if (req.body.orderId) {
      await prisma.payment.updateMany({
        where: { orderId: req.body.orderId },
        data: { status: 'failed' }
      }).catch(() => {});
    }
    next(err);
  }
});

// 결제 실패 처리
router.post('/fail', async (req, res, next) => {
  try {
    const { orderId, errorCode, errorMessage } = req.body;
    if (orderId) {
      await prisma.payment.updateMany({
        where: { orderId },
        data: { status: 'failed' }
      });
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
