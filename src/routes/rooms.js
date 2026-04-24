const express = require('express');
const router = express.Router();
const prisma = require('../config/prisma');

// 모든 객실 조회
router.get('/', async (req, res, next) => {
  try {
    const rooms = await prisma.room.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        checkInTime: true,
        checkOutTime: true,
        images: true,
        amenities: true
        // tuyaDeviceId는 외부에 노출하지 않음
      }
    });
    res.json({ rooms });
  } catch (err) {
    next(err);
  }
});

// 특정 객실 조회
router.get('/:id', async (req, res, next) => {
  try {
    const room = await prisma.room.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        name: true,
        description: true,
        price: true,
        checkInTime: true,
        checkOutTime: true,
        images: true,
        amenities: true
      }
    });
    if (!room) return res.status(404).json({ error: '객실을 찾을 수 없습니다.' });
    res.json({ room });
  } catch (err) {
    next(err);
  }
});

// 특정 날짜 예약 가능 여부 확인
router.get('/:id/availability', async (req, res, next) => {
  try {
    const { checkIn, checkOut } = req.query;
    if (!checkIn || !checkOut) {
      return res.status(400).json({ error: '체크인/체크아웃 날짜가 필요합니다.' });
    }

    const conflicts = await prisma.reservation.findFirst({
      where: {
        roomId: req.params.id,
        status: { in: ['paid', 'checked_in'] },
        AND: [
          { checkIn: { lt: new Date(checkOut) } },
          { checkOut: { gt: new Date(checkIn) } }
        ]
      }
    });

    res.json({ available: !conflicts });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
