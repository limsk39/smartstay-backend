/**
 * 체크아웃 후 도어락 임시 비밀번호 자동 삭제 스케줄러
 * 사용법: app.js 에서 require('./scripts/scheduler') 로 자동 시작
 *
 * - 매 30분마다 체크아웃 시간이 지난 예약을 확인
 * - 투야 API로 임시 비밀번호 삭제
 * - 예약 상태를 checked_out 으로 업데이트
 */

const schedule = require('node-schedule');
const prisma   = require('../config/prisma');
const { deleteTempPassword } = require('../services/tuyaService');

function startScheduler() {
  console.log('[스케줄러] 도어락 자동 삭제 스케줄러 시작');

  // 매 30분마다 실행 (예: 0분, 30분)
  schedule.scheduleJob('*/30 * * * *', async () => {
    console.log('[스케줄러] 체크아웃 만료 비밀번호 정리 중...');

    try {
      const now = new Date();

      // 체크아웃 시간이 지난 유료 예약 조회
      const expiredReservations = await prisma.reservation.findMany({
        where: {
          status:   { in: ['paid', 'checked_in'] },
          checkOut: { lte: now },
          doorCode: { not: null }
        },
        include: { room: true }
      });

      if (expiredReservations.length === 0) {
        console.log('[스케줄러] 정리할 예약 없음');
        return;
      }

      console.log(`[스케줄러] ${expiredReservations.length}건 정리 중...`);

      for (const reservation of expiredReservations) {
        try {
          // 투야 임시 비밀번호 삭제
          if (reservation.room?.tuyaDeviceId) {
            await deleteTempPassword(
              reservation.room.tuyaDeviceId,
              reservation.doorPasswordId  // DB에 저장된 비밀번호 ID
            );
          }

          // 예약 상태 업데이트
          await prisma.reservation.update({
            where: { id: reservation.id },
            data: {
              status:   'checked_out',
              doorCode: null  // 비밀번호 숨김 처리
            }
          });

          console.log(`[스케줄러] ✅ 완료: ${reservation.id} (${reservation.guestName})`);
        } catch (err) {
          console.error(`[스케줄러] ❌ 실패: ${reservation.id}`, err.message);
        }
      }
    } catch (err) {
      console.error('[스케줄러] 오류:', err.message);
    }
  });
}

module.exports = { startScheduler };
