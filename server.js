import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendStkPush } from './services/fitypay.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory queue state & log tracker
let processingQueue = false;
const logHistory = [];

function addLog(type, phone, message, details = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type, // 'SUCCESS', 'FAILED', 'INFO'
    phone,
    message,
    details,
  };
  logHistory.unshift(logEntry);
  if (logHistory.length > 500) logHistory.pop(); // Keep last 500 logs
}

/**
 * Queue Processor: 15 Requests per Minute
 * Rate = 1 req every 4,000 milliseconds (60s / 15 = 4s)
 */
async function processBulkPush(phoneNumbers, amount, description, webhookUrl) {
  processingQueue = true;
  addLog('INFO', 'SYSTEM', `Starting bulk execution for ${phoneNumbers.length} numbers (15 req/min pace).`);

  const DELAY_BETWEEN_REQUESTS_MS = 11000; // 11 seconds per request = 15 requests / min

  for (let i = 0; i < phoneNumbers.length; i++) {
    const phone = phoneNumbers[i].trim();

    if (!phone) continue;

    try {
      addLog('INFO', phone, `[${i + 1}/${phoneNumbers.length}] Initiating STK Push...`);

      const response = await sendStkPush({
        phone,
        amount,
        description,
        webhookUrl,
      });

      addLog('SUCCESS', phone, `Push sent successfully`, response);
    } catch (err) {
      addLog('FAILED', phone, err.message);
    }

    // Wait 4 seconds before triggering the next request (except for the last item)
    if (i < phoneNumbers.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_REQUESTS_MS));
    }
  }

  processingQueue = false;
  addLog('INFO', 'SYSTEM', `Bulk process finished.`);
}

// POST endpoint to trigger bulk push
app.post('/api/bulk-push', (req, res) => {
  if (processingQueue) {
    return res.status(429).json({
      error: 'A bulk process is currently running. Please wait for it to complete.',
    });
  }

  const { phoneNumbers, amount, description, webhookUrl } = req.body;

  if (!phoneNumbers || !Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
    return res.status(400).json({ error: 'A non-empty array of phone numbers is required.' });
  }

  if (!amount || Number(amount) <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0.' });
  }

  // Trigger background execution without blocking API response
  processBulkPush(phoneNumbers, amount, description, webhookUrl);

  return res.status(202).json({
    message: 'Bulk STK process initiated successfully.',
    total: phoneNumbers.length,
    estimatedMinutes: Math.ceil((phoneNumbers.length * 4) / 60),
  });
});

// GET endpoint for fetching log history (polled by UI)
app.get('/api/logs', (req, res) => {
  return res.json({
    isProcessing: processingQueue,
    logs: logHistory,
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
