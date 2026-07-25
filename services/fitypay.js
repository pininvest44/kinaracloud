import fetch from 'node-fetch';

/**
 * Trigger individual STK push request
 */
export async function sendStkPush({ phone, amount, webhookUrl, service, description }) {
  const url = process.env.FITYPAY_BASE_URL;

  const payload = {
    phone,
    amount: Number(amount),
    ...(webhookUrl && { webhook_url: webhookUrl }),
    ...(service && { service }),
    ...(description && { description }),
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.FITYPAY_MANAGEMENT_TOKEN}`,
      'X-Product-Token': process.env.FITYPAY_PRODUCT_TOKEN,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || `HTTP ${response.status}: Failed to trigger STK Push`);
  }

  return data;
}
