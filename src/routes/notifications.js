const express = require('express');
const router = express.Router();

// 알림 방법 변경 (예약 전)
router.post('/test', async (req, res, next) => {
  try {
    const { phone, method } = req.body;
    const { sendSMS } = require('../services/notificationService');
    if (method === 'sms') {
      await sendSMS(phone, '[스마트스테이] 문자 알림이 정상적으로 설정되었습니다.');
    }
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
