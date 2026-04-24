const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();

// 미들웨어
app.use(helmet());
app.use(cors({
  origin: [
    process.env.WEB_URL || 'http://localhost:5173',
    'exp://localhost:8081',
    /^http:\/\/192\.168\./,
    /^http:\/\/10\./
  ],
  credentials: true
}));
app.use(express.json());
app.use(morgan('dev'));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api/', limiter);

// 라우트
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/reservations', require('./routes/reservations'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/admin', require('./routes/admin'));

// 헬스체크
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || '서버 오류가 발생했습니다.',
    code: err.code
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Smart Stay 서버 실행 중: http://localhost:${PORT}`);
  // 체크아웃 후 도어락 자동 삭제 스케줄러 시작
  const { startScheduler } = require('./scripts/scheduler');
  startScheduler();
});

module.exports = app;
