const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

// 간단한 API 키 인증 미들웨어
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: '인증 실패' });
  }
  next();
}

// 모든 예약 조회
router.get('/reservations', adminAuth, async (req, res, next) => {
  try {
    const reservations = await prisma.reservation.findMany({
      include: { room: true, payment: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ reservations });
  } catch (err) {
    next(err);
  }
});

// 객실 등록
router.post('/rooms', adminAuth, async (req, res, next) => {
  try {
    const { name, description, price, checkInTime, checkOutTime, images, amenities, tuyaDeviceId } = req.body;
    const room = await prisma.room.create({
      data: { name, description, price, checkInTime, checkOutTime, images, amenities, tuyaDeviceId }
    });
    res.status(201).json({ room });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
