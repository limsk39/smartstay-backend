const axios = require('axios');
require('dotenv').config();

const TOSS_BASE_URL = 'https://api.tosspayments.com/v1';
const secretKey = process.env.TOSS_SECRET_KEY;

function getAuthHeader() {
  const encoded = Buffer.from(secretKey + ':').toString('base64');
  return `Basic ${encoded}`;
}

// 결제 승인
async function confirmPayment(paymentKey, orderId, amount) {
  try {
    const response = await axios.post(
      `${TOSS_BASE_URL}/payments/confirm`,
      { paymentKey, orderId, amount },
      {
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    throw new Error(errData?.message || '결제 승인 실패');
  }
}

// 결제 취소
async function cancelPayment(paymentKey, cancelReason, cancelAmount = null) {
  try {
    const body = { cancelReason };
    if (cancelAmount) body.cancelAmount = cancelAmount;

    const response = await axios.post(
      `${TOSS_BASE_URL}/payments/${paymentKey}/cancel`,
      body,
      {
        headers: {
          Authorization: getAuthHeader(),
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    const errData = error.response?.data;
    throw new Error(errData?.message || '결제 취소 실패');
  }
}

// 결제 조회
async function getPayment(paymentKey) {
  try {
    const response = await axios.get(
      `${TOSS_BASE_URL}/payments/${paymentKey}`,
      {
        headers: {
          Authorization: getAuthHeader()
        }
      }
    );
    return response.data;
  } catch (error) {
    throw new Error('결제 조회 실패');
  }
}

module.exports = { confirmPayment, cancelPayment, getPayment };
