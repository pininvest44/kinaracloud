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
const MAX_LOGS = 500;

function addLog(type, phone, message, details = null) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    type, // 'SUCCESS', 'FAILED', 'INFO'
    phone,
    message,
    details,
  };
  logHistory.unshift(logEntry);
  if (logHistory.length > MAX_LOGS) {
    logHistory.length = MAX_LOGS; // Keep log array bounded
  }
}

/**
 * Queue Processor: 15 Requests per Minute (4,000 ms spacing)
 * Features dynamic 60-second backoff on HTTP 429 / Rate Limit responses
 */
async function processBulkPush(phoneNumbers, amount, description, webhookUrl) {
  processingQueue = true;
  addLog('INFO', 'SYSTEM', `Starting bulk execution for ${phoneNumbers.length} numbers.`);

  const BASE_DELAY_MS = 4000;     // 4 seconds (15 requests / min pace)
  const BACKOFF_DELAY_MS = 30000;  // 30-second cooldown on rate limit

  try {
    for (let i = 0; i < phoneNumbers.length; i++) {
      const phone = phoneNumbers[i].trim();

      if (!phone) continue;

      let success = false;
      let retried = false;

      while (!success) {
        try {
          addLog('INFO', phone, `[${i + 1}/${phoneNumbers.length}] Initiating STK Push...`);

          const response = await sendStkPush({
            phone,
            amount,
            description,
            webhookUrl,
          });

          addLog('SUCCESS', phone, `Push sent successfully`, response);
          success = true;
        } catch (err) {
          const errorMessage = (err.message || '').toLowerCase();
          const statusCode = err.status || err.statusCode || err.response?.status;

          // Check for HTTP 429 or rate-limit messages from FityPay / Safaricom
          const isRateLimited =
            statusCode === 429 ||
            errorMessage.includes('too many requests') ||
            errorMessage.includes('rate limit') ||
            errorMessage.includes('quota exceeded') ||
            errorMessage.includes('too many different phone numbers');

          if (isRateLimited && !retried) {
            addLog(
              'FAILED',
              phone,
              `Rate limit hit ("${err.message}"). Pausing execution for 60 seconds...`
            );

            // Pause queue for 60 seconds before retrying current number
            await new Promise((resolve) => setTimeout(resolve, BACKOFF_DELAY_MS));

            addLog('INFO', phone, `Resuming process after 60s cooldown. Retrying number...`);
            retried = true; // Retry once; if it fails again, log and move to next
          } else {
            addLog('FAILED', phone, err.message || 'STK Push failed');
            success = true; // Exit retry loop and move to next number
          }
        }
      }

      // Base rate-limiting delay between requests (except last)
      if (i < phoneNumbers.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS));
      }
    }
  } catch (fatalErr) {
    addLog('FAILED', 'SYSTEM', `Fatal queue execution error: ${fatalErr.message}`);
  } finally {
    processingQueue = false;
    addLog('INFO', 'SYSTEM', `Bulk process finished.`);
  }
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

  const ESTIMATED_SECONDS_PER_REQ = 4;
  const estimatedMinutes = Math.ceil((phoneNumbers.length * ESTIMATED_SECONDS_PER_REQ) / 60);

  // Trigger background execution without blocking API response
  processBulkPush(phoneNumbers, amount, description, webhookUrl);

  return res.status(202).json({
    message: 'Bulk STK process initiated successfully.',
    total: phoneNumbers.length,
    estimatedMinutes,
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
